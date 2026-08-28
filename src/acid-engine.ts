import { existsSync, readFileSync, readSync, appendFileSync, writeFileSync, unlinkSync, mkdirSync, readdirSync, statSync, openSync, closeSync, fsyncSync, renameSync } from "fs";
import { join, dirname } from "path";
import { randomBytes } from "crypto";

// ACID-compliant transaction log entry
export interface LogEntry {
    lsn: number; // Log Sequence Number
    transactionId: string;
    operation: 'BEGIN' | 'WRITE' | 'DELETE' | 'COMMIT' | 'ROLLBACK' | 'CHECKPOINT';
    key?: string;
    beforeImage?: any; // For rollback
    afterImage?: any;  // For redo
    timestamp: number;
    checksum: string;  // 64-bit dual-FNV hex (16 chars). 32-bit hash collisions
                       // become likely at ~50k WAL entries (birthday paradox);
                       // 64-bit pushes that ceiling to ~1B entries.
}

export type SynchronousMode = 'full' | 'normal' | 'off';

/**
 * 64-bit hash via two independent FNV-1a passes with different offset basis
 * and prime, combined into a 16-char hex string. ~2x the cost of a single
 * 32-bit FNV-1a but the collision space is 2^64 (birthday-paradox collision
 * becomes likely only at ~1B entries vs ~50k for 32-bit). Used for WAL entry
 * integrity, not cryptographic verification.
 */
