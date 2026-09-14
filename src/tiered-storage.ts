import {
    S3Client,
    GetObjectCommand,
    PutObjectCommand,
    DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import {
    existsSync,
    mkdirSync,
    writeFileSync,
    unlinkSync,
    readFileSync,
    renameSync,
} from "fs";
import { dirname } from "path";
import { CloudStorageConfig } from "./backup.js";
import { partitionedPath, walkPartitions, ACIDStorageEngine } from "./acid-engine.js";

export interface TieredStorageConfig {
    enabled: boolean;
    cloudStorage: CloudStorageConfig;
    maxLocalFiles?: number;            // Default: 50,000
    highWatermark?: number;           // Default: 0.90 (90%)
    lowWatermark?: number;            // Default: 0.70 (70%)
    syncIntervalMs?: number;          // Default: 2,000ms
    evictionIntervalMs?: number;      // Default: 30,000ms
    writeThrough?: boolean;           // Default: false
    negativeCacheTtlMs?: number;      // Default: 30,000ms
    autoHydrateOnRead?: boolean;      // Default: true
    concurrency?: number;             // Default: 16
    customS3Client?: S3Client;        // For testing/mocking
}

export interface TieredStorageStats {
    localFilesCount: number;
    maxLocalFiles: number;
    dirtyKeysCount: number;
    syncedKeysCount: number;
    cloudHits: number;
    cloudMisses: number;
    evictedCount: number;
    negativeCacheHits: number;
}

export async function pooledMap<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    if (items.length === 0) return [];
    const results: R[] = new Array(items.length);
    let cursor = 0;
    const concurrency = Math.max(1, Math.min(limit, items.length));
    const workers = Array.from({ length: concurrency }, async () => {
        while (cursor < items.length) {
            const idx = cursor++;
            results[idx] = await fn(items[idx]);
        }
    });
    await Promise.all(workers);
    return results;
}

export class TieredStorageManager {
    private dbPath: string;
    private config: Required<Omit<TieredStorageConfig, 'customS3Client'>> & { customS3Client?: S3Client };
    private acidEngine: ACIDStorageEngine;
    private s3Client!: S3Client;
    private onEvictKey?: (key: string) => void;

    // LRU Access log: key -> lastAccessTimestamp
    private accessLog: Map<string, number> = new Map();
    // Confirmed durable in cloud bucket
    private syncedKeys: Set<string> = new Set();
    // Keys modified locally awaiting cloud upload
    private dirtyQueue: Set<string> = new Set();
    // Keys deleted locally awaiting cloud deletion
    private pendingDeletions: Set<string> = new Set();
    // Negative cache: key -> expirationTimestamp (prevents repeated 404s)
    private negativeCache: Map<string, number> = new Map();

    private syncTimer?: ReturnType<typeof setInterval>;
    private evictionTimer?: ReturnType<typeof setInterval>;
    private isSyncing: boolean = false;
    private isEvicting: boolean = false;

    private stats = {
        cloudHits: 0,
        cloudMisses: 0,
        evictedCount: 0,
        negativeCacheHits: 0,
    };

    constructor(options: {
        dbPath: string;
        config: TieredStorageConfig;
        acidEngine: ACIDStorageEngine;
        onEvictKey?: (key: string) => void;
    }) {
        this.dbPath = options.dbPath;
        this.acidEngine = options.acidEngine;
        this.onEvictKey = options.onEvictKey;

        this.config = {
            enabled: options.config.enabled ?? true,
            cloudStorage: options.config.cloudStorage,
            maxLocalFiles: options.config.maxLocalFiles ?? 50_000,
            highWatermark: options.config.highWatermark ?? 0.90,
            lowWatermark: options.config.lowWatermark ?? 0.70,
            syncIntervalMs: options.config.syncIntervalMs ?? 2_000,
            evictionIntervalMs: options.config.evictionIntervalMs ?? 30_000,
            writeThrough: options.config.writeThrough ?? false,
            negativeCacheTtlMs: options.config.negativeCacheTtlMs ?? 30_000,
            autoHydrateOnRead: options.config.autoHydrateOnRead ?? true,
            concurrency: options.config.concurrency ?? 16,
            customS3Client: options.config.customS3Client,
        };

        this.initializeCloudClient();
        this.scanExistingLocalFiles();
        this.startTimers();
    }

    private initializeCloudClient(): void {
        if (this.config.customS3Client) {
            this.s3Client = this.config.customS3Client;
            return;
        }

        try {
            const clientConfig: any = {
                region: this.config.cloudStorage.region || 'us-east-1',
                credentials: {
                    accessKeyId: this.config.cloudStorage.accessKeyId,
                    secretAccessKey: this.config.cloudStorage.secretAccessKey,
                },
            };

            if (this.config.cloudStorage.endpoint) {
                clientConfig.endpoint = this.config.cloudStorage.endpoint;
                clientConfig.forcePathStyle = true;
            }

            this.s3Client = new S3Client(clientConfig);
        } catch (error) {
            throw new Error(`Failed to initialize cloud storage for tiered storage: ${error instanceof Error ? error.message : 'Unknown error'}`, { cause: error });
        }
    }

