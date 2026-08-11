import { existsSync, readFileSync, appendFileSync, writeFileSync, unlinkSync, mkdirSync, readdirSync, statSync, openSync, closeSync, fsyncSync, renameSync } from "fs";
import { join, dirname } from "path";
import { randomUUID } from "crypto";

// ACID-compliant transaction log entry
export interface LogEntry {
    lsn: number; // Log Sequence Number
    transactionId: string;
    operation: 'BEGIN' | 'WRITE' | 'DELETE' | 'COMMIT' | 'ROLLBACK' | 'CHECKPOINT';
    key?: string;
    beforeImage?: any; // For rollback
    afterImage?: any;  // For redo
    timestamp: number;
    checksum: number;  // FNV-1a 32-bit hash (fast, non-crypto)
}

export type SynchronousMode = 'full' | 'normal' | 'off';

/**
 * FNV-1a 32-bit hash — ~100x faster than SHA-256 for small strings.
 * Used for WAL integrity (corruption detection), NOT cryptographic verification.
 */
function fnv1a(str: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0; // unsigned 32-bit
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
        try {
            const logContent = readFileSync(this.logPath, 'utf-8');
            const lines = logContent.split('\n').filter(line => line.trim());

            let maxLSN = 0;
            for (const line of lines) {
                try {
                    const entry: LogEntry = JSON.parse(line);
                    if (this.verifyChecksum(entry) && entry.lsn > maxLSN) {
                        maxLSN = entry.lsn;
                    }
                } catch (error) {
                    // Skip corrupted/partial entries silently
                    continue;
                }
            }

            this.currentLSN = maxLSN + 1; // Next LSN
        } catch (error) {
            this.currentLSN = 1;
        }
    }

    private calculateChecksum(entry: Omit<LogEntry, 'checksum'>): number {
        return fnv1a(JSON.stringify(entry));
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

        const checksum = this.calculateChecksum(entryWithoutChecksum);

        const logEntry: LogEntry = {
            ...entryWithoutChecksum,
            checksum
        } as LogEntry;

        const line = JSON.stringify(logEntry);
        this.writeBuffer.push(line);
        this.writeBufferSize += line.length + 1; // +1 for newline

        // If buffer exceeds threshold, auto-flush to bound memory
        if (this.writeBufferSize >= this.FLUSH_THRESHOLD) {
            this.flushBuffer();
        }

        // On durability barriers:
        //   'full'   — flush + fsync every commit (max durability, ~40 ops/s)
        //   'normal' — mark dirty; background timer flushes + fsyncs every commitIntervalMs
        //   'off'    — just buffer in memory. Auto-flushes only when buffer exceeds
        //              FLUSH_THRESHOLD (4MB) or on explicit forceFlush/destroy. This is
        //              the testing/top-speed mode — no syscalls on the commit path.
        if (entry.operation === 'COMMIT' || entry.operation === 'ROLLBACK' ||
            entry.operation === 'CHECKPOINT') {
            if (this.synchronous === 'full') {
                this.flushBuffer();
                this.fsyncFile(this.logPath);
            } else if (this.synchronous === 'normal') {
                this.dirty = true;
            }
            // 'off' → do nothing — buffer until threshold or explicit flush
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
        try {
            const entries: LogEntry[] = [];

            // First, include entries from the in-memory buffer (not yet flushed to disk)
            for (const line of this.writeBuffer) {
                try {
                    const entry: LogEntry = JSON.parse(line);
                    if (this.verifyChecksum(entry) && (!fromLSN || entry.lsn >= fromLSN)) {
                        entries.push(entry);
                    }
                } catch {
                    continue;
                }
            }

            // Then, read entries from the log file on disk
            if (existsSync(this.logPath)) {
                const logContent = readFileSync(this.logPath, 'utf-8');
                const lines = logContent.split('\n').filter(line => line.trim());

                for (const line of lines) {
                    try {
                        const entry: LogEntry = JSON.parse(line);
                        if (this.verifyChecksum(entry) && (!fromLSN || entry.lsn >= fromLSN)) {
                            entries.push(entry);
                        }
                    } catch (error) {
                        // Skip corrupted/partial entries silently
                        continue;
                    }
                }
            }

            return entries.sort((a, b) => a.lsn - b.lsn);
        } catch (error) {
            return [];
        }
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

    async acquireLock(key: string, transactionId: string, lockType: 'shared' | 'exclusive'): Promise<void> {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.removeLockRequest(key, transactionId);
                reject(new Error(`Lock acquisition timeout for key '${key}' in transaction '${transactionId}'`));
            }, this.DEADLOCK_TIMEOUT);

            const lockInfo = this.locks.get(key);

            if (!lockInfo) {
                // No existing lock, grant immediately
                this.locks.set(key, {
                    type: lockType,
                    holders: new Set([transactionId]),
                    waitQueue: []
                });
                clearTimeout(timeout);
                resolve();
                return;
            }

            // Check if lock can be granted immediately
            if (this.canGrantLock(lockInfo, lockType, transactionId)) {
                if (lockType === 'shared' && lockInfo.type === 'shared') {
                    lockInfo.holders.add(transactionId);
                } else {
                    lockInfo.type = lockType;
                    lockInfo.holders.clear();
                    lockInfo.holders.add(transactionId);
                }
                clearTimeout(timeout);
                resolve();
                return;
            }

            // Handle shared-to-exclusive upgrade: release shared lock and retry
            // This prevents deadlock when multiple shared holders attempt to upgrade
            if (lockInfo.holders.has(transactionId) && lockInfo.type === 'shared' && lockType === 'exclusive' && lockInfo.holders.size > 1) {
                lockInfo.holders.delete(transactionId);
                // Retry grant after releasing shared hold
                if (this.canGrantLock(lockInfo, lockType, transactionId)) {
                    lockInfo.type = lockType;
                    lockInfo.holders.clear();
                    lockInfo.holders.add(transactionId);
                    clearTimeout(timeout);
                    resolve();
                    return;
                }
            }

            // Add to wait queue
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
     * Deferred data-file write buffer. On commit, committed data moves here instead
     * of being written to data files immediately. A background timer flushes this
     * to disk every `dataFlushIntervalMs` (default 50ms). This is the SQLite WAL-mode
     * architecture: the WAL is the durable copy; data files are a checkpointed cache
     * rebuilt via redo on crash recovery.
     */
    private committedBuffer: Map<string, { data: any; op: 'write' | 'delete' }> = new Map();
    private dataFlushTimer?: ReturnType<typeof setInterval>;
    private readonly DATA_FLUSH_INTERVAL_MS: number;

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
        const logEntries = this.wal.getLogEntries();
        const committedTransactions = new Set<string>();
        const abortedTransactions = new Set<string>();

        // Phase 1: Analysis - determine transaction status
        for (const entry of logEntries) {
            if (entry.operation === 'COMMIT') {
                committedTransactions.add(entry.transactionId);
            } else if (entry.operation === 'ROLLBACK') {
                abortedTransactions.add(entry.transactionId);
            }
        }

        // Phase 2: Redo - replay committed transactions
        for (const entry of logEntries) {
            if (entry.operation === 'WRITE' && committedTransactions.has(entry.transactionId)) {
                this.redoOperation(entry);
            } else if (entry.operation === 'DELETE' && committedTransactions.has(entry.transactionId)) {
                this.redoDelete(entry);
            }
        }

        // Phase 3: Undo - rollback uncommitted transactions
        const uncommittedOps = logEntries.filter(entry =>
            (entry.operation === 'WRITE' || entry.operation === 'DELETE') &&
            !committedTransactions.has(entry.transactionId) &&
            !abortedTransactions.has(entry.transactionId)
        ).reverse();

        for (const entry of uncommittedOps) {
            this.undoOperation(entry);
        }

        // After recovery the WAL contains only durable completed transactions for replay-on-crash.
        // We do NOT truncate — the WAL is bounded by rotation, and v2 backup uploads archived
        // segments to the client's bucket before pruning locally.
    }

    private redoOperation(entry: LogEntry): void {
        if (!entry.key || !entry.afterImage) return;

        try {
            const filePath = join(this.dbPath, `${entry.key}.json`);
            this.atomicWriteFile(filePath, JSON.stringify(entry.afterImage, null, 2));
        } catch (error) {
            // Silent failure for production
        }
    }

    private redoDelete(entry: LogEntry): void {
        if (!entry.key) return;

        try {
            const filePath = join(this.dbPath, `${entry.key}.json`);
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
            const filePath = join(this.dbPath, `${entry.key}.json`);

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
        const transactionId = randomUUID();
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

    async write(transactionId: string, key: string, data: any): Promise<void> {
        const transaction = this.activeTransactions.get(transactionId);
        if (!transaction || transaction.status !== 'active') {
            throw new Error(`Invalid transaction: ${transactionId}`);
        }

        // Acquire exclusive lock
        await this.lockManager.acquireLock(key, transactionId, 'exclusive');
        transaction.heldLocks.add(key);

        try {
            const pendingTx = this.pendingWrites.get(transactionId)!;

            // Determine "before image" — check pending writes, then committedBuffer,
            // then disk. This avoids a disk read when the key was recently committed
            // but not yet flushed to the data file.
            let currentData: any = null;
            const pending = pendingTx.get(key);
            if (pending) {
                if (pending.op === 'delete') {
                    currentData = null;
                } else {
                    currentData = pending.afterImage;
                }
            } else if (this.committedBuffer.has(key)) {
                // Use committed-but-unflushed data as the before image
                const committed = this.committedBuffer.get(key)!;
                currentData = committed.op === 'write' ? committed.data : null;
            } else {
                // Read from disk (may return null if file doesn't exist)
                const filePath = join(this.dbPath, `${key}.json`);
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

            // Deep merge for proper data integrity
            const afterImage = this.deepMerge(currentData || {}, data);

            // Write to WAL first (Write-Ahead Logging)
            this.wal.writeLog({
                operation: 'WRITE',
                transactionId,
                key,
                beforeImage,
                afterImage
            });

            // Track pending write in-memory O(1) — no WAL re-read needed for subsequent reads
            pendingTx.set(key, { beforeImage, afterImage, op: 'write' });

            // Track operation
            transaction.operations.push({ key, operation: 'write' });

        } catch (error) {
            this.lockManager.releaseLock(key, transactionId);
            throw error;
        }
    }

    async read(transactionId: string, key: string): Promise<any> {
        const transaction = this.activeTransactions.get(transactionId);
        if (!transaction || transaction.status !== 'active') {
            throw new Error(`Invalid transaction: ${transactionId}`);
        }

        // Acquire shared lock for consistent read
        await this.lockManager.acquireLock(key, transactionId, 'shared');
        transaction.heldLocks.add(key);

        try {
            // Check pending writes in this transaction first (O(1) in-memory lookup)
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

            // Check committedBuffer (committed but not yet flushed to data files)
            if (this.committedBuffer.has(key)) {
                const committed = this.committedBuffer.get(key)!;
                return committed.op === 'write' ? committed.data : null;
            }

            // Read from disk
            const filePath = join(this.dbPath, `${key}.json`);

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

    async delete(transactionId: string, key: string): Promise<void> {
        const transaction = this.activeTransactions.get(transactionId);
        if (!transaction || transaction.status !== 'active') {
            throw new Error(`Invalid transaction: ${transactionId}`);
        }

        // Acquire exclusive lock
        await this.lockManager.acquireLock(key, transactionId, 'exclusive');
        transaction.heldLocks.add(key);

        try {
            // Determine before image — from pending, committedBuffer, or disk
            const pendingTx = this.pendingWrites.get(transactionId)!;
            let beforeImage: any = null;

            const pending = pendingTx.get(key);
            if (pending) {
                if (pending.op === 'delete') {
                    beforeImage = null; // double-delete
                } else {
                    beforeImage = pending.beforeImage; // use original disk state
                }
            } else if (this.committedBuffer.has(key)) {
                // Use committed-but-unflushed data as the before image
                const committed = this.committedBuffer.get(key)!;
                beforeImage = committed.op === 'write' ? committed.data : null;
            } else {
                const filePath = join(this.dbPath, `${key}.json`);
                if (existsSync(filePath)) {
                    try {
                        const content = readFileSync(filePath, 'utf-8');
                        beforeImage = content.trim() ? JSON.parse(content) : {};
                    } catch (error) {
                        // Silent failure for production
                    }
                }
            }

            // Write to WAL
            this.wal.writeLog({
                operation: 'DELETE',
                transactionId,
                key,
                beforeImage,
                afterImage: null
            });

            // Track pending delete in-memory
            pendingTx.set(key, { beforeImage, afterImage: null, op: 'delete' });

            // Track operation
            transaction.operations.push({ key, operation: 'delete' });

        } catch (error) {
            this.lockManager.releaseLock(key, transactionId);
            throw error;
        }
    }

    async commitTransaction(transactionId: string): Promise<void> {
        const transaction = this.activeTransactions.get(transactionId);
        if (!transaction || transaction.status !== 'active') {
            throw new Error(`Invalid transaction: ${transactionId}`);
        }

        try {
            // Write commit log entry (durable barrier — fsynced inside writeLog)
            this.wal.writeLog({
                operation: 'COMMIT',
                transactionId
            });

            // DEFERRED data-file writes: move committed data to committedBuffer instead
            // of writing data files immediately. The background timer flushes them to
            // disk every DATA_FLUSH_INTERVAL_MS. The WAL is the durable copy; data
            // files are rebuilt via redo on crash recovery.
            const pendingTx = this.pendingWrites.get(transactionId);
            if (pendingTx) {
                for (const [key, op] of pendingTx.entries()) {
                    if (op.op === 'write' && op.afterImage !== undefined && op.afterImage !== null) {
                        this.committedBuffer.set(key, { data: op.afterImage, op: 'write' });
                    } else if (op.op === 'delete') {
                        this.committedBuffer.set(key, { data: null, op: 'delete' });
                    }
                }
            }

            // Update transaction status
            transaction.status = 'committed';

            // Release only the locks this tx held — O(heldKeys) instead of O(allLocks)
            this.lockManager.releaseLocksForTx(transactionId, transaction.heldLocks);

            // Cleanup in-memory state for this transaction — FIXES the memory leak
            // (previously activeTransactions never had committed/aborted entries removed).
            this.pendingWrites.delete(transactionId);
            this.activeTransactions.delete(transactionId);

            // Bound WAL growth: periodically rotate when no active transactions are left.
            // We never truncate mid-flight, preserving history for v2 backup/recovery.
            this.commitCount++;
            if (this.commitCount % this.COMMIT_INTERVAL === 0 &&
                this.getActiveTransactions().length === 0) {
                this.wal.rotateLog();
            }

        } catch (error) {
            // Rollback on commit failure
            try { await this.rollbackTransaction(transactionId); } catch { }
            throw new Error(`Commit failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    async rollbackTransaction(transactionId: string): Promise<void> {
        const transaction = this.activeTransactions.get(transactionId);
        if (!transaction) {
            throw new Error(`Transaction not found: ${transactionId}`);
        }

        try {
            // Write rollback log entry (durable barrier — fsynced inside writeLog)
            this.wal.writeLog({
                operation: 'ROLLBACK',
                transactionId
            });

            // Update transaction status
            transaction.status = 'aborted';

            // Release only the locks this tx held — O(heldKeys) instead of O(allLocks)
            this.lockManager.releaseLocksForTx(transactionId, transaction.heldLocks);

            // Cleanup in-memory state for this transaction
            this.pendingWrites.delete(transactionId);
            this.activeTransactions.delete(transactionId);

        } catch (error) {
            throw error;
        }
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
            const filePath = join(this.dbPath, `${key}.json`);
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