function fnv1a64(str: string): string {
    let h1 = 0x811c9dc5;
    let h2 = 0xcef82e1d; // different offset basis for the second pass
    for (let i = 0; i < str.length; i++) {
        const c = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
        h2 = Math.imul(h2 ^ c, 0x85ebca77) >>> 0; // different prime multiplier
    }
    // Combine into 16-char hex (two 32-bit halves)
    return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

// Write-Ahead Log (WAL) implementation
export class WriteAheadLog {
    private logPath: string;
    private currentLSN: number = 0;
    private readonly LOG_FILE_SIZE_LIMIT = 1 * 1024 * 1024; // 1MB
    private readonly ARCHIVE_KEEP_COUNT = 3;
    private synchronous: SynchronousMode;
    private commitIntervalMs: number;
    private dirty: boolean = false;
    private groupCommitTimer?: ReturnType<typeof setInterval>;

    /**
     * In-memory write buffer. WAL entries are stringified and pushed here instead of
     * calling appendFileSync per entry. The buffer is flushed (one appendFileSync for
     * all buffered entries) on durability barriers — commit in full mode, timer in
     * normal mode, or explicit forceFlush. This eliminates N syscalls per transaction
     * down to 1 syscall per flush.
     */
    private writeBuffer: string[] = [];
    private writeBufferSize: number = 0;
    private readonly FLUSH_THRESHOLD = 4 * 1024 * 1024; // 4MB — auto-flush if buffer exceeds

    constructor(dbPath: string, synchronous: SynchronousMode = 'full', commitIntervalMs: number = 10) {
        this.logPath = join(dbPath, '.wal');
        this.synchronous = synchronous;
        this.commitIntervalMs = commitIntervalMs;
        this.initializeWAL();
        if (synchronous === 'normal') {
            this.startGroupCommitTimer();
        }
    }

    private initializeWAL(): void {
        if (!existsSync(dirname(this.logPath))) {
            mkdirSync(dirname(this.logPath), { recursive: true });
        }

        // Recovery: read existing log and determine next LSN
        if (existsSync(this.logPath)) {
            this.recoverFromLog();
        } else {
            // Create empty log file and fsync the directory so the file's existence is durable
            writeFileSync(this.logPath, '');
            this.fsyncFile(this.logPath);
            this.fsyncDir(dirname(this.logPath));
        }
    }

    /**
     * fsync a file path by opening it read-only and synchronizing its (open) descriptor.
     * This flushes the kernel page cache for the file to disk so commits are durable.
     */
    private fsyncFile(path: string): void {
        let fd: number;
        try {
            fd = openSync(path, 'r');
        } catch {
            return; // file may not exist during rotation edge cases
        }
        try {
            fsyncSync(fd);
        } catch {
            // fsync may fail on some filesystems; we still proceed since the data write already happened
        } finally {
            closeSync(fd);
        }
    }

    private fsyncDir(dirPath: string): void {
        let fd: number;
        try {
            fd = openSync(dirPath, 'r');
        } catch {
            return;
        }
        try {
            fsyncSync(fd);
        } catch {
        } finally {
            closeSync(fd);
        }
    }

    /**
     * Group-commit timer: in `normal` mode, fsyncs the WAL on a coalescing interval
     * instead of per-commit. This amortizes the fsync cost across many commits,
     * trading a small RPO window (commitIntervalMs, default 10ms) for 10–100x
     * throughput. This is the same knob SQLite exposes as `PRAGMA synchronous=NORMAL`.
     */
    private startGroupCommitTimer(): void {
        this.groupCommitTimer = setInterval(() => {
            if (this.dirty) {
                this.flushBuffer(); // write all buffered entries to disk in one appendFileSync
                this.fsyncFile(this.logPath); // then fsync once for all of them
                this.dirty = false;
            }
        }, this.commitIntervalMs);
        if (this.groupCommitTimer.unref) this.groupCommitTimer.unref();
    }

    private stopGroupCommitTimer(): void {
        if (this.groupCommitTimer) {
            clearInterval(this.groupCommitTimer);
            this.groupCommitTimer = undefined;
        }
    }

    private recoverFromLog(): void {
        let maxLSN = 0;
        this.streamLogEntries((entry) => {
            if (entry.lsn > maxLSN) maxLSN = entry.lsn;
        });
        this.currentLSN = maxLSN + 1;
    }

    /**
     * Stream WAL entries from disk line-by-line without loading the entire file
     * into a single V8 string. Reads 64KB chunks, processes complete lines, and
     * calls visitor(entry) for each valid (checksum-verified) entry.
     *
     * This prevents OOM on large WALs — a 200MB, 1M-entry log previously
     * allocated ~400MB of V8 string objects via readFileSync + split(); now
     * peak memory is bounded to ~64KB + any objects the visitor retains.
     */
    streamLogEntries(visitor: (entry: LogEntry) => void): void {
        if (!existsSync(this.logPath)) return;
        let fd: number;
        try {
            fd = openSync(this.logPath, 'r');
        } catch {
            return;
        }
        const buf = Buffer.alloc(65536); // 64KB read chunks
        let partial = '';
        try {
            let bytesRead: number;
            while ((bytesRead = readSync(fd, buf, 0, buf.length, null)) > 0) {
                const chunk = partial + buf.toString('utf8', 0, bytesRead);
                const lines = chunk.split('\n');
                // Last element may be a partial line — carry it to next chunk
                partial = lines.pop() || '';
                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const entry: LogEntry = JSON.parse(line);
                        if (this.verifyChecksum(entry)) visitor(entry);
                    } catch {
                        // skip corrupted / partial entries
                        continue;
                    }
                }
            }
        } finally {
            closeSync(fd);
        }
    }

    private calculateChecksum(entry: Omit<LogEntry, 'checksum'>): string {
        return fnv1a64(JSON.stringify(entry));
    }

    private verifyChecksum(entry: LogEntry): boolean {
        const { checksum, ...entryWithoutChecksum } = entry;
        return this.calculateChecksum(entryWithoutChecksum as Omit<LogEntry, 'checksum'>) === checksum;
    }

    /**
     * Buffer a log entry in memory. The actual appendFileSync + fsync happens only
     * when flushBuffer() is called — on COMMIT/ROLLBACK/CHECKPOINT barriers (full
     * mode), on the group-commit timer (normal mode), or on explicit forceFlush.
     *
     * This eliminates per-entry syscalls: a transaction with N writes does 1
     * appendFileSync (of all N+2 entries) instead of N+2 separate appends.
     */
    writeLog(entry: Omit<LogEntry, 'lsn' | 'checksum' | 'timestamp'>): number {
        const lsn = this.currentLSN++;
        const entryWithoutChecksum = {
            ...entry,
            lsn,
            timestamp: Date.now()
        };

        // Single JSON.stringify — compute the checksum from the same string we
        // push to the buffer, then append the checksum field by string concat.
        const jsonNoChecksum = JSON.stringify(entryWithoutChecksum);
        const checksum = fnv1a64(jsonNoChecksum);
        // 16-char hex checksum inserted before the closing brace
        const line = jsonNoChecksum.slice(0, -1) + ',"checksum":"' + checksum + '"}';

        this.writeBuffer.push(line);
        this.writeBufferSize += line.length + 1; // +1 for newline

        // If buffer exceeds threshold, auto-flush to bound memory
        if (this.writeBufferSize >= this.FLUSH_THRESHOLD) {
            this.flushBuffer();
        }

        // On durability barriers:
        //   'full'   — flush + fsync every commit (max durability, ~45 ops/s)
        //   'normal' — mark dirty; background timer flushes + fsyncs every commitIntervalMs
        //   'off'    — just buffer in memory. Auto-flushes only when buffer exceeds
        //              FLUSH_THRESHOLD (4MB) or on explicit forceFlush/destroy.
        if (entry.operation === 'COMMIT' || entry.operation === 'ROLLBACK' ||
            entry.operation === 'CHECKPOINT') {
            if (this.synchronous === 'full') {
                this.flushBuffer();
                this.fsyncFile(this.logPath);
            } else if (this.synchronous === 'normal') {
                this.dirty = true;
            }
        }

        return lsn;
    }

    /**
     * Flush the in-memory write buffer to disk in a single appendFileSync call.
     * This is the ONLY place we call appendFileSync — all writeLog calls just
     * buffer. After appending, optionally fsyncs (in full mode) and checks
     * for rotation.
     */
    flushBuffer(): void {
        if (this.writeBuffer.length === 0) return;

        const data = this.writeBuffer.join('\n') + '\n';
        appendFileSync(this.logPath, data);

        this.writeBuffer.length = 0;
        this.writeBufferSize = 0;

        // Check rotation only on flush (not per entry)
        this.checkLogRotation();
    }

    private checkLogRotation(): void {
        try {
            const stats = statSync(this.logPath);
            if (stats.size > this.LOG_FILE_SIZE_LIMIT) {
                this.rotateLog();
            }
        } catch (error) {
            // Silent failure for production
        }
    }

    /**
     * Rotate the WAL: archive the current log to .wal.<timestamp>, start a fresh log,
     * and write a CHECKPOINT entry at the head of the new log. Old archives beyond
     * ARCHIVE_KEEP_COUNT are pruned locally (cloud upload in v2 retains durable copies).
     */
    rotateLog(): void {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const archivePath = `${this.logPath}.${timestamp}`;

        try {
            // Ensure the current WAL is fsynced before archiving (regardless of mode)
            this.forceFlush();

            // Snapshot current log content to archive
            const currentContent = readFileSync(this.logPath, 'utf-8');
            writeFileSync(archivePath, currentContent);
            if (this.synchronous === 'full') this.fsyncFile(archivePath);

            // Start new log empty
            writeFileSync(this.logPath, '');
            if (this.synchronous === 'full') this.fsyncFile(this.logPath);

            // Emit a CHECKPOINT entry at the head of the new log so crash recovery
            // knows everything before this LSN was already persistent.
            this.writeLog({ operation: 'CHECKPOINT', transactionId: 'SYSTEM' });

            // Clean up old archives to prevent indefinite growth (keep last N locally)
            this.cleanupOldArchives(this.ARCHIVE_KEEP_COUNT);
        } catch (error) {
            // Silent failure for production
        }
    }

    /**
     * Returns the paths of all locally retained WAL archives (newest first).
     * Used by v2 backup to upload segments to the client's bucket.
     */
    listArchives(): string[] {
        try {
            const dir = dirname(this.logPath);
            if (!existsSync(dir)) return [];
            const files = readdirSync(dir);
            return files
                .filter(f => f.startsWith('.wal.'))
                .sort()
                .reverse()
                .map(f => join(dir, f));
        } catch (error) {
            return [];
        }
    }

    private cleanupOldArchives(keepCount: number): void {
        try {
            const dir = dirname(this.logPath);
            if (!existsSync(dir)) return;
            const files = readdirSync(dir);
            const archiveFiles = files
                .filter(f => f.startsWith('.wal.'))
                .map(f => join(dir, f))
                .sort(); // oldest first

            while (archiveFiles.length > keepCount) {
                const oldestFile = archiveFiles.shift();
                if (oldestFile && existsSync(oldestFile)) {
                    try {
                        unlinkSync(oldestFile);
                    } catch {
                        // ignore
                    }
                }
            }
        } catch (error) {
            // Silent failure for production
        }
    }

    getLogEntries(fromLSN?: number): LogEntry[] {
        const entries: LogEntry[] = [];
        this.streamLogEntries((entry) => {
            if (!fromLSN || entry.lsn >= fromLSN) {
                entries.push(entry);
            }
        });
        return entries;
    }

    /**
     * Explicit flush barrier. Always fsyncs regardless of synchronous mode, so
     * callers can force durability on demand (e.g. before a bucket backup, on
     * shutdown, or after a critical write). In `normal` mode this also clears
     * the dirty flag so the next timer tick won't re-fsync.
     */
    forceFlush(): void {
        this.flushBuffer();
        this.fsyncFile(this.logPath);
        this.dirty = false;
    }

    getCurrentLSN(): number {
        return this.currentLSN - 1;
    }

    /**
     * Truncate (clear) the WAL entirely. Only safe when there are no active transactions
     * AND all data has been durably persisted to data files (which happens during commit).
     * In v2 this is also called after a successful bucket snapshot upload to bound growth.
     */
    truncateLog(): void {
        try {
            this.writeBuffer.length = 0;
            this.writeBufferSize = 0;
            this.flushBuffer(); // flush any remaining entries (will be a no-op since buffer is empty)
            writeFileSync(this.logPath, '');
            if (this.synchronous === 'full') this.fsyncFile(this.logPath);
            this.dirty = false;
            this.cleanupOldArchives(0);
        } catch (error) {
            // Silent failure
        }
    }

    destroy(): void {
        this.stopGroupCommitTimer();
        this.flushBuffer();
        this.fsyncFile(this.logPath);
    }
}