    private getDbName(): string {
        const override = (this.config.cloudStorage as any)?.dbName || (this.config.cloudStorage as any)?.bucketPrefix;
        if (typeof override === 'string' && override.trim()) {
            return override.trim().replace(/^\/+|\/+$/g, '').replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 128);
        }
        const raw = this.dbPath;
        const base = raw.split('/').pop() || 'database';
        let h = 0x811c9dc5;
        for (let i = 0; i < raw.length; i++) {
            h ^= raw.charCodeAt(i);
            h = Math.imul(h, 0x01000193) >>> 0;
        }
        const suffix = h.toString(16).padStart(8, '0').slice(0, 6);
        return `${base}-${suffix}`;
    }

    public getCloudKey(filename: string): string {
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

    private scanExistingLocalFiles(): void {
        // Fast asynchronous scan of partitioned directories to seed accessLog and local file counts
        walkPartitions(this.dbPath, (filePath) => {
            // filePath ends with .json
            const filename = filePath.split('/').pop();
            if (filename && filename.endsWith('.json')) {
                const key = filename.slice(0, -5);
                if (!this.accessLog.has(key)) {
                    this.accessLog.set(key, Date.now());
                }
            }
        }).catch(() => {
            // best-effort initialization
        });
    }

    private startTimers(): void {
        if (this.config.syncIntervalMs > 0) {
            this.syncTimer = setInterval(() => {
                this.syncToCloud().catch(() => {});
            }, this.config.syncIntervalMs);
            if (this.syncTimer.unref) this.syncTimer.unref();
        }

        if (this.config.evictionIntervalMs > 0) {
            this.evictionTimer = setInterval(() => {
                this.evictColdFiles();
            }, this.config.evictionIntervalMs);
            if (this.evictionTimer.unref) this.evictionTimer.unref();
        }
    }

    public recordAccess(key: string): void {
        this.accessLog.set(key, Date.now());
        this.negativeCache.delete(key);
    }

    public markDirty(key: string): void {
        this.dirtyQueue.add(key);
        this.pendingDeletions.delete(key);
        this.recordAccess(key);
    }

    public markDeleted(key: string): void {
        this.dirtyQueue.delete(key);
        this.syncedKeys.delete(key);
        this.pendingDeletions.add(key);
        this.accessLog.delete(key);
        this.negativeCache.delete(key);
    }

    /**
     * Read-through: On cache/disk miss, fetch document from cloud bucket.
     * If found, persists locally to partitionedPath and records in accessLog and syncedKeys.
     */
    public async fetchFromCloud(key: string): Promise<any | null> {
        if (!this.config.autoHydrateOnRead) {
            return null;
        }

        // Check negative cache
        const negExpiry = this.negativeCache.get(key);
        if (negExpiry && negExpiry > Date.now()) {
            this.stats.negativeCacheHits++;
            return null;
        }

        const cloudKey = this.getCloudKey(`${key}.json`);

        try {
            const cmd = new GetObjectCommand({
                Bucket: this.config.cloudStorage.bucket,
                Key: cloudKey,
            });

            const response = await this.s3Client.send(cmd);
            if (!response.Body) {
                this.negativeCache.set(key, Date.now() + this.config.negativeCacheTtlMs);
                this.stats.cloudMisses++;
                return null;
            }

            // Transform stream to string
            const content = await response.Body.transformToString('utf-8');
            const data = content.trim() ? JSON.parse(content) : {};

            // Save locally so future reads take local fast-path
            const localFilePath = partitionedPath(this.dbPath, key);
            const localDir = dirname(localFilePath);
            if (!existsSync(localDir)) {
                mkdirSync(localDir, { recursive: true });
            }

            // Atomic temp -> rename write to avoid corrupt partial reads
            const tempPath = `${localFilePath}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
            writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');
            renameSync(tempPath, localFilePath);

            this.syncedKeys.add(key);
            this.recordAccess(key);
            this.stats.cloudHits++;

            // If local count exceeds watermark, trigger opportunistic eviction
            if (this.accessLog.size > this.config.maxLocalFiles * this.config.highWatermark) {
                this.evictColdFiles();
            }

            return data;
        } catch (error: any) {
            if (this.isNotFound(error)) {
                this.negativeCache.set(key, Date.now() + this.config.negativeCacheTtlMs);
                this.stats.cloudMisses++;
                return null;
            }
            throw new Error(`Failed to fetch key '${key}' from cloud storage: ${error?.message || 'Unknown error'}`, { cause: error });
        }
    }

    /**
     * Synchronize dirty local modifications and deletions to cloud bucket.
     */
    public async syncToCloud(): Promise<{ uploaded: number; deleted: number }> {
        if (this.isSyncing) return { uploaded: 0, deleted: 0 };
        this.isSyncing = true;

        let uploaded = 0;
        let deleted = 0;

        try {
            // Process deletions first
            const deletions = Array.from(this.pendingDeletions);
            if (deletions.length > 0) {
                await pooledMap(deletions, this.config.concurrency, async (key) => {
                    const cloudKey = this.getCloudKey(`${key}.json`);
                    try {
                        await this.s3Client.send(new DeleteObjectCommand({
                            Bucket: this.config.cloudStorage.bucket,
                            Key: cloudKey,
                        }));
                    } catch (error: any) {
                        if (!this.isNotFound(error)) throw error;
                    }
                    this.pendingDeletions.delete(key);
                    this.syncedKeys.delete(key);
                    deleted++;
                });
            }

            // Process dirty uploads
            const dirty = Array.from(this.dirtyQueue);
            if (dirty.length > 0) {
                await pooledMap(dirty, this.config.concurrency, async (key) => {
                    // Make sure key wasn't deleted while waiting in queue
                    if (this.pendingDeletions.has(key)) return;

                    const filePath = partitionedPath(this.dbPath, key);
                    if (existsSync(filePath)) {
                        const content = readFileSync(filePath, 'utf-8');
                        const cloudKey = this.getCloudKey(`${key}.json`);

                        await this.s3Client.send(new PutObjectCommand({
                            Bucket: this.config.cloudStorage.bucket,
                            Key: cloudKey,
                            Body: content,
                            ContentType: 'application/json',
                            Metadata: {
                                'source-db': this.getDbName(),
                                'updated-at': new Date().toISOString(),
                            }
                        }));

                        this.dirtyQueue.delete(key);
                        this.syncedKeys.add(key);
                        uploaded++;
                    } else if (this.acidEngine.isKeyInCommittedBuffer(key)) {
                        // Still in memory committedBuffer, wait for next cycle
                    } else {
                        // File does not exist and not in committedBuffer — remove from dirty
                        this.dirtyQueue.delete(key);
                    }
                });
            }
        } finally {
            this.isSyncing = false;
        }

        return { uploaded, deleted };
    }

    /**
     * Evict cold documents from local disk down to lowWatermark.
     * Strict safety invariants:
     *   1. Key must be confirmed in cloud (in syncedKeys)
     *   2. Key must NOT be dirty (not in dirtyQueue)
     *   3. Key must NOT have active locks
     *   4. Key must NOT be pending in committedBuffer
     */
    public evictColdFiles(): number {
        if (this.isEvicting) return 0;
        this.isEvicting = true;

        let evictedCount = 0;

        try {
            const currentCount = this.accessLog.size;
            const highThreshold = Math.floor(this.config.maxLocalFiles * this.config.highWatermark);
            const lowTarget = Math.floor(this.config.maxLocalFiles * this.config.lowWatermark);

            if (currentCount <= highThreshold) {
                return 0;
            }

            const targetToEvict = currentCount - lowTarget;
            if (targetToEvict <= 0) return 0;

            // Sort candidate keys by access timestamp ascending (coldest first)
            const candidates = Array.from(this.accessLog.entries())
                .sort((a, b) => a[1] - b[1]);

            for (const [key] of candidates) {
                if (evictedCount >= targetToEvict) break;

                // Safety checks:
                if (!this.syncedKeys.has(key)) continue;
                if (this.dirtyQueue.has(key)) continue;
                if (this.pendingDeletions.has(key)) continue;
                if (this.acidEngine.isKeyLocked(key)) continue;
                if (this.acidEngine.isKeyInCommittedBuffer(key)) continue;

                // Candidate is safe to evict from local disk
                const filePath = partitionedPath(this.dbPath, key);
                try {
                    if (existsSync(filePath)) {
                        unlinkSync(filePath);
                    }
                } catch {
                    continue; // Skip on unlink failure
                }

                // Remove from local access tracking
                this.accessLog.delete(key);

                // Notify Tero instance to remove from in-memory cache
                if (this.onEvictKey) {
                    this.onEvictKey(key);
                }

                evictedCount++;
                this.stats.evictedCount++;
            }
        } finally {
            this.isEvicting = false;
        }

        return evictedCount;
    }

    public getStats(): TieredStorageStats {
        return {
            localFilesCount: this.accessLog.size,
            maxLocalFiles: this.config.maxLocalFiles,
            dirtyKeysCount: this.dirtyQueue.size,
            syncedKeysCount: this.syncedKeys.size,
            cloudHits: this.stats.cloudHits,
            cloudMisses: this.stats.cloudMisses,
            evictedCount: this.stats.evictedCount,
            negativeCacheHits: this.stats.negativeCacheHits,
        };
    }

    public async destroy(): Promise<void> {
        if (this.syncTimer) {
            clearInterval(this.syncTimer);
            this.syncTimer = undefined;
        }
        if (this.evictionTimer) {
            clearInterval(this.evictionTimer);
            this.evictionTimer = undefined;
        }

        // Final sync flush
        try {
            await this.syncToCloud();
        } catch {
            // best-effort
        }

        if (this.s3Client && typeof (this.s3Client as any).destroy === 'function') {
            this.s3Client.destroy();
        }
    }
}
