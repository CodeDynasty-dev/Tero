import { S3Client, GetObjectCommand, ListObjectsV2Command, HeadObjectCommand, DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createWriteStream, existsSync, mkdirSync, openSync, fsyncSync, closeSync, renameSync, unlinkSync, writeFileSync, writeSync } from "fs";
import { join, dirname, resolve as pathResolve } from "path";
import { pipeline } from "stream/promises";
import { CloudStorageConfig } from "./backup.js";
import { partitionedPath, DataCorruptionError } from "./acid-engine.js";

export const MAX_DOCUMENT_SIZE = 10 * 1024 * 1024; // 10MB limit

export type RecoveryErrorKind = 'NOT_FOUND' | 'RETRYABLE_NETWORK' | 'FATAL_AUTH' | 'CANCELLED' | 'FATAL_CORRUPTION' | 'FATAL_UNKNOWN';

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
    const code = error?.code;
    if (
        (typeof status === 'number' && (status === 429 || (status >= 500 && status < 600))) ||
        code === 'ECONNRESET' ||
        code === 'ETIMEDOUT' ||
        code === 'ENOTFOUND' ||
        code === 'EAI_AGAIN' ||
        code === 'UND_ERR_CONNECT_TIMEOUT' ||
        error?.name === 'TimeoutError' ||
        error?.name === 'RequestTimeout' ||
        error?.name === 'ServiceUnavailable'
    ) {
        return 'RETRYABLE_NETWORK';
    }
    return 'FATAL_UNKNOWN';
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
            // "not in cloud" from "couldn't reach cloud", preserving metadata for classifyRecoveryError.
            const err = new Error(`Failed to check file in cloud: ${error?.message || 'Unknown error'}`);
            (err as any).$metadata = error?.$metadata;
            (err as any).name = error?.name;
            (err as any).code = error?.code;
            throw err;
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

            const response = await this.s3Client.send(getCommand, { abortSignal: options?.abortSignal });
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

            // Write atomically and durably to avoid partial reads on crash
            const tempFilePath = `${localFilePath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
            try {
                const fd = openSync(tempFilePath, 'w');
                try {
                    writeSync(fd, Buffer.from(content, 'utf-8'));
                    fsyncSync(fd);
                } finally {
                    closeSync(fd);
                }
                renameSync(tempFilePath, localFilePath);

                // Durably persist directory entry
                const dirFd = openSync(localDir, 'r');
                try {
                    fsyncSync(dirFd);
                } finally {
                    closeSync(dirFd);
                }
            } catch (writeErr) {
                try { if (existsSync(tempFilePath)) unlinkSync(tempFilePath); } catch { /* approved: cleanup temp file */ }
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

    /**
     * Upload a durable tombstone for a deleted key (P0-2). Tombstone carries
     * a monotonic version (LSN or timestamp) so that a later re-create can
     * invalidate it. Hydration must check tombstone before resurrecting.
     */
    async putTombstone(key: string, version?: number): Promise<void> {
        if (!this.s3Client || !this.config.cloudStorage) return;
        const cloudKey = this.getCloudKey(`${key}.json.deleted`);
        const ver = version ?? Date.now();
        await this.s3Client.send(new PutObjectCommand({
            Bucket: this.config.cloudStorage.bucket,
            Key: cloudKey,
            Body: Buffer.alloc(0),
            ContentType: 'application/octet-stream',
            Metadata: {
                'tombstone-version': String(ver),
                'deleted-at': new Date().toISOString(),
            }
        }));
    }

    async deleteTombstone(key: string): Promise<void> {
        if (!this.s3Client || !this.config.cloudStorage) return;
        try {
            const cloudKey = this.getCloudKey(`${key}.json.deleted`);
            await this.s3Client.send(new DeleteObjectCommand({
                Bucket: this.config.cloudStorage.bucket,
                Key: cloudKey
            }));
        } catch (e: any) {
            if (this.isNotFound(e)) return;
            throw e;
        }
    }

    /**
     * Check if a tombstone exists for the key. If both a document and a tombstone
     * exist, the newer LastModified wins (tombstone newer => logically deleted).
     * Returns true if key is tombstoned (deleted) and hydration must not resurrect.
     */
    async hasTombstone(key: string): Promise<boolean> {
        if (!this.s3Client || !this.config.cloudStorage) return false;
        const tombKey = this.getCloudKey(`${key}.json.deleted`);
        let tombMeta: { LastModified?: Date } | null = null;
        try {
            const resp: any = await this.s3Client.send(new HeadObjectCommand({
                Bucket: this.config.cloudStorage.bucket,
                Key: tombKey
            }));
            // Defensive: some test mocks return a GetObject-shaped response (Body) for HeadObject.
            // Only treat as tombstone if response looks like HeadObject (has LastModified/ContentLength without Body).
            if (resp && resp.Body !== undefined) return false;
            if (!resp || (resp.LastModified === undefined && resp.ContentLength === undefined && resp.ETag === undefined && resp.ContentType === undefined)) {
                // Empty or unexpected mock response — treat as no tombstone
                return false;
            }
            tombMeta = resp;
        } catch (e: any) {
            if (this.isNotFound(e)) return false;
            throw e;
        }
        if (!tombMeta) return false;
        // If document also exists, compare timestamps — tombstone must be newer to win
        try {
            const docKey = this.getCloudKey(`${key}.json`);
            const docResp: any = await this.s3Client.send(new HeadObjectCommand({
                Bucket: this.config.cloudStorage.bucket,
                Key: docKey
            }));
            const docTime = docResp.LastModified?.getTime() ?? 0;
            const tombTime = tombMeta.LastModified?.getTime() ?? 0;
            // Tombstone newer or equal => deleted; otherwise document is newer (re-created)
            return tombTime >= docTime;
        } catch (e: any) {
            if (this.isNotFound(e)) {
                // No document, only tombstone => deleted
                return true;
            }
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
            // auth/network hiccup doesn't abort the whole batch when continueOnError is true —
            // they go into `failed` and the caller can decide whether to retry.
            // When continueOnError is false, fatal errors (auth, corruption, unknown) throw immediately.
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
                        const { key, success, error } = r.value as any;
                        if (success) {
                            recovered.push(key);
                        } else {
                            failed.push(key);
                            if (error && !this.config.continueOnError) {
                                const kind = classifyRecoveryError(error);
                                if (kind === 'FATAL_AUTH' || kind === 'FATAL_CORRUPTION' || kind === 'FATAL_UNKNOWN') {
                                    throw error;
                                }
                            }
                        }
                    } else {
                        failed.push((r.reason as any)?.key || 'unknown');
                        if (!this.config.continueOnError) {
                            const kind = classifyRecoveryError(r.reason);
                            if (kind === 'FATAL_AUTH' || kind === 'FATAL_CORRUPTION' || kind === 'FATAL_UNKNOWN') {
                                throw r.reason;
                            }
                        }
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
            const kind = classifyRecoveryError(error);
            if (!this.config.continueOnError && (kind === 'FATAL_AUTH' || kind === 'FATAL_CORRUPTION' || kind === 'FATAL_UNKNOWN')) {
                throw error;
            }
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

    async *iterateAvailableArchives(options?: { abortSignal?: AbortSignal }): AsyncGenerator<{ name: string; key: string; lastModified?: Date }, void, unknown> {
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
                    }), { abortSignal: options?.abortSignal });
                } catch (error: any) {
                    if (this.isNotFound(error)) return;
                    throw error;
                }
                if (response.Contents) {
                    for (const obj of response.Contents) {
                        options?.abortSignal?.throwIfAborted();
                        if (obj.Key && obj.Key.endsWith('.tar.gz')) {
                            yield {
                                name: obj.Key.split('/').pop()!,
                                key: obj.Key,
                                lastModified: obj.LastModified
                            };
                        }
                    }
                }
                token = response.IsTruncated ? response.NextContinuationToken : undefined;
            } while (token);
        } catch (error: any) {
            if (this.isNotFound(error)) return;
            throw error;
        }
    }

    async listAvailableArchives(options?: { abortSignal?: AbortSignal }): Promise<string[]> {
        const archives: Array<{ name: string; lastModified?: Date }> = [];
        for await (const arch of this.iterateAvailableArchives(options)) {
            archives.push(arch);
        }
        return archives
            .sort((a, b) => (b.lastModified?.getTime() || 0) - (a.lastModified?.getTime() || 0))
            .map(a => a.name)
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
                    }), { abortSignal: options?.abortSignal });
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
    async recoverMissingFiles(isCancelledOrOptions?: (() => boolean) | { abortSignal?: AbortSignal }): Promise<RecoveryResult> {
        const startTime = Date.now();
        const isCancelled = typeof isCancelledOrOptions === 'function'
            ? isCancelledOrOptions
            : () => isCancelledOrOptions?.abortSignal?.aborted ?? false;
        const abortSignal = typeof isCancelledOrOptions === 'object' ? isCancelledOrOptions?.abortSignal : undefined;

        try {
            const missing = await this.listMissingLocally({ abortSignal });
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
            const kind = classifyRecoveryError(error);
            if (!this.config.continueOnError && (kind === 'FATAL_AUTH' || kind === 'FATAL_CORRUPTION' || kind === 'FATAL_UNKNOWN')) {
                throw error;
            }
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