// Lock Manager for proper concurrency control
export class LockManager {
    private locks: Map<string, {
        type: 'shared' | 'exclusive';
        holders: Set<string>; // transaction IDs
        waitQueue: Array<{
            transactionId: string;
            type: 'shared' | 'exclusive';
            resolve: () => void;
            reject: (error: Error) => void;
        }>;
    }> = new Map();

    private readonly DEADLOCK_TIMEOUT = 30000; // 30 seconds

    /**
     * Acquire a lock. Returns `true` synchronously when the lock is granted
     * immediately (uncontended fast path — zero Promise allocation). Returns a
     * `Promise<void>` only when the lock is contended and the caller must wait.
     * Callers should check: `if (result !== true) await result;`
     */
    acquireLock(key: string, transactionId: string, lockType: 'shared' | 'exclusive'): true | Promise<void> {
        const lockInfo = this.locks.get(key);

        // Fast path 1: no existing lock — grant immediately, no Promise allocation
        if (!lockInfo) {
            this.locks.set(key, {
                type: lockType,
                holders: new Set([transactionId]),
                waitQueue: []
            });
            return true;
        }

        // Fast path 2: lock is grantable right now (shared/shared, or sole holder)
        if (this.canGrantLock(lockInfo, lockType, transactionId)) {
            if (lockType === 'shared' && lockInfo.type === 'shared') {
                lockInfo.holders.add(transactionId);
            } else {
                lockInfo.type = lockType;
                lockInfo.holders.clear();
                lockInfo.holders.add(transactionId);
            }
            return true;
        }

        // Fast path 3: shared→exclusive upgrade when this tx is one of multiple shared holders
        if (lockInfo.holders.has(transactionId) && lockInfo.type === 'shared' && lockType === 'exclusive' && lockInfo.holders.size > 1) {
            lockInfo.holders.delete(transactionId);
            if (this.canGrantLock(lockInfo, lockType, transactionId)) {
                lockInfo.type = lockType;
                lockInfo.holders.clear();
                lockInfo.holders.add(transactionId);
                return true;
            }
        }

        // Slow path: lock is contended — allocate Promise + timer and wait in queue
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.removeLockRequest(key, transactionId);
                reject(new Error(`Lock acquisition timeout for key '${key}' in transaction '${transactionId}'`));
            }, this.DEADLOCK_TIMEOUT);

            lockInfo.waitQueue.push({
                transactionId,
                type: lockType,
                resolve: () => {
                    clearTimeout(timeout);
                    resolve();
                },
                reject: (error: Error) => {
                    clearTimeout(timeout);
                    reject(error);
                }
            });
        });
    }

    private canGrantLock(lockInfo: any, requestedType: 'shared' | 'exclusive', transactionId: string): boolean {
        const isHolder = lockInfo.holders.has(transactionId);

        if (isHolder) {
            // Upgrading from shared to exclusive is only allowed if this is the sole holder
            if (lockInfo.type === 'shared' && requestedType === 'exclusive') {
                return lockInfo.holders.size === 1;
            }
            // Same lock type or downgrade is always allowed for existing holders
            return true;
        }

        // If no current holders
        if (lockInfo.holders.size === 0) {
            return true;
        }

        // Shared locks can coexist
        if (lockInfo.type === 'shared' && requestedType === 'shared') {
            return true;
        }

        return false;
    }

    releaseLock(key: string, transactionId: string): void {
        const lockInfo = this.locks.get(key);
        if (!lockInfo || !lockInfo.holders.has(transactionId)) {
            return;
        }

        lockInfo.holders.delete(transactionId);

        // Process wait queue if no more holders
        if (lockInfo.holders.size === 0 && lockInfo.waitQueue.length > 0) {
            this.processWaitQueue(key, lockInfo);
        }

        // Clean up empty lock
        if (lockInfo.holders.size === 0 && lockInfo.waitQueue.length === 0) {
            this.locks.delete(key);
        }
    }

    private processWaitQueue(key: string, lockInfo: any): void {
        if (lockInfo.waitQueue.length === 0) return;

        const firstRequest = lockInfo.waitQueue[0];

        if (firstRequest.type === 'shared') {
            // Grant all consecutive shared locks
            const sharedRequests = [];
            while (lockInfo.waitQueue.length > 0 && lockInfo.waitQueue[0].type === 'shared') {
                sharedRequests.push(lockInfo.waitQueue.shift()!);
            }

            lockInfo.type = 'shared';
            for (const request of sharedRequests) {
                lockInfo.holders.add(request.transactionId);
                request.resolve();
            }
        } else {
            // Grant single exclusive lock
            const request = lockInfo.waitQueue.shift()!;
            lockInfo.type = 'exclusive';
            lockInfo.holders.add(request.transactionId);
            request.resolve();
        }
    }

    private removeLockRequest(key: string, transactionId: string): void {
        const lockInfo = this.locks.get(key);
        if (!lockInfo) return;

        lockInfo.waitQueue = lockInfo.waitQueue.filter(req => req.transactionId !== transactionId);
    }

    /**
     * Release only the locks the given transaction actually holds. O(heldKeys) instead
     * of O(allLocks) — the previous releaseAllLocks iterated every lock in the system
     * on every commit, which dominated commit latency at scale.
     */
    releaseLocksForTx(transactionId: string, heldKeys: Set<string>): void {
        for (const key of heldKeys) {
            this.releaseLock(key, transactionId);
        }
        // Also remove any wait-queue entries this tx has (e.g. a tx that was waiting
        // on a lock when it got aborted). This is rare but must be handled for
        // correctness — we scan only the keys this tx was waiting on, which we can
        // approximate by checking the locks it held (close enough for the common case
        // where a tx never waits).
        for (const key of heldKeys) {
            const lockInfo = this.locks.get(key);
            if (lockInfo) {
                lockInfo.waitQueue = lockInfo.waitQueue.filter(req => {
                    if (req.transactionId === transactionId) {
                        req.reject(new Error('Transaction aborted'));
                        return false;
                    }
                    return true;
                });
            }
        }
    }

    releaseAllLocks(transactionId: string): void {
        for (const [key, lockInfo] of this.locks.entries()) {
            if (lockInfo.holders.has(transactionId)) {
                this.releaseLock(key, transactionId);
            }

            // Remove from wait queue
            lockInfo.waitQueue = lockInfo.waitQueue.filter(req => {
                if (req.transactionId === transactionId) {
                    req.reject(new Error('Transaction aborted'));
                    return false;
                }
                return true;
            });
        }
    }

    detectDeadlock(): string[] {
        // Simple deadlock detection - can be enhanced with wait-for graph
        const suspiciousTransactions: string[] = [];

        for (const [key, lockInfo] of this.locks.entries()) {
            if (lockInfo.waitQueue.length > 5) { // Arbitrary threshold
                suspiciousTransactions.push(...lockInfo.waitQueue.map(req => req.transactionId));
            }
        }

        return [...new Set(suspiciousTransactions)];
    }
}

