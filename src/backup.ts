import { createReadStream, createWriteStream, existsSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";
import tar from "tar";
import { S3Client, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";

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

export class BackupManager {
  private s3Client?: S3Client;
  private scheduledBackups: Map<string, NodeJS.Timeout> = new Map();
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

  private async getJsonFiles(): Promise<Array<{ path: string; name: string; size: number; mtime: Date }>> {
    try {
      if (!existsSync(this.dbPath)) {
        return [];
      }

      const files = readdirSync(this.dbPath)
        .filter(file => file.endsWith('.json'))
        .map(file => {
          const filePath = join(this.dbPath, file);
          const stats = statSync(filePath);
          return {
            path: filePath,
            name: file,
            size: stats.size,
            mtime: stats.mtime
          };
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

      // Create tar.gz archive
      await tar.create(
        {
          file: backupPath,
          cwd: this.dbPath,
          gzip: true,
          prefix: 'tero-data/'
        },
        jsonFiles.map(f => f.name)
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
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = this.config.localPath
      ? join(this.config.localPath, `tero-backup-${timestamp}`)
      : join(this.dbPath, `.backup-${timestamp}`);

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

      // Copy each JSON file
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

        // Upload to cloud if configured
        if (this.config.cloudStorage && this.s3Client) {
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
          const cloudPrefix = this.getCloudKey(`individual-${timestamp}`);
          await this.uploadDirectoryToCloud(files[0].split('/').slice(0, -1).join('/'), cloudPrefix);
          cloudUploaded = true;
          console.log(`☁️ Uploaded individual backup to cloud: ${cloudPrefix}`);
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
      const intervalMs = this.parseInterval(config.interval);

      // Update config with new retention if provided
      if (config.retention) {
        this.config.retention = config.retention;
      }

      const performScheduledBackup = async () => {
        console.log(`⏰ Scheduled backup triggered (${config.interval} interval)`);
        await this.performBackup();
      };

      // Perform initial backup
      performScheduledBackup();

      // Schedule recurring backups
      const timer = setInterval(performScheduledBackup, intervalMs);
      this.scheduledBackups.set(scheduleId, timer);

      console.log(`📅 Backup scheduled: ${config.interval} interval, ${config.retention || this.config.retention} retention`);
      return scheduleId;
    } catch (error) {
      throw new Error(`Failed to schedule backup: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  cancelScheduledBackup(scheduleId: string): boolean {
    const timer = this.scheduledBackups.get(scheduleId);
    if (timer) {
      clearInterval(timer);
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

  destroy(): void {
    // Cancel all scheduled backups
    for (const [id, timer] of this.scheduledBackups) {
      clearInterval(timer);
    }
    this.scheduledBackups.clear();
    console.log('🛑 BackupManager destroyed, all scheduled backups cancelled');
  }
}