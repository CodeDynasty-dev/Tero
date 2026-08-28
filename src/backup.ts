import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync, unlinkSync } from "fs";
import { join, basename, relative, dirname } from "path";
import tar from "tar";
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { CronJob } from "cron";
import { gzipSync, gunzipSync } from "zlib";
import { createHash, randomUUID } from "crypto";
import { ACIDStorageEngine, LogEntry, partitionedPath, walkPartitions } from "./acid-engine.js";

/** LSN padded to 16 digits so lexicographic object-key sort == numeric LSN sort. */
function padLsn(lsn: number): string {
  return lsn.toString().padStart(16, '0');
}

export interface LiveBackupStatus {
  state: 'healthy' | 'degraded' | 'stopped';
  nodeId: string;
  intervalMs: number;
  lastShippedLsn: number;
  lastShipAt: number;
  secondsSinceLastShip: number;
  segmentsShipped: number;
  checkpointsTaken: number;
  errorCount: number;
  lastError?: string;
}

export interface LiveBackupOptions {
  /** The only consistency level live backup offers: RPO ≤ 1 second of committed writes. */
  consistency: 'per-second';
  /** Ship interval in ms. Default 1000. Minimum 250. */
  intervalMs?: number;
  /** Stable identity for this node in the bucket. Persisted to <dbPath>/.tero-node-id. */
  nodeId?: string;
}

export interface RestoreLiveResult {
  nodeId: string;
  docsRestored: number;
  segmentsReplayed: number;
  baseLsn: number | null;
  lastLsn: number;
}

export interface CloudStorageConfig {
  provider: 'aws-s3' | 'cloudflare-r2';
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint?: string; // For R2 or custom S3-compatible services
  pathPrefix?: string; // Optional path prefix in bucket
}

export interface BackupConfig {
  interval?: string; // '1h', '6h', '1d', '7d'
  retention?: string; // '7d', '30d', '90d', '1y'
  format: 'individual' | 'archive'; // Individual JSON files or single tar.gz
  cloudStorage?: CloudStorageConfig;
  localPath?: string; // Local backup directory
  compression?: boolean; // For individual files
  includeMetadata?: boolean; // Include file timestamps, sizes, etc. (optional - adds overhead)
  metadataUse?: 'verification' | 'audit' | 'recovery' | 'none'; // What to use metadata for
}

export interface BackupMetadata {
  timestamp: string;
  format: 'individual' | 'archive';
  fileCount: number;
  totalSize: number;
  checksum: string;
  retention: string;
}

export interface BucketBackupResult {
  success: boolean;
  uploadedDataFiles: number;
  uploadedWALSegments: number;
  duration: number;
  errors: string[];
}

export class BackupManager {
  private s3Client?: S3Client;
  private scheduledBackups: Map<string, CronJob> = new Map();
  private config: BackupConfig;
  private dbPath: string;

  constructor(dbPath: string, config: BackupConfig) {
    this.dbPath = dbPath;
    this.config = config;

    if (config.cloudStorage) {
      this.initializeCloudStorage(config.cloudStorage);
    }
  }