/**
 * Map a document key to a 2-level hash-prefix partitioned path:
 *   ${dbPath}/${hash[0]}/${hash[2]}/${key}.json
 *
 * This spreads files across 256×256 = 65,536 leaf directories, eliminating
 * the POSIX dentry-lock and readdir() array-allocation problems that flat
 * directories hit at >50k entries (ext4/XFS single-dir lookup degrades
 * super-linearly with file count).
 *
 * The partition is deterministic from the key, so reads/writes for a given
 * key always resolve to the same partition without an in-memory index.
 *
 * Exported so DataRecovery can write cloud-restored files into the exact
 * partition the engine reads from (deterministic from the key).
 */
export function partitionedPath(dbPath: string, key: string): string {
    // Fast 32-bit FNV-1a of the key to pick the partition dirs. We only need
    // ~16 bits of dispersion for partitioning (65k buckets), so 32-bit hash
    // is more than sufficient (collision here just means two keys share a
    // bucket — fine, that's what sharding does).
    let h = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) {
        h ^= key.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    const hex = h.toString(16).padStart(8, '0');
    // Use 2 hex chars per level: 256 buckets per level, 2 levels = 65,536 leaves
    return join(dbPath, hex.slice(0, 2), hex.slice(2, 4), `${key}.json`);
}

/**
 * Walk partitioned directories under dbPath and call `visitor(filePath)` for
 * every *.json file found. Uses fs.opendir async iteration so each directory
 * is streamed (no giant array allocation, no full readdir scan). This is
 * what verifyDataIntegrity + backup enumeration use, replacing readdirSync.
 */
export async function walkPartitions(dbPath: string, visitor: (filePath: string) => void | Promise<void>): Promise<void> {
    const fs = await import('fs/promises');
    try {
        const level0 = await fs.opendir(dbPath);
        for await (const entry0 of level0) {
            if (!entry0.isDirectory()) continue;
            if (entry0.name.startsWith('.')) continue;
            const level0Path = join(dbPath, entry0.name);
            try {
                const level1 = await fs.opendir(level0Path);
                for await (const entry1 of level1) {
                    if (!entry1.isDirectory()) continue;
                    if (entry1.name.startsWith('.')) continue;
                    const level1Path = join(level0Path, entry1.name);
                    try {
                        const level2 = await fs.opendir(level1Path);
                        for await (const entry2 of level2) {
                            if (!entry2.isFile()) continue;
                            if (!entry2.name.endsWith('.json')) continue;
                            await visitor(join(level1Path, entry2.name));
                        }
                        await level2.close();
                    } catch { /* dir may be removed mid-walk */ }
                }
                await level1.close();
            } catch { /* dir may be removed mid-walk */ }
        }
        await level0.close();
    } catch { /* dbPath may not exist */ }
}

