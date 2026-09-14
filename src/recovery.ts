import { S3Client, GetObjectCommand, ListObjectsV2Command, HeadObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { createWriteStream, existsSync, mkdirSync, openSync, fsyncSync, closeSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { join, dirname, resolve as pathResolve } from "path";
import { pipeline } from "stream/promises";
import { CloudStorageConfig } from "./backup.js";
import { partitionedPath, DataCorruptionError } from "./acid-engine.js";

export const MAX_DOCUMENT_SIZE = 10 * 1024 * 1024; // 10MB limit

export type RecoveryErrorKind = 'NOT_FOUND' | 'RETRYABLE_NETWORK' | 'FATAL_AUTH' | 'CANCELLED' | 'FATAL_CORRUPTION';

export function classifyRecoveryError(error: any): RecoveryErrorKind {
    if (
        error?.name === 'NotFound' ||
        error?.name === 'NoSuchKey' ||
        error?.$metadata?.httpStatusCode === 404 ||
        (error?.Code && (error.Code === 'NotFound' || error.Code === 'NoSuchKey'))
    ) {
        return 'NOT_FOUND';
    }
    if (
        error?.name === 'AbortError' ||
        error?.name === 'CanceledError' ||
        error?.code === 'ABORT_ERR'
    ) {
        return 'CANCELLED';
    }
    const status = error?.$metadata?.httpStatusCode;
    if (status === 403 || status === 401 || error?.name === 'AccessDenied' || error?.name === 'InvalidAccessKeyId') {
        return 'FATAL_AUTH';
    }
    if (error instanceof DataCorruptionError || error?.name === 'DataCorruptionError' || error?.code === 'DATA_CORRUPTION') {
        return 'FATAL_CORRUPTION';
    }
    return 'RETRYABLE_NETWORK';
}

export interface RecoveryConfig {
    cloudStorage: CloudStorageConfig;
    localPath: string;
    autoRecover?: boolean; // Automatically recover missing files
    recoveryTimeout?: number; // Timeout for recovery operations (default: 30000ms)
    continueOnError?: boolean; // Keep going when a real (non-404) error occurs for one file
    concurrency?: number; // Parallel S3 GETs — default 10 for fast hydration (was sequential)
    customS3Client?: any; // Optional custom S3 client for mocking/testing
}

export interface RecoveryResult {
    success: boolean;
    recovered: string[];
    failed: string[];
    totalFiles: number;
    duration: number;
}

export interface FileRecoveryInfo {
    key: string;
    exists: boolean;
    size?: number;
    lastModified?: Date;
    recovered?: boolean;
}

export class DataRecovery {
    private s3Client!: S3Client;
    private config: RecoveryConfig;

    constructor(config: RecoveryConfig) {
        this.config = config;
        this.initializeCloudStorage();
    }

    private initializeCloudStorage(): void {
        try {
            if (this.config.customS3Client) {
                this.s3Client = this.config.customS3Client;
                return;
            }

            const clientConfig: any = {
                region: this.config.cloudStorage.region,
                credentials: {
                    accessKeyId: this.config.cloudStorage.accessKeyId,
                    secretAccessKey: this.config.cloudStorage.secretAccessKey,
                },
            };

            // Configure for Cloudflare R2 or custom endpoints
            if (this.config.cloudStorage.endpoint) {
                clientConfig.endpoint = this.config.cloudStorage.endpoint;
                clientConfig.forcePathStyle = true; // Required for R2
            }

            this.s3Client = new S3Client(clientConfig);
        } catch (error) {
            throw new Error(`Failed to initialize cloud storage for recovery: ${error instanceof Error ? error.message : 'Unknown error'}`, { cause: error });
        }
    }

    private getDbName(): string {
        const override = (this.config.cloudStorage as any)?.dbName || (this.config as any)?.bucketPrefix;
        if (typeof override === 'string' && override.trim()) {
            return override.trim().replace(/^\/+|\/+$/g, '').replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 128);
        }
        const raw = this.config.localPath;
        const base = raw.split('/').pop() || 'database';
        let h = 0x811c9dc5;
        for (let i = 0; i < raw.length; i++) { h ^= raw.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
        const suffix = h.toString(16).padStart(8, '0').slice(0, 6);
        return `${base}-${suffix}`;
    }

    private getCloudKey(filename: string): string {
        const prefix = this.config.cloudStorage.pathPrefix || 'tero-backups';
        const dbName = this.getDbName();
        if (!filename) return `${prefix}/${dbName}/`;
        return `${prefix}/${dbName}/${filename.replace(/^\/+/, '')}`;
    }

    private isNotFound(error: any): boolean {
        return (
            error?.name === 'NotFound' ||
            error?.name === 'NoSuchKey' ||
            error?.$metadata?.httpStatusCode === 404 ||
            (error?.Code && (error.Code === 'NotFound' || error.Code === 'NoSuchKey'))
        );
    }

    async checkFileInCloud(key: string): Promise<FileRecoveryInfo> {
        try {
            const cloudKey = this.getCloudKey(`${key}.json`);

            const headCommand = new HeadObjectCommand({
                Bucket: this.config.cloudStorage.bucket,
                Key: cloudKey
            });

            const response = await this.s3Client.send(headCommand);

            return {
                key,
                exists: true,
                size: response.ContentLength,
                lastModified: response.LastModified
            };
        } catch (error: any) {
            if (this.isNotFound(error)) {
                return { key, exists: false };
            }
            // Re-surface real errors (auth/network/permission) so callers can distinguish
            // "not in cloud" from "couldn't reach cloud".
            throw new Error(`Failed to check file in cloud: ${error?.message || 'Unknown error'}`);
        }
    }

    /**
     * Efficiently fetches a single file from cloud storage, writes it atomically
     * to the partitioned disk location, and returns the parsed JSON data directly
     * from memory — avoiding redundant disk reads or extra syscalls.
     */
    async fetchAndPersist(key: string, options?: { abortSignal?: AbortSignal }): Promise<any | null> {
        options?.abortSignal?.throwIfAborted();
        try {
            const cloudKey = this.getCloudKey(`${key}.json`);
            const localFilePath = partitionedPath(this.config.localPath, key);

            const getCommand = new GetObjectCommand({
                Bucket: this.config.cloudStorage.bucket,
                Key: cloudKey
            });

            const response = await this.s3Client.send(getCommand);
            if (!response.Body) {
                return null;
            }

            if (response.ContentLength !== undefined && response.ContentLength > MAX_DOCUMENT_SIZE) {
                throw new Error(`Document '${key}' exceeds maximum allowed size of ${MAX_DOCUMENT_SIZE} bytes (got ${response.ContentLength})`);
            }

            let content: string;
            if (typeof (response.Body as any).transformToString === 'function') {
                content = await (response.Body as any).transformToString('utf-8');
            } else {
                const chunks: Buffer[] = [];
                let totalBytes = 0;
                for await (const chunk of response.Body as any) {
                    options?.abortSignal?.throwIfAborted();
                    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                    totalBytes += buf.length;
                    if (totalBytes > MAX_DOCUMENT_SIZE) {
                        throw new Error(`Document '${key}' exceeds maximum allowed size of ${MAX_DOCUMENT_SIZE} bytes`);
                    }
                    chunks.push(buf);
                }
                content = Buffer.concat(chunks).toString('utf-8');
            }

            options?.abortSignal?.throwIfAborted();

            // Validate JSON in memory before writing to disk
            const trimmed = content.trim();
            let parsed: any;
            try {
                parsed = trimmed ? JSON.parse(trimmed) : {};
            } catch (err: any) {
                throw new DataCorruptionError(localFilePath, `Downloaded corrupted JSON from cloud for key '${key}': ${err?.message}`);
            }

            const localDir = dirname(localFilePath);
            if (!existsSync(localDir)) {
                mkdirSync(localDir, { recursive: true });
            }

            // Write atomically to avoid partial reads on crash
            const tempFilePath = `${localFilePath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
            try {
                writeFileSync(tempFilePath, content, 'utf-8');
                renameSync(tempFilePath, localFilePath);
            } catch (writeErr) {
                try { if (existsSync(tempFilePath)) unlinkSync(tempFilePath); } catch { }
                throw writeErr;
            }

            return parsed;
        } catch (error: any) {
            if (this.isNotFound(error)) {
                return null;
            }
            throw error;
        }
    }

    /**
     * Delete a single document file from cloud storage.
     * Used to propagate deletes in lazy-hydration mode.
     */
    async deleteFromCloud(key: string): Promise<void> {
        if (!this.s3Client || !this.config.cloudStorage) return;
        try {
            const cloudKey = this.getCloudKey(`${key}.json`);
            await this.s3Client.send(new DeleteObjectCommand({
                Bucket: this.config.cloudStorage.bucket,
                Key: cloudKey
            }));
        } catch (e: any) {
            if (this.isNotFound(e)) return;
            throw e;
        }
    }

    async recoverSingleFile(key: string): Promise<boolean> {
        const data = await this.fetchAndPersist(key);
        return data !== null;
    }

    async recoverFromArchive(archiveName?: string): Promise<RecoveryResult> {
        const startTime = Date.now();
        const recovered: string[] = [];
        const failed: string[] = [];

        try {
            // List available archives if no specific archive is provided
            if (!archiveName) {
                const archives = await this.listAvailableArchives();
                if (archives.length === 0) {
                    throw new Error('No backup archives found in cloud storage');
                }
                // Use the most recent archive
                archiveName = archives[0];
            }

            const cloudKey = this.getCloudKey(archiveName);
            const localArchivePath = join(this.config.localPath, archiveName);

            // Download the archive
            const downloadSuccess = await this.downloadFile(cloudKey, localArchivePath);

            if (!downloadSuccess) {
                throw new Error(`Failed to download archive: ${archiveName}`);
            }

            // Extract the archive
            const extractSuccess = await this.extractArchive(localArchivePath);

            if (extractSuccess) {
                recovered.push(archiveName);
            } else {
                failed.push(archiveName);
            }

            const duration = Date.now() - startTime;
            return {
                success: recovered.length > 0,
                recovered,
                failed,
                totalFiles: 1,
                duration
            };
        } catch (error) {
            const duration = Date.now() - startTime;

            return {
                success: false,
                recovered,
                failed: [archiveName || 'unknown'],
                totalFiles: 1,
                duration
            };
        }
    }

    async recoverIndividualFiles(keys?: string[], isCancelled?: () => boolean): Promise<RecoveryResult> {
        const startTime = Date.now();
        const recovered: string[] = [];
        const failed: string[] = [];

        try {
            // If no keys provided, list all available files
            if (!keys || keys.length === 0) {
                keys = await this.listAvailableFiles();
                if (keys.length === 0) {
                    throw new Error('No backup files found in cloud storage');
                }
            }

            // Recover each file. We catch real (non-404) errors here so a single
            // auth/network hiccup doesn't abort the whole batch — they go into `failed`
            // and the caller can decide whether to retry.
            //
            // Parallel S3 GETs in batches of `concurrency` (default 10). A single-key
            // sequential download takes ~30ms HTTP RTT to S3/R2; 50,000 keys sequentially
            // takes 25 minutes (1,500 seconds). Batched parallelism reduces this to
            // ~25ms × (50,000 / 10) ≈ 125 seconds (~2 min) and can be tuned higher.
            const concurrency = this.config.concurrency ?? 10;
            for (let i = 0; i < keys.length; i += concurrency) {
                if (isCancelled?.()) break;
                const batch = keys.slice(i, i + concurrency);
                const results = await Promise.allSettled(
                    batch.map(async (key) => {
                        try {
                            const success = await this.recoverSingleFile(key);
                            return { key, success };
                        } catch (error) {
                            return { key, success: false, error };
                        }
                    })
                );
                for (const r of results) {
                    if (r.status === 'fulfilled') {
                        const { key, success } = r.value;
                        if (success) recovered.push(key);
                        else failed.push(key);
                    } else {
                        failed.push((r.reason as any)?.key || 'unknown');
                    }
                }
            }

            const duration = Date.now() - startTime;

            return {
                success: recovered.length > 0,
                recovered,
                failed,
                totalFiles: keys.length,
                duration
            };
        } catch (error) {
            const duration = Date.now() - startTime;

            return {
                success: false,
                recovered,
                failed: keys || [],
                totalFiles: keys?.length || 0,
                duration
            };
        }
    }

    async listAvailableArchives(): Promise<string[]> {
        const prefix = this.getCloudKey('');
        const objects: any[] = [];
        let token: string | undefined;
        try {
            do {
                const response: any = await this.s3Client.send(new ListObjectsV2Command({
                    Bucket: this.config.cloudStorage.bucket,
                    Prefix: prefix,
                    MaxKeys: 1000,
                    ContinuationToken: token
                }));
                if (response.Contents) objects.push(...response.Contents);
                token = response.IsTruncated ? response.NextContinuationToken : undefined;
            } while (token);
        } catch (error: any) {
            if (this.isNotFound(error)) return [];
            throw error;
        }

        if (objects.length === 0) return [];

        return objects
            .filter((obj: any) => obj.Key && obj.Key.endsWith('.tar.gz'))
            .sort((a: any, b: any) => {
                const dateA = a.LastModified?.getTime() || 0;
                const dateB = b.LastModified?.getTime() || 0;
                return dateB - dateA;
            })
            .map((obj: any) => obj.Key!.split('/').pop()!)
            .filter(Boolean);
    }

    async *iterateAvailableFiles(options?: { abortSignal?: AbortSignal }): AsyncGenerator<string, void, unknown> {
        const prefix = this.getCloudKey('');
        let token: string | undefined;
        try {
            do {
                options?.abortSignal?.throwIfAborted();
                let response: any;
                try {
                    response = await this.s3Client.send(new ListObjectsV2Command({
                        Bucket: this.config.cloudStorage.bucket,
                        Prefix: prefix,
                        MaxKeys: 1000,
                        ContinuationToken: token
                    }));
                } catch (error: any) {
                    if (this.isNotFound(error)) return;
                    throw error;
                }
                if (response.Contents) {
                    for (const obj of response.Contents) {
                        options?.abortSignal?.throwIfAborted();
                        if (!obj.Key || !obj.Key.endsWith('.json') || obj.Key.endsWith('.deleted')) continue;
                        if (
                            obj.Key.endsWith('MANIFEST.json') ||
                            obj.Key.endsWith('latest.json') ||
                            obj.Key.endsWith('index.json') ||
                            obj.Key.endsWith('backup-metadata.json') ||
                            obj.Key.endsWith('-metadata.json') ||
                            obj.Key.includes('/wal/') ||
                            obj.Key.includes('/nodes/')
                        ) continue;
                        const filename = obj.Key.split('/').pop()!;
                        if (filename.startsWith('.')) continue;
                        yield filename.replace(/\.json$/, '');
                    }
                }
                token = response.IsTruncated ? response.NextContinuationToken : undefined;
            } while (token);
        } catch (err: any) {
            if (this.isNotFound(err)) return;
            throw err;
        }
    }

    async listAvailableFiles(options?: { abortSignal?: AbortSignal }): Promise<string[]> {
        const files: string[] = [];
        for await (const file of this.iterateAvailableFiles(options)) {
            files.push(file);
        }
        return files;
    }

    /**
     * List files that exist in the cloud bucket but are missing from the local directory.
     * This is the v2 fast path used during hydrate-on-startup with mode='missing'.
     */
    async listMissingLocally(options?: { abortSignal?: AbortSignal }): Promise<string[]> {
        const cloudFiles = await this.listAvailableFiles(options);
        const missing: string[] = [];
        for (const key of cloudFiles) {
            const localPath = partitionedPath(this.config.localPath, key);
            if (!existsSync(localPath)) {
                missing.push(key);
            }
        }
        return missing;
    }

    /**
     * Recover only files that exist in the cloud but are missing locally.
     * Returns the standard RecoveryResult. Used by v2 hydrate-on-startup (mode='missing').
     */
    async recoverMissingFiles(isCancelled?: () => boolean): Promise<RecoveryResult> {
        const startTime = Date.now();
        try {
            const missing = await this.listMissingLocally();
            if (missing.length === 0) {
                return {
                    success: true,
                    recovered: [],
                    failed: [],
                    totalFiles: 0,
                    duration: Date.now() - startTime,
                };
            }
            const result = await this.recoverIndividualFiles(missing, isCancelled);
            result.duration = Date.now() - startTime;
            return result;
        } catch (error) {
            return {
                success: false,
                recovered: [],
                failed: [],
                totalFiles: 0,
                duration: Date.now() - startTime,
            };
        }
    }

    private async downloadFile(cloudKey: string, localPath: string): Promise<boolean> {
        try {
            const getCommand = new GetObjectCommand({
                Bucket: this.config.cloudStorage.bucket,
                Key: cloudKey
            });

            const response = await this.s3Client.send(getCommand);

            if (!response.Body) {
                return false;
            }

            // Ensure local directory exists
            const localDir = dirname(localPath);
            if (!existsSync(localDir)) {
                mkdirSync(localDir, { recursive: true });
            }

            const tempPath = `${localPath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
            try {
                const writeStream = createWriteStream(tempPath);
                await pipeline(response.Body as any, writeStream);
                renameSync(tempPath, localPath);
            } catch (err) {
                try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch { }
                throw err;
            }

            return true;
        } catch (error: any) {
            if (this.isNotFound(error)) {
                return false;
            }
            throw new Error(`Failed to download file from cloud: ${error?.message || 'Unknown error'}`);
        }
    }

    private async extractArchive(archivePath: string): Promise<boolean> {
        try {
            const tar = await import('tar');
            const targetDir = pathResolve(this.config.localPath);

            await tar.extract({
                file: archivePath,
                cwd: targetDir,
                strip: 1, // Remove the top-level directory from the archive
                // Hardened: block ZipSlip + symlink escape. Tar entries can be symlinks
                // that point outside targetDir; the filter below rejects any path that
                // resolves outside, and we additionally reject symlink/hardlink types.
                filter: (path: string, entry: any) => {
                    // Reject symlink and hardlink entries entirely — they can escape even if path looks safe
                    const type = entry?.type?.toLowerCase?.();
                    if (type === 'symlink' || type === 'symboliclink' || type === 'link') return false;
                    if (entry?.linkpath) return false;
                    // Prevent path traversal (Zip Slip / Tar Slip)
                    const resolved = pathResolve(targetDir, path);
                    if (!(resolved === targetDir || resolved.startsWith(targetDir + '/'))) return false;
                    if (path.includes('..')) return false;
                    // Also reject entries with absolute paths
                    if (path.startsWith('/')) return false;
                    return true;
                }
            });

            // Fsync directory to ensure dentries are durable
            try {
                const fd = openSync(targetDir, 'r');
                try { fsyncSync(fd); } finally { closeSync(fd); }
            } catch { /* approved: directory fsync best-effort */ }

            return true;
        } catch (error) {
            return false;
        }
    }

    async testCloudConnection(): Promise<{ success: boolean; message: string }> {
        try {
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

    async getRecoveryInfo(): Promise<{
        cloudFiles: number;
        localFiles: number;
        missingLocally: string[];
        availableForRecovery: string[];
    }> {
        try {
            const cloudFiles = await this.listAvailableFiles();
            let localCount = 0;
            const missingLocally: string[] = [];

            // Single O(N) pass: check local existence and collect missing keys directly
            for (const key of cloudFiles) {
                const localPath = partitionedPath(this.config.localPath, key);
                if (existsSync(localPath)) {
                    localCount++;
                } else {
                    missingLocally.push(key);
                }
            }

            return {
                cloudFiles: cloudFiles.length,
                localFiles: localCount,
                missingLocally,
                availableForRecovery: cloudFiles
            };
        } catch (error) {
            return {
                cloudFiles: 0,
                localFiles: 0,
                missingLocally: [],
                availableForRecovery: []
            };
        }
    }
}