  private initializeCloudStorage(cloudConfig: CloudStorageConfig): void {
    try {
      const clientConfig: any = {
        region: cloudConfig.region,
        credentials: {
          accessKeyId: cloudConfig.accessKeyId,
          secretAccessKey: cloudConfig.secretAccessKey,
        },
      };

      // Configure for Cloudflare R2 or custom endpoints
      if (cloudConfig.endpoint) {
        clientConfig.endpoint = cloudConfig.endpoint;
        clientConfig.forcePathStyle = true; // Required for R2
      }

      this.s3Client = new S3Client(clientConfig);
    } catch (error) {
      throw new Error(`Failed to initialize cloud storage: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private parseInterval(interval: string): number {
    const match = interval.match(/^(\d+)([hdw])$/);
    if (!match) throw new Error(`Invalid interval format: ${interval}`);

    const [, num, unit] = match;
    const value = parseInt(num);

    switch (unit) {
      case 'h': return value * 60 * 60 * 1000; // hours to ms
      case 'd': return value * 24 * 60 * 60 * 1000; // days to ms
      case 'w': return value * 7 * 24 * 60 * 60 * 1000; // weeks to ms
      default: throw new Error(`Unsupported time unit: ${unit}`);
    }
  }

  private parseRetention(retention: string): number {
    const match = retention.match(/^(\d+)([dwy])$/);
    if (!match) throw new Error(`Invalid retention format: ${retention}`);

    const [, num, unit] = match;
    const value = parseInt(num);

    switch (unit) {
      case 'd': return value * 24 * 60 * 60 * 1000; // days to ms
      case 'w': return value * 7 * 24 * 60 * 60 * 1000; // weeks to ms
      case 'y': return value * 365 * 24 * 60 * 60 * 1000; // years to ms
      default: throw new Error(`Unsupported retention unit: ${unit}`);
    }
  }

  private intervalToCron(interval: string): string {
    const match = interval.match(/^(\d+)([hdw])$/);
    if (!match) throw new Error(`Invalid interval format: ${interval}`);

    const [, num, unit] = match;
    const value = parseInt(num);

    switch (unit) {
      case 'h': // Every N hours
        if (value === 1) return '0 * * * *'; // Every hour
        if (value === 6) return '0 */6 * * *'; // Every 6 hours
        if (value === 12) return '0 */12 * * *'; // Every 12 hours
        if (24 % value === 0) return `0 */${value} * * *`; // Every N hours if divisible
        throw new Error(`Unsupported hour interval: ${value}h`);

      case 'd': // Every N days
        if (value === 1) return '0 0 * * *'; // Daily at midnight
        if (value === 7) return '0 0 * * 0'; // Weekly on Sunday
        return `0 0 */${value} * *`; // Every N days

      case 'w': // Every N weeks
        if (value === 1) return '0 0 * * 0'; // Weekly on Sunday
        if (value === 2) return '0 0 * * 0/2'; // Bi-weekly
        throw new Error(`Unsupported week interval: ${value}w`);

      default:
        throw new Error(`Unsupported time unit: ${unit}`);
    }
  }

  private async calculateChecksum(filePath: string): Promise<string> {
    const crypto = await import('crypto');
    const hash = crypto.createHash('sha256');
    const stream = createReadStream(filePath);

    return new Promise((resolve, reject) => {
      stream.on('data', (data) => hash.update(data));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  /**
   * Enumerate *.json files across the 2-level hash-prefix partition tree using
   * async fs.opendir iteration. Replaces the previous readdirSync() flat scan
   * that allocated a giant array of all filenames in one tick — at 1M keys the
   * old call alone consumed ~80MB and froze the event loop for seconds.
   *
   * Streaming walks each leaf directory one entry at a time.
   */
  private async getJsonFiles(): Promise<Array<{ path: string; name: string; size: number; mtime: Date }>> {
    try {
      if (!existsSync(this.dbPath)) {
        return [];
      }

      const { walkPartitions } = await import('./acid-engine.js');
      const { basename } = await import('path');
      const files: Array<{ path: string; name: string; size: number; mtime: Date }> = [];

      await walkPartitions(this.dbPath, async (filePath) => {
        try {
          const stats = statSync(filePath);
          files.push({
            path: filePath,
            name: basename(filePath),
            size: stats.size,
            mtime: stats.mtime
          });
        } catch {
          // file may be removed mid-walk — skip
        }
      });

      return files;
    } catch (error) {
      throw new Error(`Failed to get JSON files: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async createArchiveBackup(): Promise<{ filePath: string; metadata: BackupMetadata }> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFileName = `tero-backup-${timestamp}.tar.gz`;
    const backupPath = this.config.localPath
      ? join(this.config.localPath, backupFileName)
      : join(this.dbPath, backupFileName);

    try {
      const jsonFiles = await this.getJsonFiles();

      if (jsonFiles.length === 0) {
        throw new Error('No JSON files found to backup');
      }

      // Ensure backup directory exists
      if (this.config.localPath) {
        const fs = await import('fs/promises');
        await fs.mkdir(this.config.localPath, { recursive: true });
      }

      // Create tar.gz archive — pass relative paths from dbPath so the
      // 2-level hash-prefix partition dirs are preserved in the archive.
      // (was: jsonFiles.map(f => f.name) — broke when files moved to XX/YY/key.json)
      const fileList = jsonFiles.map(f => f.path.slice(this.dbPath.length + 1));
      await tar.create(
        {
          file: backupPath,
          cwd: this.dbPath,
          gzip: true,
          prefix: 'tero-data/'
        },
        fileList
      );

      const stats = statSync(backupPath);
      const checksum = await this.calculateChecksum(backupPath);

      const metadata: BackupMetadata = {
        timestamp: new Date().toISOString(),
        format: 'archive',
        fileCount: jsonFiles.length,
        totalSize: stats.size,
        checksum,
        retention: this.config.retention || '30d'
      };

      return { filePath: backupPath, metadata };
    } catch (error) {
      throw new Error(`Failed to create archive backup: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }


  private async createIndividualBackup(): Promise<{ files: string[]; metadata: BackupMetadata }> {
    // Use key-based backup instead of timestamp-based directories
    const backupDir = this.config.localPath || join(this.dbPath, '.backup');

    try {
      const jsonFiles = await this.getJsonFiles();

      if (jsonFiles.length === 0) {
        throw new Error('No JSON files found to backup');
      }

      // Create backup directory
      const fs = await import('fs/promises');
      await fs.mkdir(backupDir, { recursive: true });

      const backedUpFiles: string[] = [];
      let totalSize = 0;

      // Copy each JSON file using its key as the filename (no timestamp directories)
      for (const file of jsonFiles) {
        const destPath = join(backupDir, file.name);
        await fs.copyFile(file.path, destPath);
        backedUpFiles.push(destPath);
        totalSize += file.size;

        // Add metadata file only if specifically requested and useful
        if (this.config.includeMetadata && this.config.metadataUse !== 'none') {
          const metadataPath = join(backupDir, `${file.name}.meta`);

          // Only include metadata that's actually useful
          const fileMetadata: any = {
            backupTime: new Date().toISOString(),
            originalSize: file.size,
            lastModified: file.mtime.toISOString()
          };

          // Add specific metadata based on intended use
          switch (this.config.metadataUse) {
            case 'verification':
              // Add checksum for integrity verification
              const crypto = await import('crypto');
              const hash = crypto.createHash('sha256');
              const fileContent = await fs.readFile(file.path);
              hash.update(fileContent);
              fileMetadata.checksum = hash.digest('hex');
              break;

            case 'audit':
              // Add audit trail information
              fileMetadata.originalPath = file.path;
              fileMetadata.backupVersion = '1.4.0';
              break;

            case 'recovery':
              // Add recovery-specific information
              fileMetadata.recoveryPriority = file.name.includes('user') ? 'high' : 'normal';
              break;
          }

          await fs.writeFile(metadataPath, JSON.stringify(fileMetadata, null, 2));
          backedUpFiles.push(metadataPath);
        }
      }

      const metadata: BackupMetadata = {
        timestamp: new Date().toISOString(),
        format: 'individual',
        fileCount: jsonFiles.length,
        totalSize,
        checksum: '', // Individual files don't have a single checksum
        retention: this.config.retention || '30d'
      };

      // Save backup metadata
      const metadataPath = join(backupDir, 'backup-metadata.json');
      await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2));
      backedUpFiles.push(metadataPath);

      return { files: backedUpFiles, metadata };
    } catch (error) {
      throw new Error(`Failed to create individual backup: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async uploadToCloud(localPath: string, cloudKey: string): Promise<void> {
    if (!this.s3Client || !this.config.cloudStorage) {
      throw new Error('Cloud storage not configured');
    }

    try {
      const fileStream = createReadStream(localPath);
      const stats = statSync(localPath);

      const upload = new Upload({
        client: this.s3Client,
        params: {
          Bucket: this.config.cloudStorage.bucket,
          Key: cloudKey,
          Body: fileStream,
          ContentLength: stats.size,
          Metadata: {
            'backup-timestamp': new Date().toISOString(),
            'source-db': basename(this.dbPath),
            'backup-format': this.config.format
          }
        }
      });

      await upload.done();
    } catch (error) {
      throw new Error(`Failed to upload to cloud storage: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async uploadDirectoryToCloud(localDir: string, cloudPrefix: string): Promise<void> {
    if (!this.s3Client || !this.config.cloudStorage) {
      throw new Error('Cloud storage not configured');
    }

    try {
      const fs = await import('fs/promises');
      const files = await fs.readdir(localDir);

      const uploadPromises = files.map(async (file) => {
        const localFilePath = join(localDir, file);
        const cloudKey = `${cloudPrefix}/${file}`;
        await this.uploadToCloud(localFilePath, cloudKey);
      });

      await Promise.all(uploadPromises);
    } catch (error) {
      throw new Error(`Failed to upload directory to cloud: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async uploadIndividualFilesToCloud(localDir: string): Promise<void> {
    if (!this.s3Client || !this.config.cloudStorage) {
      throw new Error('Cloud storage not configured');
    }

    try {
      const fs = await import('fs/promises');
      const files = await fs.readdir(localDir);

      const uploadPromises = files
        .filter(file => file.endsWith('.json')) // Only upload JSON files, skip metadata
        .map(async (file) => {
          const localFilePath = join(localDir, file);
          // Use direct key-based cloud storage: each JSON file is stored with its key as the cloud key
          const cloudKey = this.getCloudKey(file);
          await this.uploadToCloud(localFilePath, cloudKey);
        });

      await Promise.all(uploadPromises);
    } catch (error) {
      throw new Error(`Failed to upload individual files to cloud: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private getCloudKey(filename: string): string {
    const prefix = this.config.cloudStorage?.pathPrefix || 'tero-backups';
    const dbName = basename(this.dbPath);
    return `${prefix}/${dbName}/${filename}`;
  }

  async performBackup(): Promise<{ success: boolean; metadata: BackupMetadata; cloudUploaded?: boolean }> {
    try {
      console.log(`🔄 Starting ${this.config.format} backup for ${this.dbPath}...`);

      let metadata: BackupMetadata;
      let cloudUploaded = false;

      if (this.config.format === 'archive') {
        const { filePath, metadata: backupMetadata } = await this.createArchiveBackup();
        metadata = backupMetadata;

        // Upload to cloud if configured
        if (this.config.cloudStorage && this.s3Client) {
          const cloudKey = this.getCloudKey(basename(filePath));
          await this.uploadToCloud(filePath, cloudKey);
          cloudUploaded = true;
          console.log(`☁️ Uploaded archive backup to cloud: ${cloudKey}`);
        }

        console.log(`✅ Archive backup completed: ${filePath}`);
      } else {
        const { files, metadata: backupMetadata } = await this.createIndividualBackup();
        metadata = backupMetadata;

        // Upload to cloud if configured - use key-based storage for direct recovery
        if (this.config.cloudStorage && this.s3Client) {
          await this.uploadIndividualFilesToCloud(files[0].split('/').slice(0, -1).join('/'));
          cloudUploaded = true;
          console.log(`☁️ Uploaded individual backup to cloud using key-based storage`);
        }

        console.log(`✅ Individual backup completed: ${files.length} files`);
      }

      // Clean up old backups based on retention policy
      if (this.config.retention) {
        await this.cleanupOldBackups();
      }

      return { success: true, metadata, cloudUploaded };
    } catch (error) {
      console.error(`❌ Backup failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      return {
        success: false,
        metadata: {
          timestamp: new Date().toISOString(),
          format: this.config.format,
          fileCount: 0,
          totalSize: 0,
          checksum: '',
          retention: this.config.retention || '30d'
        }
      };
    }
  }

  private async cleanupOldBackups(): Promise<void> {
    if (!this.config.retention || !this.config.cloudStorage || !this.s3Client) {
      return;
    }

    try {
      const retentionMs = this.parseRetention(this.config.retention);
      const cutoffDate = new Date(Date.now() - retentionMs);

      const prefix = this.getCloudKey('');
      const listCommand = new ListObjectsV2Command({
        Bucket: this.config.cloudStorage.bucket,
        Prefix: prefix
      });

      const response = await this.s3Client.send(listCommand);

      if (response.Contents) {
        const oldObjects = response.Contents.filter((obj: any) =>
          obj.LastModified && obj.LastModified < cutoffDate
        );

        const deletePromises = oldObjects.map((obj: any) => {
          if (obj.Key) {
            return this.s3Client!.send(new DeleteObjectCommand({
              Bucket: this.config.cloudStorage!.bucket,
              Key: obj.Key
            }));
          }
          return null;
        }).filter(Boolean);

        await Promise.all(deletePromises);

        if (oldObjects.length > 0) {
          console.log(`🗑️ Cleaned up ${oldObjects.length} old backup(s) from cloud storage`);
        }
      }
    } catch (error) {
      console.warn(`⚠️ Failed to cleanup old backups: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  scheduleBackup(config: { interval: string; retention?: string }): string {
    const scheduleId = `backup-${Date.now()}`;

    try {
      // Convert interval to cron expression
      const cronExpression = this.intervalToCron(config.interval);

      // Update config with new retention if provided
      if (config.retention) {
        this.config.retention = config.retention;
      }

      const performScheduledBackup = async () => {
        console.log(`⏰ Scheduled backup triggered (${config.interval} interval)`);
        await this.performBackup();
      };

      // Create cron job for recurring backups
      const cronJob = new CronJob(
        cronExpression,
        performScheduledBackup,
        null, // onComplete
        true, // start immediately
        'UTC' // timezone
      );

      this.scheduledBackups.set(scheduleId, cronJob);

      console.log(`📅 Backup scheduled with cron: ${cronExpression} (${config.interval} interval), ${config.retention || this.config.retention} retention`);
      return scheduleId;
    } catch (error) {
      throw new Error(`Failed to schedule backup: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  cancelScheduledBackup(scheduleId: string): boolean {
    const cronJob = this.scheduledBackups.get(scheduleId);
    if (cronJob) {
      cronJob.stop();
      this.scheduledBackups.delete(scheduleId);
      console.log(`❌ Cancelled scheduled backup: ${scheduleId}`);
      return true;
    }
    return false;
  }

  getScheduledBackups(): Array<{ id: string; active: boolean }> {
    return Array.from(this.scheduledBackups.keys()).map(id => ({
      id,
      active: true
    }));
  }

  async testCloudConnection(): Promise<{ success: boolean; message: string }> {
    if (!this.s3Client || !this.config.cloudStorage) {
      return { success: false, message: 'Cloud storage not configured' };
    }

    try {
      // Test by listing objects in the bucket
      const listCommand = new ListObjectsV2Command({
        Bucket: this.config.cloudStorage.bucket,
        MaxKeys: 1
      });

      await this.s3Client.send(listCommand);
      return { success: true, message: 'Cloud storage connection successful' };
    } catch (error) {
      return {
        success: false,
        message: `Cloud storage connection failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    }
  }

  /**
   * v2: One-shot bucket backup of all data JSON files + any WAL archive segments
   * the caller passes in. Designed for scheduled "snapshot to bucket" runs that a
   * client triggers with its OWN bucket credentials — the control plane never holds
   * the client's cloud keys, it only observes results via heartbeats.
   *
   * Returns a structured result with per-stream counts and surfaced errors.
   */
  async backupToBucket(options?: {
    walArchivePaths?: string[];
    tag?: string;
  }): Promise<BucketBackupResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    let uploadedDataFiles = 0;
    let uploadedWALSegments = 0;

    if (!this.s3Client || !this.config.cloudStorage) {
      errors.push('Cloud storage not configured');
      return {
        success: false,
        uploadedDataFiles: 0,
        uploadedWALSegments: 0,
        duration: Date.now() - startTime,
        errors,
      };
    }

    try {
      // 1) Snapshot all data JSON files to bucket.
      const jsonFiles = await this.getJsonFiles();
      for (const file of jsonFiles) {
        try {
          const cloudKey = this.getCloudKey(file.name);
          await this.uploadToCloud(file.path, cloudKey);
          uploadedDataFiles++;
        } catch (error) {
          errors.push(`data:${file.name}:${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }

      // 2) Stream WAL archive segments the caller wants persisted.
      const walPaths = options?.walArchivePaths ?? [];
      for (const archivePath of walPaths) {
        if (!existsSync(archivePath)) continue;
        try {
          const segName = basename(archivePath);
          const prefix = this.config.cloudStorage.pathPrefix || 'tero-backups';
          const dbName = basename(this.dbPath);
          const cloudKey = `${prefix}/${dbName}/wal/${segName}`;
          await this.uploadToCloud(archivePath, cloudKey);
          uploadedWALSegments++;
        } catch (error) {
          errors.push(`wal:${basename(archivePath)}:${error instanceof Error ? error.message : 'Unknown error'}`);
        }
      }

      // 3) Emit a backup manifest so hydrate-on-startup can discover the latest snapshot.
      try {
        const manifest = {
          timestamp: new Date().toISOString(),
          tag: options?.tag ?? 'manual',
          dataFiles: jsonFiles.map(f => f.name),
          walSegments: walPaths.map(p => basename(p)),
          dbPath: basename(this.dbPath),
        };
        const manifestKey = `${this.config.cloudStorage.pathPrefix || 'tero-backups'}/${basename(this.dbPath)}/MANIFEST.json`;
        await this.uploadBuffer(
          JSON.stringify(manifest, null, 2),
          manifestKey,
          'application/json'
        );
      } catch (error) {
        errors.push(`manifest:${error instanceof Error ? error.message : 'Unknown error'}`);
      }

      return {
        success: errors.length === 0,
        uploadedDataFiles,
        uploadedWALSegments,
        duration: Date.now() - startTime,
        errors,
      };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'Unknown error');
      return {
        success: false,
        uploadedDataFiles,
        uploadedWALSegments,
        duration: Date.now() - startTime,
        errors,
      };
    }
  }

  /**
   * Upload an arbitrary buffer (used for the bucket manifest and small artifacts).
   */
  private async uploadBuffer(content: string, cloudKey: string, contentType: string): Promise<void> {
    if (!this.s3Client || !this.config.cloudStorage) {
      throw new Error('Cloud storage not configured');
    }
    const cmd = new PutObjectCommand({
      Bucket: this.config.cloudStorage.bucket,
      Key: cloudKey,
      Body: content,
      ContentType: contentType,
      Metadata: {
        'backup-timestamp': new Date().toISOString(),
        'source-db': basename(this.dbPath),
      },
    });
    await this.s3Client.send(cmd);
  }

  // ===== Live backup (per-second WAL shipping) — fields =====
  private liveShipper?: WalShipper;
  private liveNodeId?: string;
  private liveEngine?: ACIDStorageEngine;
  private livePrefix?: string;
  private liveCheckpoints = 0;

  destroy(): void {
    for (const [id, cronJob] of this.scheduledBackups) cronJob.stop();
    this.scheduledBackups.clear();
    if (this.liveShipper) this.liveShipper.stop();
    console.log('🛑 BackupManager destroyed, all scheduled backups cancelled');
  }

  private liveCloudPrefix(nodeId: string): string {
    const base = this.config.cloudStorage?.pathPrefix || 'tero-backups';
    return `${base}/${basename(this.dbPath)}/nodes/${nodeId}/`;
  }

  private async uploadBytes(key: string, body: Buffer, contentType = 'application/octet-stream'): Promise<void> {
    if (!this.s3Client || !this.config.cloudStorage) throw new Error('Cloud storage not configured');
    await this.s3Client.send(new PutObjectCommand({
      Bucket: this.config.cloudStorage.bucket, Key: key, Body: body, ContentType: contentType,
      Metadata: { 'backup-timestamp': new Date().toISOString(), 'source-db': basename(this.dbPath) },
    }));
  }

  private async downloadBytes(key: string): Promise<Buffer> {
    if (!this.s3Client || !this.config.cloudStorage) throw new Error('Cloud storage not configured');
    const resp = await this.s3Client.send(new GetObjectCommand({ Bucket: this.config.cloudStorage.bucket, Key: key }));
    if (!resp.Body) throw new Error(`Empty body for ${key}`);
    const chunks: Buffer[] = [];
    for await (const c of resp.Body as any) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
    return Buffer.concat(chunks);
  }

  private async readJsonOrDefault<T>(key: string): Promise<T | null> {
    try { return JSON.parse((await this.downloadBytes(key)).toString('utf8')) as T; }
    catch (e) { if (e instanceof Error && (e.name === 'NoSuchKey' || /NoSuchKey|404|not found|does not exist/i.test(e.message))) return null; throw e; }
  }

  private async listPrefix(prefix: string): Promise<string[]> {
    if (!this.s3Client || !this.config.cloudStorage) throw new Error('Cloud storage not configured');
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const resp = await this.s3Client.send(new ListObjectsV2Command({ Bucket: this.config.cloudStorage.bucket, Prefix: prefix, ContinuationToken: token }));
      if (resp.Contents) for (const o of resp.Contents) if (o.Key) keys.push(o.Key);
      token = resp.IsTruncated ? resp.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }

  enableLiveBackup(engine: ACIDStorageEngine, opts: LiveBackupOptions): void {
    if (opts.consistency !== 'per-second') throw new Error("Tero live backup only supports consistency: 'per-second' (RPO ≤ 1s). Other levels are not offered.");
    if (this.liveShipper) return;
    if (!this.s3Client || !this.config.cloudStorage) throw new Error('Cloud storage not configured — call configureBackup() with cloudStorage first.');
    const intervalMs = Math.max(250, opts.intervalMs ?? 1000);
    let nodeId = opts.nodeId;
    const idFile = join(this.dbPath, '.tero-node-id');
    if (!nodeId) { try { nodeId = readFileSync(idFile, 'utf8').trim(); } catch { nodeId = randomUUID().replace(/-/g, '').slice(0, 16); } }
    try { writeFileSync(idFile, nodeId, 'utf8'); } catch {}
    const prefix = this.liveCloudPrefix(nodeId);
    this.liveNodeId = nodeId; this.liveEngine = engine; this.livePrefix = prefix;
    this.liveShipper = new WalShipper({ wal: engine.getWAL(), upload: (k, b) => this.uploadBytes(k, b, 'application/gzip'), prefix, intervalMs });
    this.liveShipper.start();
    console.log(`🚀 Tero live backup enabled: nodeId=${nodeId} intervalMs=${intervalMs} RPO≤1s`);
  }

  disableLiveBackup(): void {
    if (!this.liveShipper) return;
    this.liveShipper.stop(); this.liveShipper = undefined;
    console.log('🛑 Tero live backup disabled');
  }

  getLiveBackupStatus(): LiveBackupStatus {
    const s = this.liveShipper?.status;
    return {
      state: s?.state ?? 'stopped', nodeId: this.liveNodeId ?? 'unknown', intervalMs: this.liveShipper?.intervalMs ?? 0,
      lastShippedLsn: s?.lastShippedLsn ?? 0, lastShipAt: s?.lastShipAt ?? 0,
      secondsSinceLastShip: s?.lastShipAt ? Math.round((Date.now() - s.lastShipAt) / 1000) : 0,
      segmentsShipped: s?.segmentsShipped ?? 0, checkpointsTaken: this.liveCheckpoints,
      errorCount: s?.errorCount ?? 0, lastError: s?.lastError,
    };
  }

  // __TERO_LIVE_PART2__

  async liveCheckpointToBucket(_opts?: { tag?: string }): Promise<{ uploadedDocs: number; fullUpload: boolean; duration: number }> {
    if (!this.liveEngine || !this.liveNodeId || !this.livePrefix) throw new Error('Live backup not enabled — call enableLiveBackup() first.');
    const start = Date.now();
    const ckptPrefix = `${this.livePrefix}checkpoint/`;
    const latestKey = `${ckptPrefix}latest.json`;
    const latest = await this.readJsonOrDefault<{ baseTs: string; baseLsn: number }>(latestKey);
    const wal = this.liveEngine.getWAL();
    const dirty = this.liveEngine.takeDirtyKeys();
    if (!latest) {
      const baseTs = new Date().toISOString().replace(/[:.]/g, '-');
      const dataPrefix = `${ckptPrefix}${baseTs}/data/`;
      let count = 0;
      await walkPartitions(this.dbPath, async (filePath) => {
        await this.uploadBytes(`${dataPrefix}${relative(this.dbPath, filePath)}`, readFileSync(filePath), 'application/json');
        count++;
      });
      await this.uploadBytes(`${ckptPrefix}${baseTs}/index.json`, Buffer.from(JSON.stringify({ baseTs, baseLsn: wal.getCurrentLSN(), createdAt: new Date().toISOString(), docCount: count }, null, 2)), 'application/json');
      await this.uploadBytes(latestKey, Buffer.from(JSON.stringify({ baseTs, baseLsn: wal.getCurrentLSN(), updatedAt: new Date().toISOString() }, null, 2)), 'application/json');
      this.liveCheckpoints++;
      return { uploadedDocs: count, fullUpload: true, duration: Date.now() - start };
    }
    const dataPrefix = `${ckptPrefix}${latest.baseTs}/data/`;
    let uploaded = 0;
    for (const key of dirty) {
      const filePath = partitionedPath(this.dbPath, key);
      if (existsSync(filePath)) { await this.uploadBytes(`${dataPrefix}${relative(this.dbPath, filePath)}`, readFileSync(filePath), 'application/json'); uploaded++; }
    }
    await this.uploadBytes(latestKey, Buffer.from(JSON.stringify({ baseTs: latest.baseTs, baseLsn: wal.getCurrentLSN(), updatedAt: new Date().toISOString(), dirtyUploaded: uploaded }, null, 2)), 'application/json');
    await this.uploadBytes(`${this.livePrefix}MANIFEST.json`, Buffer.from(JSON.stringify({ nodeId: this.liveNodeId, updatedAt: new Date().toISOString(), lastShippedLsn: this.liveShipper?.status.lastShippedLsn ?? 0, lastCheckpointAt: new Date().toISOString() }, null, 2)), 'application/json');
    this.liveCheckpoints++;
    return { uploadedDocs: uploaded, fullUpload: false, duration: Date.now() - start };
  }

  // __TERO_LIVE_PART3__

  async restoreLiveToDirectory(targetDir: string, opts: { nodeId?: string; pointInTime?: number } = {}): Promise<RestoreLiveResult> {
    if (!this.s3Client || !this.config.cloudStorage) throw new Error('Cloud storage not configured');
    mkdirSync(targetDir, { recursive: true });
    const pit = opts.pointInTime ?? Infinity;
    let nodeId = opts.nodeId;
    if (!nodeId) {
      const base = this.config.cloudStorage?.pathPrefix || 'tero-backups';
      const all = await this.listPrefix(`${base}/${basename(this.dbPath)}/nodes/`);
      const ids = new Set<string>();
      for (const k of all) { const m = k.match(/\/nodes\/([^/]+)\//); if (m) ids.add(m[1]); }
      if (ids.size === 0) throw new Error('No live-backup nodes found in bucket.');
      if (ids.size > 1) throw new Error(`Multiple nodes found: ${[...ids].join(', ')}. Specify nodeId.`);
      nodeId = [...ids][0];
    }
    const prefix = this.liveCloudPrefix(nodeId);
    const latest = await this.readJsonOrDefault<{ baseTs: string; baseLsn: number }>(`${prefix}checkpoint/latest.json`);
    let docsRestored = 0;
    let baseLsn: number | null = null;
    if (latest) {
      baseLsn = latest.baseLsn ?? null;
      const dataKeys = await this.listPrefix(`${prefix}checkpoint/${latest.baseTs}/data/`);
      for (const dk of dataKeys) {
        if (dk.endsWith('.deleted')) continue;
        const body = await this.downloadBytes(dk);
        const key = basename(dk).replace(/\.json$/, '');
        const dest = partitionedPath(targetDir, key);
        mkdirSync(dirname(dest), { recursive: true });
        const tmp = `${dest}.tmp.${process.pid}`;
        writeFileSync(tmp, body); renameSync(tmp, dest);
        docsRestored++;
      }
    }
    const walKeys = (await this.listPrefix(`${prefix}wal/`))
      .filter(k => { const m = k.match(/seg-(\d+)-(\d+)\.json\.gz$/); return m ? parseInt(m[2]) > (baseLsn ?? 0) : false; }).sort();
    let segmentsReplayed = 0, lastLsn = baseLsn ?? 0;
    const pending = new Map<string, LogEntry[]>();
    const apply = (e: LogEntry) => {
      if (!e.key) return;
      const dest = partitionedPath(targetDir, e.key);
      if (e.operation === 'WRITE') {
        mkdirSync(dirname(dest), { recursive: true });
        const tmp = `${dest}.tmp.${process.pid}`;
        writeFileSync(tmp, JSON.stringify(e.afterImage ?? null)); renameSync(tmp, dest);
      } else if (e.operation === 'DELETE') { try { unlinkSync(dest); } catch {} }
      lastLsn = Math.max(lastLsn, e.lsn);
    };
    for (const wk of walKeys) {
      try {
        const entries: LogEntry[] = JSON.parse(gunzipSync(await this.downloadBytes(wk)).toString('utf8'));
        for (const e of entries) {
          if (e.timestamp > pit) continue;
          if (e.lsn <= (baseLsn ?? 0)) continue; // already captured in checkpoint
          if (e.operation === 'WRITE' || e.operation === 'DELETE') {
            if (!e.transactionId) { apply(e); continue; }
            if (!pending.has(e.transactionId)) pending.set(e.transactionId, []);
            pending.get(e.transactionId)!.push(e);
          } else if (e.operation === 'COMMIT') {
            for (const w of pending.get(e.transactionId) ?? []) apply(w);
            pending.delete(e.transactionId);
          } else if (e.operation === 'ROLLBACK') { pending.delete(e.transactionId); }
        }
        segmentsReplayed++;
      } catch (e) { console.warn(`⚠️  Skipping corrupt WAL segment ${wk}: ${e instanceof Error ? e.message : e}`); }
    }
    return { nodeId, docsRestored, segmentsReplayed, baseLsn, lastLsn };
  }
}

interface ShipperStatus {
  state: 'stopped' | 'healthy' | 'degraded';
  lastShippedLsn: number;
  lastShipAt: number;
  segmentsShipped: number;
  totalBytesShipped: number;
  errorCount: number;
  lastError?: string;
}

interface WalShipperDeps {
  wal: { getLogEntries(fromLSN?: number): LogEntry[]; getCurrentLSN(): number; listArchives(): string[] };
  upload: (key: string, body: Buffer) => Promise<void>;
  prefix: string;
  intervalMs: number;
}

/**
 * Per-second WAL shipper. Reads new WRITE/DELETE entries from the WAL (current log
 * + any rotated archives) since the last shipped LSN, gzips them, and PUTs one
 * segment per active second-with-writes. Idle seconds produce zero PUTs.
 * In-flight guard: overlapping ticks are skipped. Status flips to 'degraded' on
 * any upload failure and auto-recovers on the next successful tick.
 */
class WalShipper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private shipping = false;
  private lastLsn = 0;
  private initialized = false;
  private shippedArchives = new Set<string>();
  readonly status: ShipperStatus;
  readonly intervalMs: number;

  constructor(private deps: WalShipperDeps) {
    this.intervalMs = deps.intervalMs;
    this.status = { state: 'stopped', lastShippedLsn: 0, lastShipAt: 0, segmentsShipped: 0, totalBytesShipped: 0, errorCount: 0 };
  }

  start(): void {
    if (this.timer) return;
    if (!this.initialized) { this.lastLsn = this.deps.wal.getCurrentLSN(); this.initialized = true; }
    this.status.state = 'healthy';
    this.timer = setInterval(() => { void this.tick(); }, this.deps.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.status.state = 'stopped';
  }

  async tick(): Promise<void> {
    if (this.shipping) return;
    this.shipping = true;
    try {
      await this.shipArchives();
      const entries = this.deps.wal.getLogEntries(this.lastLsn).filter(e => e.operation === 'WRITE' || e.operation === 'DELETE');
      if (entries.length === 0) { this.status.state = 'healthy'; return; }
      const start = entries[0].lsn, end = entries[entries.length - 1].lsn;
      const body = gzipSync(Buffer.from(JSON.stringify(entries)), { level: 1 });
      await this.deps.upload(`${this.deps.prefix}wal/seg-${padLsn(start)}-${padLsn(end)}.json.gz`, body);
      this.lastLsn = end;
      this.status.lastShippedLsn = end; this.status.lastShipAt = Date.now();
      this.status.segmentsShipped++; this.status.totalBytesShipped += body.length;
      this.status.state = 'healthy'; this.status.lastError = undefined;
    } catch (e) {
      this.status.state = 'degraded'; this.status.errorCount++;
      this.status.lastError = e instanceof Error ? e.message : String(e);
    } finally {
      this.shipping = false;
    }
  }

  private async shipArchives(): Promise<void> {
    const archives = this.deps.wal.listArchives();
    for (const p of archives) {
      if (this.shippedArchives.has(p)) continue;
      try {
        const lines = readFileSync(p, 'utf8').trim().split('\n');
        const entries: LogEntry[] = [];
        for (const line of lines) { try { entries.push(JSON.parse(line)); } catch {} }
        const fresh = entries.filter(e => (e.operation === 'WRITE' || e.operation === 'DELETE') && e.lsn > this.lastLsn);
        if (fresh.length > 0) {
          const s = fresh[0].lsn, en = fresh[fresh.length - 1].lsn;
          const body = gzipSync(Buffer.from(JSON.stringify(fresh)), { level: 1 });
          await this.deps.upload(`${this.deps.prefix}wal/seg-${padLsn(s)}-${padLsn(en)}.json.gz`, body);
          this.lastLsn = en;
          this.status.lastShippedLsn = en; this.status.lastShipAt = Date.now();
          this.status.segmentsShipped++; this.status.totalBytesShipped += body.length;
        }
        this.shippedArchives.add(p);
      } catch (e) {
        this.status.state = 'degraded'; this.status.errorCount++;
        this.status.lastError = `archive:${e instanceof Error ? e.message : e}`;
      }
    }
  }
}