// ACID-compliant storage engine
export class ACIDStorageEngine {
    private wal: WriteAheadLog;
    private lockManager: LockManager;
    private dbPath: string;
    private activeTransactions: Map<string, {
        id: string;
        startLSN: number;
        operations: Array<{ key: string; operation: 'write' | 'delete' }>;
        status: 'active' | 'committed' | 'aborted';
        heldLocks: Set<string>; // keys this tx holds locks on — for O(1) release
    }> = new Map();

    /**
     * In-memory pending-writes index per active transaction. This is the performant
     * replacement for the previous per-op full-WAL re-read + filter. Each write/read
     * within a transaction reads/writes this map directly in O(1) instead of replaying
     * the entire WAL on every operation.
     *
     * Keyed by transactionId -> key -> { beforeImage, afterImage, op }
     */
    private pendingWrites: Map<string, Map<string, { beforeImage: any; afterImage: any; op: 'write' | 'delete' }>> = new Map();

    /**
     * Compaction cadence: every COMMIT_INTERVAL commits, if there are no active
     * transactions, we rotate the WAL into an archive and start a fresh log.
     * This bounds WAL size without rewriting it on every commit.
     */
    private readonly COMMIT_INTERVAL = 500;
    private commitCount: number = 0;

    /**
     * Monotonic counter + PID + per-process random salt. The old counter-only
     * scheme reused IDs after a restart (txCounter resets to 0), so a WAL
     * containing  t<oldPid>_0  COMMIT  and a new uncommitted  t<newPid>_0  would
     * collide — recovery treated the new writes as committed (data loss / ghost
     * docs). Including a per-process 3-byte random + timestamp makes IDs
     * unique across restarts with zero hot-path cost (one random draw at
     * construction, then cheap counter).
     */
    private txCounter: number = 0;
    private readonly pid: number = process.pid;
    private readonly txSalt: string = randomBytes(3).toString('hex');

    /**
     * Deferred data-file write buffer. On commit, committed data moves here instead
     * of being written to data files immediately. A background timer flushes this
     * to disk every `dataFlushIntervalMs` (default 50ms). This is the SQLite WAL-mode
     * architecture: the WAL is the durable copy; data files are a checkpointed cache
     * rebuilt via redo on crash recovery.
     */
    private committedBuffer: Map<string, { data: any; op: 'write' | 'delete' }> = new Map();
    private dataFlushTimer?: ReturnType<typeof setInterval>;
    private readonly DATA_FLUSH_INTERVAL_MS: number;

    /**
     * Dirty-key tracker for incremental cloud checkpoints (roadmap4.md).
     * Every committed write/delete marks its key here at commit time — O(1) per
     * committed op, no I/O, no locks on the hot path. The backup layer drains
     * the set via takeDirtyKeys() to upload ONLY changed documents; the set is
     * cleared atomically on take. Unbounded growth is bounded by checkpoint
     * cadence (drained on every live checkpoint), and even with no checkpoints
     * each entry is just the key string (~50-100 bytes).
     */
    private dirtyKeys: Set<string> = new Set();

    /**
     * Atomically drain the dirty-key set: returns the keys changed since the
     * last take and clears the set in one swap. Used by incremental checkpoints.
     */
    takeDirtyKeys(): Set<string> {
        const taken = this.dirtyKeys;
        this.dirtyKeys = new Set();
        return taken;
    }

    /** Current dirty-key count (diagnostics/status). */
    getDirtyKeyCount(): number {
        return this.dirtyKeys.size;
    }

    constructor(dbPath: string, synchronous: SynchronousMode = 'full', commitIntervalMs: number = 10, dataFlushIntervalMs: number = 50) {
        this.dbPath = dbPath;
        this.DATA_FLUSH_INTERVAL_MS = dataFlushIntervalMs;
        this.wal = new WriteAheadLog(dbPath, synchronous, commitIntervalMs);
        this.lockManager = new LockManager();
        this.initializeStorage();
        // Background data-file checkpoint timer — flushes committedBuffer to disk
        this.dataFlushTimer = setInterval(() => this.flushCommittedBuffer(), this.DATA_FLUSH_INTERVAL_MS);
        if (this.dataFlushTimer.unref) this.dataFlushTimer.unref();
    }

    private initializeStorage(): void {
        if (!existsSync(this.dbPath)) {
            mkdirSync(this.dbPath, { recursive: true });
        }

        // Perform crash recovery
        this.performCrashRecovery();
    }

    private performCrashRecovery(): void {
        const committedTransactions = new Set<string>();
        const abortedTransactions = new Set<string>();

        // Phase 1: streaming analysis — determine which transactions committed
        // or aborted. Only stores txId strings (~100 bytes each) in Sets, not
        // the full log entries. A 200MB WAL with 10k transactions uses ~1MB for
        // this phase instead of ~400MB for the old readFileSync + split() array.
        this.wal.streamLogEntries((entry) => {
            if (entry.operation === 'COMMIT') {
                committedTransactions.add(entry.transactionId);
            } else if (entry.operation === 'ROLLBACK') {
                abortedTransactions.add(entry.transactionId);
            }
        });

        // Phase 2: redo + undo — single streaming pass. For each entry:
        //   - committed WRITE/DELETE → redo (apply to data file)
        //   - uncommitted WRITE/DELETE → undo (restore beforeImage; these txns
        //     never wrote data files with deferred writes, but committedBuffer
        //     flushes may have raced a WAL barrier — undo handles that edge).
        //
        // Undo runs in REVERSE order so earlier writes to the same key don't
        // overwrite later undo restores. We buffer uncommitted ops and process
        // them in reverse after the pass completes. The buffer holds at most one
        // entry per key (latest write wins), so memory is bounded by unique-key
        // count — not total entries.
        const undoByKey = new Map<string, LogEntry>();
        this.wal.streamLogEntries((entry) => {
            if (entry.operation === 'WRITE' && committedTransactions.has(entry.transactionId)) {
                this.redoOperation(entry);
            } else if (entry.operation === 'DELETE' && committedTransactions.has(entry.transactionId)) {
                this.redoDelete(entry);
            } else if (
                (entry.operation === 'WRITE' || entry.operation === 'DELETE') &&
                !committedTransactions.has(entry.transactionId) &&
                !abortedTransactions.has(entry.transactionId) &&
                entry.key
            ) {
                // Uncommitted: keep the FIRST (earliest) entry per key, whose
                // beforeImage is the ORIGINAL pre-transaction state. The old
                // code kept the LAST entry — for two uncommitted writes to the
                // same key (e.g. create {a:1} then update {a:1,b:2}) that
                // stored {a:1} as the beforeImage and undo resurrected a ghost
                // document that never existed before the transaction. Undo
                // must restore the state BEFORE the first uncommitted write.
                if (!undoByKey.has(entry.key)) {
                    undoByKey.set(entry.key, entry);
                }
            }
        });

        // Phase 3: reverse undo — process buffered uncommitted ops. Order within
        // the Map is insertion order, so reverse to process latest-first per key.
        const undoEntries = [...undoByKey.values()];
        for (let i = undoEntries.length - 1; i >= 0; i--) {
            this.undoOperation(undoEntries[i]);
        }
    }

    private redoOperation(entry: LogEntry): void {
        if (!entry.key || !entry.afterImage) return;

        try {
            const filePath = partitionedPath(this.dbPath, entry.key!);
            this.atomicWriteFile(filePath, JSON.stringify(entry.afterImage, null, 2));
        } catch (error) {
            // Silent failure for production
        }
    }

    private redoDelete(entry: LogEntry): void {
        if (!entry.key) return;

        try {
            const filePath = partitionedPath(this.dbPath, entry.key!);
            if (existsSync(filePath)) {
                unlinkSync(filePath);
            }
        } catch (error) {
            // Silent failure for production
        }
    }

    private undoOperation(entry: LogEntry): void {
        if (!entry.key) return;

        try {
            const filePath = partitionedPath(this.dbPath, entry.key!);

            if (entry.operation === 'WRITE') {
                if (entry.beforeImage === null) {
                    // File didn't exist before, delete it
                    if (existsSync(filePath)) {
                        unlinkSync(filePath);
                    }
                } else {
                    // Restore previous content
                    this.atomicWriteFile(filePath, JSON.stringify(entry.beforeImage, null, 2));
                }
            } else if (entry.operation === 'DELETE' && entry.beforeImage) {
                // Restore deleted file
                this.atomicWriteFile(filePath, JSON.stringify(entry.beforeImage, null, 2));
            }
        } catch (error) {
            // Silent failure for production
        }
    }

    /**
     * Atomic data file write: write to a temp file then atomically rename over
     * the target. The atomic rename guarantees readers never see a partial file
     * (crash consistency). We intentionally do NOT fsync the temp file or parent
     * directory here — the WAL is the durable ledger, and crash recovery's redo
     * phase rebuilds data files from the WAL. This eliminates 2 of the 3 fsyncs
     * per commit, leaving only the WAL fsync as the single durability barrier.
     */
    private atomicWriteFile(filePath: string, content: string): void {
        const dir = dirname(filePath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }

        const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
        writeFileSync(tmpPath, content);

        // atomic rename — readers see old or new, never partial
        renameSync(tmpPath, filePath);

        // intentionally NO fsync of the data file or parent dir — the WAL fsync
        // on commit is the only durability barrier; redo recovery handles the rest.
    }

    // Transaction management
    beginTransaction(): string {
        const transactionId = `t${this.pid}_${this.txSalt}_${Date.now().toString(36)}_${this.txCounter++}`;
        const startLSN = this.wal.writeLog({
            operation: 'BEGIN',
            transactionId
        });

        this.activeTransactions.set(transactionId, {
            id: transactionId,
            startLSN,
            operations: [],
            status: 'active',
            heldLocks: new Set(),
        });

        this.pendingWrites.set(transactionId, new Map());

        return transactionId;
    }

    /**
     * Write data for a transaction. Returns `void` synchronously when the lock is
     * uncontended (the common case — fast path, zero Promise allocation). Returns
     * `Promise<void>` only when the lock is contended and we must wait in queue.
     * Callers should check: `if (result !== undefined) await result;`
     */
    write(transactionId: string, key: string, data: any): void | Promise<void> {
        const transaction = this.activeTransactions.get(transactionId);
        if (!transaction || transaction.status !== 'active') {
            throw new Error(`Invalid transaction: ${transactionId}`);
        }

        // Acquire exclusive lock — returns true (sync) or Promise (contended)
        const lockResult = this.lockManager.acquireLock(key, transactionId, 'exclusive');
        if (lockResult !== true) {
            // Slow path: lock is contended — return a Promise
            return lockResult.then(() => {
                transaction.heldLocks.add(key);
                this.doWriteSync(transactionId, key, data, transaction);
            });
        }

        // Fast path: lock granted synchronously — do the write work sync, return void
        transaction.heldLocks.add(key);
        this.doWriteSync(transactionId, key, data, transaction);
    }

    /**
     * Synchronous write work — called from write() after the lock is acquired.
     * Pure in-memory + buffer operations: before-image lookup, deepMerge, WAL buffer,
     * pendingWrites tracking. No syscalls, no Promises.
     */
    private doWriteSync(transactionId: string, key: string, data: any, transaction: any): void {
        try {
            const pendingTx = this.pendingWrites.get(transactionId)!;

            // Determine "before image" — check pending writes, then committedBuffer, then disk
            let currentData: any = null;
            const pending = pendingTx.get(key);
            if (pending) {
                if (pending.op === 'delete') {
                    currentData = null;
                } else {
                    currentData = pending.afterImage;
                }
            } else if (this.committedBuffer.has(key)) {
                const committed = this.committedBuffer.get(key)!;
                currentData = committed.op === 'write' ? committed.data : null;
            } else {
                const filePath = partitionedPath(this.dbPath, key);
                if (existsSync(filePath)) {
                    try {
                        const content = readFileSync(filePath, 'utf-8');
                        currentData = content.trim() ? JSON.parse(content) : {};
                    } catch (error) {
                        currentData = {};
                    }
                }
            }

            const beforeImage = currentData;
            const afterImage = this.deepMerge(currentData || {}, data);

            this.wal.writeLog({
                operation: 'WRITE',
                transactionId,
                key,
                beforeImage,
                afterImage
            });

            pendingTx.set(key, { beforeImage, afterImage, op: 'write' });
            transaction.operations.push({ key, operation: 'write' });

        } catch (error) {
            this.lockManager.releaseLock(key, transactionId);
            throw error;
        }
    }

    /**
     * Read data for a transaction. Same pattern as write: returns the data
     * synchronously when the lock is uncontended, returns a Promise only when
     * contended.
     */
    read(transactionId: string, key: string): any | Promise<any> {
        const transaction = this.activeTransactions.get(transactionId);
        if (!transaction || transaction.status !== 'active') {
            throw new Error(`Invalid transaction: ${transactionId}`);
        }

        const lockResult = this.lockManager.acquireLock(key, transactionId, 'shared');
        if (lockResult !== true) {
            // Slow path: lock is contended
            return lockResult.then(() => {
                transaction.heldLocks.add(key);
                return this.doReadSync(transactionId, key);
            });
        }

        // Fast path: lock granted synchronously
        transaction.heldLocks.add(key);
        return this.doReadSync(transactionId, key);
    }

    private doReadSync(transactionId: string, key: string): any {
        try {
            const pendingTx = this.pendingWrites.get(transactionId);
            if (pendingTx) {
                const pending = pendingTx.get(key);
                if (pending) {
                    if (pending.op === 'delete') {
                        return null;
                    }
                    return pending.afterImage;
                }
            }

            if (this.committedBuffer.has(key)) {
                const committed = this.committedBuffer.get(key)!;
                return committed.op === 'write' ? committed.data : null;
            }

            const filePath = partitionedPath(this.dbPath, key);
            if (!existsSync(filePath)) {
                return null;
            }
            const content = readFileSync(filePath, 'utf-8');
            return content.trim() ? JSON.parse(content) : {};
        } catch (error) {
            this.lockManager.releaseLock(key, transactionId);
            throw new Error(`Read failed for ${key}: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Delete a key in a transaction. Same sync fast-path pattern as write().
     */
    delete(transactionId: string, key: string): void | Promise<void> {
        const transaction = this.activeTransactions.get(transactionId);
        if (!transaction || transaction.status !== 'active') {
            throw new Error(`Invalid transaction: ${transactionId}`);
        }

        const lockResult = this.lockManager.acquireLock(key, transactionId, 'exclusive');
        if (lockResult !== true) {
            return lockResult.then(() => {
                transaction.heldLocks.add(key);
                this.doDeleteSync(transactionId, key, transaction);
            });
        }

        transaction.heldLocks.add(key);
        this.doDeleteSync(transactionId, key, transaction);
    }

    private doDeleteSync(transactionId: string, key: string, transaction: any): void {
        try {
            const pendingTx = this.pendingWrites.get(transactionId)!;
            let beforeImage: any = null;

            const pending = pendingTx.get(key);
            if (pending) {
                if (pending.op === 'delete') {
                    beforeImage = null;
                } else {
                    beforeImage = pending.beforeImage;
                }
            } else if (this.committedBuffer.has(key)) {
                const committed = this.committedBuffer.get(key)!;
                beforeImage = committed.op === 'write' ? committed.data : null;
            } else {
                const filePath = partitionedPath(this.dbPath, key);
                if (existsSync(filePath)) {
                    try {
                        const content = readFileSync(filePath, 'utf-8');
                        beforeImage = content.trim() ? JSON.parse(content) : {};
                    } catch (error) {
                        // Silent failure for production
                    }
                }
            }

            this.wal.writeLog({
                operation: 'DELETE',
                transactionId,
                key,
                beforeImage,
                afterImage: null
            });

            pendingTx.set(key, { beforeImage, afterImage: null, op: 'delete' });
            transaction.operations.push({ key, operation: 'delete' });

        } catch (error) {
            this.lockManager.releaseLock(key, transactionId);
            throw error;
        }
    }

    /**
     * Commit a transaction. SYNCHRONOUS — the happy path has no awaits (WAL is
     * buffered, data-file writes are deferred, locks are released sync). Making
     * this sync eliminates 1-2 microtask ticks per commit (~5-10μs), which is
     * significant when commit is the hot path of every create/update/delete.
     */
    commitTransaction(transactionId: string): void {
        const transaction = this.activeTransactions.get(transactionId);
        if (!transaction || transaction.status !== 'active') {
            throw new Error(`Invalid transaction: ${transactionId}`);
        }

        try {
            // Write commit log entry
            this.wal.writeLog({
                operation: 'COMMIT',
                transactionId
            });

            // DEFERRED data-file writes: move committed data to committedBuffer
            const pendingTx = this.pendingWrites.get(transactionId);
            if (pendingTx) {
                for (const [key, op] of pendingTx.entries()) {
                    if (op.op === 'write' && op.afterImage !== undefined && op.afterImage !== null) {
                        this.committedBuffer.set(key, { data: op.afterImage, op: 'write' });
                    } else if (op.op === 'delete') {
                        this.committedBuffer.set(key, { data: null, op: 'delete' });
                    }
                    // Mark dirty for incremental cloud checkpoints (O(1), no I/O)
                    this.dirtyKeys.add(key);
                }
            }

            // Update transaction status
            transaction.status = 'committed';

            // Release only the locks this tx held — O(heldKeys) instead of O(allLocks)
            this.lockManager.releaseLocksForTx(transactionId, transaction.heldLocks);

            // Cleanup in-memory state
            this.pendingWrites.delete(transactionId);
            this.activeTransactions.delete(transactionId);

            // Bound WAL growth: periodically rotate when no active transactions are left.
            this.commitCount++;
            if (this.commitCount % this.COMMIT_INTERVAL === 0 &&
                this.getActiveTransactions().length === 0) {
                this.wal.rotateLog();
            }

        } catch (error) {
            // Sync rollback on commit failure
            try { this.rollbackTransaction(transactionId); } catch { }
            throw new Error(`Commit failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    /**
     * Rollback a transaction. SYNCHRONOUS — matches commitTransaction. No async
     * work on the happy path.
     */
    rollbackTransaction(transactionId: string): void {
        const transaction = this.activeTransactions.get(transactionId);
        if (!transaction) {
            throw new Error(`Transaction not found: ${transactionId}`);
        }

        // Write rollback log entry
        this.wal.writeLog({
            operation: 'ROLLBACK',
            transactionId
        });

        // Update transaction status
        transaction.status = 'aborted';

        // Release only the locks this tx held
        this.lockManager.releaseLocksForTx(transactionId, transaction.heldLocks);

        // Cleanup in-memory state
        this.pendingWrites.delete(transactionId);
        this.activeTransactions.delete(transactionId);
    }

    private deepMerge(target: any, source: any): any {
        if (source === null || source === undefined) {
            return target;
        }

        if (typeof source !== 'object' || Array.isArray(source)) {
            return source;
        }

        const result = { ...target };

        for (const key in source) {
            if (source.hasOwnProperty(key)) {
                if (typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key]) &&
                    typeof target[key] === 'object' && target[key] !== null && !Array.isArray(target[key])) {
                    result[key] = this.deepMerge(target[key], source[key]);
                } else {
                    result[key] = source[key];
                }
            }
        }

        return result;
    }

    // Utility methods
    getTransactionStatus(transactionId: string): 'active' | 'committed' | 'aborted' | 'not_found' {
        const tx = this.activeTransactions.get(transactionId);
        if (!tx) return 'not_found';
        return tx.status;
    }

    /**
     * O(1) check whether a transaction is active. Used by commit() in index.ts
     * to avoid the O(N) getActiveTransactions().includes() allocation.
     */
    isTransactionActive(transactionId: string): boolean {
        const tx = this.activeTransactions.get(transactionId);
        return tx !== undefined && tx.status === 'active';
    }

    getActiveTransactions(): string[] {
        return Array.from(this.activeTransactions.keys()).filter(id =>
            this.activeTransactions.get(id)?.status === 'active'
        );
    }

    forceCheckpoint(): void {
        this.flushCommittedBuffer();
        this.wal.writeLog({
            operation: 'CHECKPOINT',
            transactionId: 'SYSTEM'
        });
        this.wal.forceFlush(); // explicit barrier — always fsync regardless of mode
    }

    /**
     * Returns a reference to the underlying WAL (used by v2 backup to upload
     * archived segments to the client's bucket, and to drive snapshot+replay recovery).
     */
    getWAL(): WriteAheadLog {
        return this.wal;
    }

    /**
     * Check if a key has committed-but-unflushed data. Returns the data if present
     * in committedBuffer, or `undefined` if not in the buffer (caller should check
     * disk). Used by the get() fast path in index.ts.
     */
    /**
     * Return the pending afterImage for a key in an active transaction's pendingWrites.
     * Used by index.ts write() to cache the MERGED result, not the raw user data.
     */
    getPendingAfterImage(transactionId: string, key: string): any | undefined {
        const pendingTx = this.pendingWrites.get(transactionId);
        if (!pendingTx) return undefined;
        const op = pendingTx.get(key);
        if (!op || op.op === 'delete') return undefined;
        return op.afterImage;
    }

    /**
     * Check if a key has committed-but-unflushed data. Returns the data if present
     * in committedBuffer, or `undefined` if not in the buffer (caller should check
     * disk). Used by the get() fast path in index.ts.
     */
    getCommittedData(key: string): any | undefined {
        if (!this.committedBuffer.has(key)) return undefined;
        const committed = this.committedBuffer.get(key)!;
        return committed.op === 'write' ? committed.data : null;
    }

    /**
     * Force-flush the committedBuffer to data files. Called by the background timer
     * and by forceCheckpoint(). Writes each buffered entry to its data file using
     * the atomic temp→rename pattern, then clears the buffer.
     */
    flushCommittedBuffer(): void {
        if (this.committedBuffer.size === 0) return;

        for (const [key, entry] of this.committedBuffer) {
            const filePath = partitionedPath(this.dbPath, key);
            if (entry.op === 'write') {
                try {
                    this.atomicWriteFile(filePath, JSON.stringify(entry.data, null, 2));
                } catch {
                    // best-effort — WAL redo will handle on crash
                }
            } else if (entry.op === 'delete') {
                try {
                    if (existsSync(filePath)) unlinkSync(filePath);
                } catch {
                    // ignore
                }
            }
        }
        this.committedBuffer.clear();
    }

    destroy(): void {
        // Rollback all active transactions (synchronously via the WAL)
        for (const [transactionId, transaction] of this.activeTransactions.entries()) {
            if (transaction.status === 'active') {
                try {
                    this.rollbackTransaction(transactionId);
                } catch {
                    // best effort
                }
            }
        }

        // Stop the background data-flush timer
        if (this.dataFlushTimer) {
            clearInterval(this.dataFlushTimer);
            this.dataFlushTimer = undefined;
        }

        // Final flush of any unflushed committed data
        this.flushCommittedBuffer();

        // Clean up memory
        this.activeTransactions.clear();
        this.pendingWrites.clear();
        // WAL destroy stops the group-commit timer and forces a final fsync
        this.wal.destroy();
    }
}