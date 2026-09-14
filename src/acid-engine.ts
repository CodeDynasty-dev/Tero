import { existsSync, readFileSync, readSync, appendFileSync, writeFileSync, unlinkSync, mkdirSync, readdirSync, statSync, openSync, closeSync, fsyncSync, renameSync, rmSync } from "fs";
import { join, dirname } from "path";
import { randomBytes } from "crypto";
import { StringDecoder } from "string_decoder";

export type JsonPrimitive = string | number | boolean | null;
export type JsonArray = JsonValue[];
export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export function padLsn(lsn: number): string {
    return String(lsn).padStart(12, '0');
}

export class RecoveryCorruptionError extends Error {
    code = 'RECOVERY_CORRUPTION';
    constructor(
        public walPath: string,
        public offset: number,
        public reason: string,
        public lsn?: number
    ) {
        super(`RECOVERY_CORRUPTION at ${walPath} (offset: ${offset}${lsn !== undefined ? `, lsn: ${lsn}` : ''}): ${reason}`);
        this.name = 'RecoveryCorruptionError';
    }
}

export class DataCorruptionError extends Error {
    code = 'DATA_CORRUPTION';
    filePath?: string;
    constructor(filePathOrMessage: string, details?: string) {
        const message = details !== undefined ? `DATA_CORRUPTION in ${filePathOrMessage}: ${details}` : filePathOrMessage;
        super(message);
        this.name = 'DataCorruptionError';
        if (details !== undefined) {
            this.filePath = filePathOrMessage;
        }
    }
}

export function cloneJson<T>(value: T): T {
    if (value === null) return value;
    if (typeof value === 'boolean' || typeof value === 'string') return value;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new TypeError(`Cannot serialize non-finite number: ${value}`);
        }
        return value;
    }
    if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'undefined') {
        throw new TypeError(`Cannot serialize non-JSON value of type ${typeof value}`);
    }
    if (Array.isArray(value)) {
        const arr = new Array(value.length);
        for (let i = 0; i < value.length; i++) {
            arr[i] = cloneJson(value[i]);
        }
        return arr as unknown as T;
    }
    if (typeof value !== 'object') {
        throw new TypeError(`Cannot serialize non-JSON value of type ${typeof value}`);
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && proto !== Object.prototype) {
        throw new TypeError(`Cannot serialize non-plain object of type ${value?.constructor?.name || typeof value}`);
    }
    const copy: any = {};
    for (const k of Object.keys(value)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
        copy[k] = cloneJson((value as any)[k]);
    }
    return copy as T;
}

export function verifyLogEntryChecksum(entry: LogEntry): boolean {
    if (entry.checksum === undefined) {
        return true;
    }
    const { checksum, ...entryWithoutChecksum } = entry;
    return fnv1a64(JSON.stringify(entryWithoutChecksum)) === checksum;
}

export interface DirtyEntry {
    key: string;
    lsn: number;
    state: 'present' | 'deleted';
    data?: JsonValue;
}

// ACID-compliant transaction log entry
export interface LogEntry {
    lsn: number; // Log Sequence Number
    transactionId: string;
    operation: 'BEGIN' | 'WRITE' | 'DELETE' | 'COMMIT' | 'ROLLBACK' | 'CHECKPOINT';
    key?: string;
    beforeImage?: JsonValue; // For rollback
    afterImage?: JsonValue;  // For redo
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

export function streamLogFile(filePath: string, visitor: (entry: LogEntry) => void, allowTornTail = true): { firstLsn: number | null; lastLsn: number | null; count: number } {
    if (!existsSync(filePath)) return { firstLsn: null, lastLsn: null, count: 0 };
    let fd: number;
    try {
        fd = openSync(filePath, 'r');
    } catch (err: any) {
        if (err?.code === 'ENOENT') return { firstLsn: null, lastLsn: null, count: 0 };
        throw err;
    }
    const decoder = new StringDecoder('utf8');
    const buf = Buffer.alloc(65536);
    let partial = '';
    let currentOffset = 0;
    let lastLsn = -1;
    let firstLsn: number | null = null;
    let count = 0;

    try {
        let bytesRead: number;
        while ((bytesRead = readSync(fd, buf, 0, buf.length, null)) > 0) {
            const chunk = partial + decoder.write(buf.subarray(0, bytesRead));
            const lines = chunk.split('\n');
            partial = lines.pop() || '';
            for (const line of lines) {
                const recordOffset = currentOffset;
                currentOffset += Buffer.byteLength(line, 'utf8') + 1;
                if (!line.trim()) continue;

                let entry: LogEntry;
                try {
                    entry = JSON.parse(line);
                } catch (e: any) {
                    throw new RecoveryCorruptionError(filePath, recordOffset, `Invalid JSON record: ${e?.message || 'parse error'}`);
                }

                if (!verifyLogEntryChecksum(entry)) {
                    throw new RecoveryCorruptionError(filePath, recordOffset, 'Checksum mismatch', entry.lsn);
                }

                if (lastLsn !== -1 && entry.lsn <= lastLsn) {
                    throw new RecoveryCorruptionError(filePath, recordOffset, `Non-monotonic LSN: expected > ${lastLsn}, got ${entry.lsn}`, entry.lsn);
                }
                lastLsn = entry.lsn;
                if (firstLsn === null) firstLsn = entry.lsn;
                count++;

                visitor(entry);
            }
        }

        partial += decoder.end();
        if (partial.trim()) {
            const recordOffset = currentOffset;
            try {
                const entry: LogEntry = JSON.parse(partial);
                if (verifyLogEntryChecksum(entry)) {
                    if (lastLsn !== -1 && entry.lsn <= lastLsn) {
                        throw new RecoveryCorruptionError(filePath, recordOffset, `Non-monotonic LSN: expected > ${lastLsn}, got ${entry.lsn}`, entry.lsn);
                    }
                    lastLsn = entry.lsn;
                    if (firstLsn === null) firstLsn = entry.lsn;
                    count++;
                    visitor(entry);
                } else if (!allowTornTail) {
                    throw new RecoveryCorruptionError(filePath, recordOffset, 'Checksum mismatch on unterminated final fragment', entry.lsn);
                }
            } catch (err: any) {
                if (err instanceof RecoveryCorruptionError) throw err;
                if (!allowTornTail) {
                    throw new RecoveryCorruptionError(filePath, recordOffset, `Invalid JSON on unterminated final fragment: ${err?.message || 'parse error'}`);
                }
            }
        }
    } finally {
        closeSync(fd);
    }

    return { firstLsn, lastLsn: lastLsn === -1 ? null : lastLsn, count };
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
        } catch (error: any) {
            if (error?.code === 'ENOENT') return; // file may not exist during rotation edge cases
            throw error;
        }
        try {
            fsyncSync(fd);
        } finally {
            closeSync(fd);
        }
    }

    private fsyncDir(dirPath: string): void {
        let fd: number;
        try {
            fd = openSync(dirPath, 'r');
        } catch (error: any) {
            if (error?.code === 'ENOENT') return;
            throw error;
        }
        try {
            fsyncSync(fd);
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
        const dir = dirname(this.logPath);
        if (existsSync(dir)) {
            const files = readdirSync(dir).filter(f => f.startsWith('.wal.seg-'));
            if (files.length > 0) {
                const segPaths = files.map(f => join(dir, f));
                const verified = verifyWalSegmentContinuity(segPaths, true);
                if (verified.length > 0) {
                    const lastSeg = verified[verified.length - 1];
                    let activeFirstLsn: number | null = null;
                    let activeMaxLsn = lastSeg.endLsn;
                    this.streamLogEntries((entry) => {
                        if (activeFirstLsn === null) activeFirstLsn = entry.lsn;
                        if (entry.lsn > activeMaxLsn) activeMaxLsn = entry.lsn;
                    });
                    if (activeFirstLsn !== null) {
                        if (activeFirstLsn !== lastSeg.endLsn + 1) {
                            throw new RecoveryCorruptionError(
                                this.logPath,
                                0,
                                `WAL continuity gap between archive and active log: archive ended at ${lastSeg.endLsn}, active log starts at ${activeFirstLsn}`,
                                activeFirstLsn
                            );
                        }
                        this.currentLSN = activeMaxLsn + 1;
                    } else {
                        this.currentLSN = lastSeg.endLsn + 1;
                    }
                    return;
                }
            }
        }

        let maxLSN = 0;
        let hasEntries = false;
        this.streamLogEntries((entry) => {
            hasEntries = true;
            if (entry.lsn > maxLSN) maxLSN = entry.lsn;
        });
        this.currentLSN = hasEntries ? maxLSN + 1 : 0;
    }

    /**
     * Stream WAL entries from disk line-by-line without loading the entire file
     * into a single V8 string. Reads 64KB chunks, processes complete lines, and
     * calls visitor(entry) for each valid (checksum-verified) entry.
     *
     * Invariant:
     * - Newline-terminated invalid record -> fatal RecoveryCorruptionError
     * - Interior invalid record -> fatal RecoveryCorruptionError
     * - Final unterminated valid record -> replay (accept)
     * - Final unterminated invalid record -> ignore as torn tail
     * - Monotonic LSN strictly required within the log stream
     */
    streamLogEntries(visitor: (entry: LogEntry) => void): void {
        streamLogFile(this.logPath, visitor, true);
    }

    streamAllLogEntries(visitor: (entry: LogEntry) => void): void {
        const dir = dirname(this.logPath);
        if (existsSync(dir)) {
            const files = readdirSync(dir).filter(f => f.startsWith('.wal.seg-'));
            if (files.length > 0) {
                const segPaths = files.map(f => join(dir, f));
                const verified = verifyWalSegmentContinuity(segPaths, true);
                for (const seg of verified) {
                    streamLogFile(seg.path, visitor, false);
                }
            }
        }
        this.streamLogEntries(visitor);
    }

    private calculateChecksum(entry: Omit<LogEntry, 'checksum'>): string {
        return fnv1a64(JSON.stringify(entry));
    }

    private verifyChecksum(entry: LogEntry): boolean {
        return verifyLogEntryChecksum(entry as LogEntry);
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
        const stats = statSync(this.logPath);
        if (stats.size > this.LOG_FILE_SIZE_LIMIT) {
            this.rotateLog();
        }
    }

    /**
     * Rotate the WAL:
     * 1. Ensure current WAL is fsynced.
     * 2. Rename current log to .wal.seg-<startLsn>-<endLsn> (atomic segment rotation).
     * 3. Fsync archive and parent directory.
     * 4. Create fresh empty WAL and fsync it and parent directory.
     * 5. Emit a CHECKPOINT entry at the head of the new log.
     * 6. Clean up old archives beyond ARCHIVE_KEEP_COUNT.
     */
    rotateLog(): string | null {
        this.forceFlush();
        if (!existsSync(this.logPath)) return null;
        const stats = statSync(this.logPath);
        if (stats.size === 0) return null;

        // Determine first and last record LSN in the WAL
        let firstLsn: number | null = null;
        let lastLsn: number | null = null;
        this.streamLogEntries((entry) => {
            if (firstLsn === null) firstLsn = entry.lsn;
            lastLsn = entry.lsn;
        });

        if (firstLsn === null || lastLsn === null) {
            return null;
        }

        const archivePath = `${this.logPath}.seg-${padLsn(firstLsn)}-${padLsn(lastLsn)}`;
        const dir = dirname(this.logPath);

        // 1. Atomic rename to immutable segment
        renameSync(this.logPath, archivePath);
        this.fsyncFile(archivePath);
        this.fsyncDir(dir);

        // 2. Start fresh empty log
        writeFileSync(this.logPath, '');
        this.fsyncFile(this.logPath);
        this.fsyncDir(dir);

        // 3. Emit a CHECKPOINT entry at the head of the new log
        this.writeLog({ operation: 'CHECKPOINT', transactionId: 'SYSTEM' });

        // 4. Prune old archives
        this.cleanupOldArchives(this.ARCHIVE_KEEP_COUNT);

        return archivePath;
    }

    /**
     * Returns the paths of all locally retained WAL archives (newest first).
     * Used by v2 backup to upload segments to the client's bucket.
     * Strictly matches deterministic structured segments .wal.seg-<start>-<end>.
     */
    listArchives(): string[] {
        const dir = dirname(this.logPath);
        if (!existsSync(dir)) return [];
        const files = readdirSync(dir);
        return files
            .filter(f => f.startsWith('.wal.seg-'))
            .map(f => {
                const m = f.match(/^\.wal\.seg-(\d+)-(\d+)$/);
                return m ? { path: join(dir, f), startLsn: parseInt(m[1], 10) } : null;
            })
            .filter((s): s is { path: string; startLsn: number } => s !== null)
            .sort((a, b) => b.startLsn - a.startLsn)
            .map(s => s.path);
    }

    private cleanupOldArchives(keepCount: number): void {
        const dir = dirname(this.logPath);
        if (!existsSync(dir)) return;
        const files = readdirSync(dir);
        const archiveFiles = files
            .filter(f => f.startsWith('.wal.seg-'))
            .map(f => {
                const m = f.match(/^\.wal\.seg-(\d+)-(\d+)$/);
                return m ? { path: join(dir, f), startLsn: parseInt(m[1], 10) } : null;
            })
            .filter((s): s is { path: string; startLsn: number } => s !== null)
            .sort((a, b) => a.startLsn - b.startLsn); // oldest first

        while (archiveFiles.length > keepCount) {
            const oldestFile = archiveFiles.shift();
            if (oldestFile && existsSync(oldestFile.path)) {
                unlinkSync(oldestFile.path);
            }
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
     * Truncate (clear) the WAL entirely.
     * Force-flushes any buffered entries first, verifies buffer is drained,
     * truncates .wal to 0 bytes, fsyncs file and directory, and cleans up archives.
     */
    truncateLog(): void {
        this.forceFlush();
        if (this.writeBuffer.length > 0) {
            throw new Error('Cannot truncate WAL: unflushed entries in write buffer');
        }
        writeFileSync(this.logPath, '');
        this.fsyncFile(this.logPath);
        this.fsyncDir(dirname(this.logPath));
        this.dirty = false;
        this.cleanupOldArchives(0);
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

    private waitingOn: Map<string, Set<string>> = new Map(); // waiterTxId -> Set<holderTxId>
    private readonly DEADLOCK_TIMEOUT = 30000; // 30 seconds

    private hasCycle(fromTx: string, targetTx: string, visited = new Set<string>()): boolean {
        if (fromTx === targetTx) return true;
        visited.add(fromTx);
        const nextTxs = this.waitingOn.get(fromTx);
        if (nextTxs) {
            for (const next of nextTxs) {
                if (next === targetTx) return true;
                if (!visited.has(next)) {
                    if (this.hasCycle(next, targetTx, visited)) return true;
                }
            }
        }
        return false;
    }

    private cleanTxGraph(transactionId: string): void {
        this.waitingOn.delete(transactionId);
        for (const [waiter, holders] of this.waitingOn.entries()) {
            holders.delete(transactionId);
            if (holders.size === 0) {
                this.waitingOn.delete(waiter);
            }
        }
    }

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

        // Fast path 2: existing holder requesting lock — never downgrade exclusive
        const isHolder = lockInfo.holders.has(transactionId);
        if (isHolder) {
            // Already holding exclusive — strongest lock, never downgrade
            if (lockInfo.type === 'exclusive') {
                return true;
            }
            // Already holding shared and requesting shared — no-op
            if (lockType === 'shared') {
                return true;
            }
            // Upgrading from shared to exclusive — grant if sole holder
            if (lockInfo.holders.size === 1) {
                lockInfo.type = 'exclusive';
                return true;
            }
            // Multiple shared holders: must wait in queue for upgrade
        } else if (this.canGrantLock(lockInfo, lockType, transactionId)) {
            if (lockType === 'shared' && lockInfo.type === 'shared') {
                lockInfo.holders.add(transactionId);
            } else {
                lockInfo.type = lockType;
                lockInfo.holders.clear();
                lockInfo.holders.add(transactionId);
            }
            return true;
        }

        // Deadlock detection before queueing:
        // 1. Identify all blocking transactions (holders + existing waiters ahead in FIFO queue)
        const blockingTxs = new Set<string>();
        for (const h of lockInfo.holders) {
            if (h !== transactionId) {
                blockingTxs.add(h);
            }
        }
        for (const req of lockInfo.waitQueue) {
            if (req.transactionId !== transactionId) {
                blockingTxs.add(req.transactionId);
            }
        }

        // 2. Check for cycle in wait-for graph
        for (const blocker of blockingTxs) {
            if (this.hasCycle(blocker, transactionId)) {
                return Promise.reject(new Error(`Deadlock detected: transaction '${transactionId}' cannot acquire lock on key '${key}'`));
            }
        }

        // 3. Shared→exclusive upgrade deadlock: if another shared holder is already waiting for exclusive upgrade
        if (isHolder && lockType === 'exclusive') {
            const hasOtherUpgradeWaiter = lockInfo.waitQueue.some(
                (req: any) => req.type === 'exclusive' && lockInfo.holders.has(req.transactionId) && req.transactionId !== transactionId
            );
            if (hasOtherUpgradeWaiter) {
                return Promise.reject(new Error(`Deadlock detected: multiple transactions upgrading to exclusive lock on key '${key}'`));
            }
        }

        // Record wait-for edges in graph
        let currentWaiting = this.waitingOn.get(transactionId);
        if (!currentWaiting) {
            currentWaiting = new Set();
            this.waitingOn.set(transactionId, currentWaiting);
        }
        for (const blocker of blockingTxs) {
            currentWaiting.add(blocker);
        }

        // Slow path: lock is contended — allocate Promise + timer and wait in queue
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.removeLockRequest(key, transactionId);
                this.cleanTxGraph(transactionId);
                reject(new Error(`Lock acquisition timeout for key '${key}' in transaction '${transactionId}'`));
            }, this.DEADLOCK_TIMEOUT);

            lockInfo.waitQueue.push({
                transactionId,
                type: lockType,
                resolve: () => {
                    clearTimeout(timeout);
                    this.cleanTxGraph(transactionId);
                    resolve();
                },
                reject: (error: Error) => {
                    clearTimeout(timeout);
                    this.cleanTxGraph(transactionId);
                    reject(error);
                }
            });
        });
    }

    private canGrantLock(lockInfo: any, requestedType: 'shared' | 'exclusive', transactionId: string): boolean {
        const isHolder = lockInfo.holders.has(transactionId);

        if (isHolder) {
            if (lockInfo.type === 'exclusive') return true;
            if (lockInfo.type === 'shared' && requestedType === 'exclusive') {
                return lockInfo.holders.size === 1;
            }
            return true;
        }

        // Writer-starvation fairness: if an exclusive waiter is queued,
        // new shared requests must wait behind it. Otherwise continuous
        // readers can starve a writer indefinitely (holders drain → new
        // reader immediately re-acquires before the waiter is dequeued).
        if (requestedType === 'shared' && lockInfo.waitQueue.length > 0) {
            const hasExclusiveWaiter = lockInfo.waitQueue.some((w: any) => w.type === 'exclusive');
            if (hasExclusiveWaiter) return false;
        }

        // FIFO for exclusive: if anyone is queued, a new exclusive must
        // wait behind the existing queue (even if holders just drained).
        if (requestedType === 'exclusive' && lockInfo.waitQueue.length > 0) {
            return false;
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

        // Process wait queue if:
        // 1. All holders drained (holders.size === 0)
        // 2. OR sole remaining holder is waiting for an exclusive upgrade!
        if (lockInfo.waitQueue.length > 0) {
            if (lockInfo.holders.size === 0) {
                this.processWaitQueue(key, lockInfo);
            } else if (lockInfo.holders.size === 1 && lockInfo.waitQueue[0].type === 'exclusive' && lockInfo.holders.has(lockInfo.waitQueue[0].transactionId)) {
                this.processWaitQueue(key, lockInfo);
            }
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
                this.waitingOn.delete(request.transactionId);
                request.resolve();
            }
        } else {
            // Grant single exclusive lock
            const request = lockInfo.waitQueue.shift()!;
            lockInfo.type = 'exclusive';
            lockInfo.holders.clear();
            lockInfo.holders.add(request.transactionId);
            this.waitingOn.delete(request.transactionId);
            request.resolve();
        }

        // Update waitingOn for all remaining waiters in the queue:
        // they are now waiting on the new holder(s)
        for (const queued of lockInfo.waitQueue) {
            let waiterSet = this.waitingOn.get(queued.transactionId);
            if (!waiterSet) {
                waiterSet = new Set();
                this.waitingOn.set(queued.transactionId, waiterSet);
            }
            for (const h of lockInfo.holders) {
                if (h !== queued.transactionId) {
                    waiterSet.add(h);
                }
            }
        }
    }

    private removeLockRequest(key: string, transactionId: string): void {
        const lockInfo = this.locks.get(key);
        if (!lockInfo) return;

        lockInfo.waitQueue = lockInfo.waitQueue.filter(req => req.transactionId !== transactionId);
    }

    /**
     * Release locks and remove pending wait-queue requests for a transaction.
     */
    releaseLocksForTx(transactionId: string, heldKeys: Set<string>, waitingKeys?: Set<string>): void {
        for (const key of heldKeys) {
            this.releaseLock(key, transactionId);
        }
        const keysToClean = waitingKeys ? new Set([...heldKeys, ...waitingKeys]) : heldKeys;
        for (const key of keysToClean) {
            const lockInfo = this.locks.get(key);
            if (lockInfo) {
                lockInfo.waitQueue = lockInfo.waitQueue.filter(req => {
                    if (req.transactionId === transactionId) {
                        req.reject(new Error('Transaction aborted'));
                        return false;
                    }
                    return true;
                });
                if (lockInfo.holders.size === 0 && lockInfo.waitQueue.length === 0) {
                    this.locks.delete(key);
                }
            }
        }
        this.cleanTxGraph(transactionId);
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
        this.cleanTxGraph(transactionId);
    }

    detectDeadlock(): string[] {
        const deadlocked = new Set<string>();
        for (const [waiter, holders] of this.waitingOn.entries()) {
            for (const h of holders) {
                if (this.hasCycle(h, waiter)) {
                    deadlocked.add(waiter);
                    break;
                }
            }
        }
        return [...deadlocked];
    }

    isKeyLocked(key: string): boolean {
        const lockInfo = this.locks.get(key);
        return !!(lockInfo && (lockInfo.holders.size > 0 || lockInfo.waitQueue.length > 0));
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
    if (!key || typeof key !== 'string' || !key.trim()) {
        throw new TypeError(`Invalid key '${key}': key must be a non-empty string`);
    }
    if (key === '.' || key === '..' || key.includes('/') || key.includes('\\') || key.includes('\0') || key.startsWith('.')) {
        throw new TypeError(`Invalid key '${key}': keys must not contain slashes, null bytes, or directory traversal`);
    }
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
                    } catch (e: any) {
                        if (e?.code === 'ENOENT') { /* dir removed mid-walk */ } else throw e;
                    }
                }
            } catch (e: any) {
                if (e?.code === 'ENOENT') { /* dir removed mid-walk */ } else throw e;
            }
        }
    } catch (e: any) {
        if (e?.code === 'ENOENT') { /* dbPath may not exist */ } else throw e;
    }
}

export interface RestoreMarker {
    id: string;
    targetDir: string;
    stagingDir: string;
    backupDir: string;
    createdAt: number;
    stage: 'prepared' | 'swapped';
}

export function safeRemoveDirectory(dirPath: string): void {
    try {
        if (existsSync(dirPath)) {
            rmSync(dirPath, { recursive: true, force: true });
        }
    } catch (err: any) {
        if (err?.code === 'ENOENT') return;
        throw err;
    }
}

export function recoverPendingRestore(dbPath: string): void {
    const markerPath = `${dbPath}.restore-in-progress`;
    if (!existsSync(markerPath)) return;

    let marker: RestoreMarker;
    try {
        const content = readFileSync(markerPath, 'utf-8');
        marker = JSON.parse(content);
        if (!marker || typeof marker !== 'object' || !marker.targetDir || !marker.stagingDir || !marker.backupDir) {
            throw new Error('Malformed marker schema');
        }
    } catch (err: any) {
        throw new RecoveryCorruptionError(markerPath, 0, `Corrupted restore marker file: ${err?.message || err}`);
    }

    const targetExists = existsSync(marker.targetDir);
    const backupExists = existsSync(marker.backupDir);
    const stagingExists = existsSync(marker.stagingDir);

    if (backupExists && !targetExists && stagingExists) {
        // backup exists + target missing + staging exists -> complete promotion
        renameSync(marker.stagingDir, marker.targetDir);
        safeRemoveDirectory(marker.backupDir);
    } else if (targetExists && backupExists && !stagingExists) {
        // target exists + backup exists + staging missing -> promotion likely completed
        safeRemoveDirectory(marker.backupDir);
    } else if (targetExists && backupExists && stagingExists) {
        // backup exists + target exists + staging exists -> ambiguous
        // use marker state/metadata to deterministically recover:
        if (marker.stage === 'swapped') {
            // promotion was swapping staging into target; staging and backup are discarded
            safeRemoveDirectory(marker.stagingDir);
            safeRemoveDirectory(marker.backupDir);
        } else {
            // stage === 'prepared': original target is intact, clean up staging and backup
            safeRemoveDirectory(marker.stagingDir);
            safeRemoveDirectory(marker.backupDir);
        }
    } else if (!targetExists && backupExists && !stagingExists) {
        // target missing + backup exists + staging missing -> rollback: restore backup to target
        renameSync(marker.backupDir, marker.targetDir);
    } else if (!targetExists && !backupExists && stagingExists) {
        // target missing + backup missing + staging exists -> complete promotion
        renameSync(marker.stagingDir, marker.targetDir);
    } else if (targetExists) {
        if (stagingExists) {
            safeRemoveDirectory(marker.stagingDir);
        }
        if (backupExists) {
            safeRemoveDirectory(marker.backupDir);
        }
    }

    // Fsync parent directory
    const parentDir = dirname(marker.targetDir);
    if (existsSync(parentDir)) {
        let fd: number | undefined;
        try {
            fd = openSync(parentDir, 'r');
            fsyncSync(fd);
        } finally {
            if (fd !== undefined) closeSync(fd);
        }
    }
    try {
        unlinkSync(markerPath);
    } catch (err: any) {
        if (err?.code !== 'ENOENT') throw err;
    }
}

export function verifyWalSegmentContinuity(segmentPaths: string[], verifyContent: boolean = true): Array<{ path: string; startLsn: number; endLsn: number }> {
    const segments: Array<{ path: string; startLsn: number; endLsn: number }> = [];
    for (const p of segmentPaths) {
        const base = p.split('/').pop()!;
        const match = base.match(/\.seg-(\d+)-(\d+)$/);
        if (!match) {
            throw new RecoveryCorruptionError(p, 0, `Malformed WAL segment filename: ${base}`);
        }
        const startLsn = parseInt(match[1], 10);
        const endLsn = parseInt(match[2], 10);
        if (startLsn > endLsn) {
            throw new RecoveryCorruptionError(p, 0, `Invalid segment range: startLsn (${startLsn}) > endLsn (${endLsn})`);
        }
        segments.push({ path: p, startLsn, endLsn });
    }

    segments.sort((a, b) => a.startLsn - b.startLsn);

    for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (i > 0) {
            const prev = segments[i - 1];
            if (seg.startLsn === prev.startLsn && seg.endLsn === prev.endLsn) {
                throw new RecoveryCorruptionError(seg.path, 0, `Duplicate WAL segment range ${seg.startLsn}-${seg.endLsn}`);
            }
            if (seg.startLsn <= prev.endLsn) {
                throw new RecoveryCorruptionError(seg.path, 0, `Overlapping WAL segments: ${prev.startLsn}-${prev.endLsn} and ${seg.startLsn}-${seg.endLsn}`);
            }
            if (seg.startLsn !== prev.endLsn + 1) {
                throw new RecoveryCorruptionError(seg.path, 0, `WAL segment gap: expected ${prev.endLsn + 1}, found ${seg.startLsn}`);
            }
        }

        if (verifyContent && existsSync(seg.path)) {
            const { firstLsn, lastLsn, count } = streamLogFile(seg.path, () => {}, false);
            if (count === 0 || firstLsn === null || lastLsn === null) {
                throw new RecoveryCorruptionError(seg.path, 0, `Empty WAL segment with non-empty declared range ${seg.startLsn}-${seg.endLsn}`);
            }
            if (firstLsn !== seg.startLsn) {
                throw new RecoveryCorruptionError(seg.path, 0, `WAL segment start LSN mismatch: declared ${seg.startLsn}, actual first record ${firstLsn}`);
            }
            if (lastLsn !== seg.endLsn) {
                throw new RecoveryCorruptionError(seg.path, 0, `WAL segment end LSN mismatch: declared ${seg.endLsn}, actual last record ${lastLsn}`);
            }
        }
    }
    return segments;
}

export interface SnapshotHandle {
    readonly lsn: number;
    files(): AsyncGenerator<{ key: string; lsn: number; state: 'present' | 'deleted'; data?: JsonValue }>;
    close(): void;
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
        waitingLocks: Set<string>; // keys this tx is queued waiting on
    }> = new Map();

    private finishedTransactions: Map<string, 'committed' | 'aborted'> = new Map();

    /**
     * In-memory pending-writes index per active transaction.
     * Keyed by transactionId -> key -> { beforeImage, afterImage, op }
     */
    private pendingWrites: Map<string, Map<string, { beforeImage: JsonValue; afterImage: JsonValue; op: 'write' | 'delete' }>> = new Map();

    /**
     * Compaction cadence: every COMMIT_INTERVAL commits, if there are no active
     * transactions, we rotate the WAL into an archive and start a fresh log.
     */
    private readonly COMMIT_INTERVAL = 10000;
    private commitCount: number = 0;

    private txCounter: number = 0;
    private readonly pid: number = process.pid;
    private readonly txSalt: string = randomBytes(3).toString('hex');

    /**
     * Deferred data-file write buffer. On commit, committed data moves here instead
     * of being written to data files immediately. A background timer flushes this
     * to disk every `dataFlushIntervalMs` (default 50ms).
     */
    private committedBuffer: Map<string, { data: JsonValue; op: 'write' | 'delete' }> = new Map();
    private dataFlushTimer?: ReturnType<typeof setInterval>;
    private readonly DATA_FLUSH_INTERVAL_MS: number;

    /**
     * Version-consistent dirty-key tracker for cloud checkpoints.
     * Every committed write/delete stores its immutable DirtyEntry here with commit LSN.
     */
    private dirtyKeys: Map<string, DirtyEntry> = new Map();
    private activeSnapshotLsn: number | null = null;
    private snapshotBeforeImages: Map<string, { state: 'present' | 'deleted'; data?: JsonValue }> = new Map();
    private lastCommittedLSN: number = 0;
    private degraded: boolean = false;
    private lastMaintenanceError: Error | null = null;

    isDegraded(): boolean {
        return this.degraded;
    }

    getLastMaintenanceError(): Error | null {
        return this.lastMaintenanceError;
    }

    getLastCommittedLSN(): number {
        return this.lastCommittedLSN;
    }

    peekDirtyKeys(upToLsn?: number): Map<string, DirtyEntry> {
        const threshold = upToLsn !== undefined ? upToLsn : Infinity;
        const snapshot = new Map<string, DirtyEntry>();
        for (const [key, entry] of this.dirtyKeys) {
            if (entry.lsn <= threshold) {
                snapshot.set(key, {
                    key: entry.key,
                    lsn: entry.lsn,
                    state: entry.state,
                    data: entry.data !== undefined ? cloneJson(entry.data) : undefined
                });
            }
        }
        return snapshot;
    }

    acknowledgeDirtyKeys(acked: Iterable<{ key: string; lsn: number }>): void {
        for (const item of acked) {
            const current = this.dirtyKeys.get(item.key);
            if (current && current.lsn === item.lsn) {
                this.dirtyKeys.delete(item.key);
            }
        }
    }

    getDirtyKeyCount(): number {
        return this.dirtyKeys.size;
    }

    /**
     * Creates an isolated logical snapshot handle as of upToLsn.
     * Enforces single-active-snapshot invariant and provides explicit close().
     */
    beginSnapshot(upToLsn: number): SnapshotHandle {
        if (this.activeSnapshotLsn !== null) {
            throw new Error(`Cannot begin concurrent snapshot at LSN ${upToLsn}: active snapshot already in progress at LSN ${this.activeSnapshotLsn}`);
        }
        const dirtySnapshot = this.peekDirtyKeys(upToLsn);
        this.activeSnapshotLsn = upToLsn;
        this.snapshotBeforeImages.clear();

        let closed = false;
        const self = this;

        return {
            lsn: upToLsn,
            files() {
                if (closed) throw new Error('SnapshotHandle has already been closed');
                return self._streamSnapshotFiles(upToLsn, dirtySnapshot);
            },
            close() {
                if (!closed) {
                    closed = true;
                    if (self.activeSnapshotLsn === upToLsn) {
                        self.activeSnapshotLsn = null;
                        self.snapshotBeforeImages.clear();
                    }
                }
            }
        };
    }

    /**
     * Streams a version-consistent logical snapshot of the database as of upToLsn.
     * Fully protected against concurrent writes via Copy-On-Write snapshotBeforeImages.
     */
    snapshotFiles(upToLsn: number): AsyncGenerator<{ key: string; lsn: number; state: 'present' | 'deleted'; data?: JsonValue }> {
        const handle = this.beginSnapshot(upToLsn);
        return handle.files();
    }

    private async *_streamSnapshotFiles(upToLsn: number, dirtySnapshot: Map<string, DirtyEntry>): AsyncGenerator<{ key: string; lsn: number; state: 'present' | 'deleted'; data?: JsonValue }> {
        const yieldedKeys = new Set<string>();

        try {
            const fs = await import('fs/promises');
            if (existsSync(this.dbPath)) {
                const level0 = await fs.opendir(this.dbPath);
                for await (const entry0 of level0) {
                    if (!entry0.isDirectory() || entry0.name.startsWith('.')) continue;
                    const level0Path = join(this.dbPath, entry0.name);
                    try {
                        const level1 = await fs.opendir(level0Path);
                        for await (const entry1 of level1) {
                            if (!entry1.isDirectory() || entry1.name.startsWith('.')) continue;
                            const level1Path = join(level0Path, entry1.name);
                            try {
                                const level2 = await fs.opendir(level1Path);
                                for await (const entry2 of level2) {
                                    if (!entry2.isFile() || !entry2.name.endsWith('.json')) continue;
                                    const key = entry2.name.slice(0, -5);
                                    yieldedKeys.add(key);

                                    // 1. If key was modified AFTER upToLsn, use preserved before-image
                                    if (this.snapshotBeforeImages.has(key)) {
                                        const b = this.snapshotBeforeImages.get(key)!;
                                        if (b.state === 'present' && b.data !== undefined) {
                                            yield { key, lsn: upToLsn, state: 'present', data: b.data };
                                        }
                                        continue;
                                    }

                                    // 2. If key was dirty <= upToLsn, use dirtySnapshot
                                    if (dirtySnapshot.has(key)) {
                                        const d = dirtySnapshot.get(key)!;
                                        if (d.state === 'present') {
                                            yield { key, lsn: d.lsn, state: 'present', data: d.data };
                                        }
                                        continue;
                                    }

                                    // 3. Unmodified on disk
                                    const filePath = join(level1Path, entry2.name);
                                    let content: string;
                                    try {
                                        content = readFileSync(filePath, 'utf-8');
                                    } catch (readErr: any) {
                                        if (readErr?.code === 'ENOENT') continue;
                                        throw readErr;
                                    }
                                    let parsed: any;
                                    try {
                                        parsed = content.trim() ? JSON.parse(content) : {};
                                    } catch (parseErr: any) {
                                        throw new DataCorruptionError(filePath, `Corrupted document during snapshot: ${parseErr?.message}`);
                                    }
                                    yield { key, lsn: upToLsn, state: 'present', data: parsed };
                                }
                            } catch (err: any) {
                                if (err instanceof DataCorruptionError) throw err;
                                if (err?.code === 'ENOENT') { /* dir removed mid-walk */ } else throw err;
                            }
                        }
                    } catch (err: any) {
                        if (err instanceof DataCorruptionError) throw err;
                        if (err?.code === 'ENOENT') { /* dir removed mid-walk */ } else throw err;
                    }
                }
            }

            // Yield keys in dirtySnapshot that were not yet on disk (deferred in committedBuffer)
            for (const [key, d] of dirtySnapshot) {
                if (!yieldedKeys.has(key)) {
                    yieldedKeys.add(key);
                    if (this.snapshotBeforeImages.has(key)) {
                        const b = this.snapshotBeforeImages.get(key)!;
                        if (b.state === 'present' && b.data !== undefined) {
                            yield { key, lsn: upToLsn, state: 'present', data: b.data };
                        }
                    } else if (d.state === 'present') {
                        yield { key, lsn: d.lsn, state: 'present', data: d.data };
                    }
                }
            }
        } finally {
            this.activeSnapshotLsn = null;
            this.snapshotBeforeImages.clear();
        }
    }

    private synchronous: SynchronousMode;
    private checkpointBatchSize: number;

    constructor(dbPath: string, synchronous: SynchronousMode = 'full', commitIntervalMs: number = 10, dataFlushIntervalMs: number = 50, checkpointBatchSize: number = 1000) {
        this.dbPath = dbPath;
        // Startup ordering: restore-marker recovery -> filesystem validation -> WAL recovery
        recoverPendingRestore(this.dbPath);
        this.synchronous = synchronous;
        this.DATA_FLUSH_INTERVAL_MS = dataFlushIntervalMs;
        this.checkpointBatchSize = checkpointBatchSize > 0 ? checkpointBatchSize : 1000;
        this.wal = new WriteAheadLog(dbPath, synchronous, commitIntervalMs);
        this.lockManager = new LockManager();
        this.initializeStorage();
        // Background data-file checkpoint timer — flushes committedBuffer to disk
        this.dataFlushTimer = setInterval(() => this.flushCommittedBuffer(), this.DATA_FLUSH_INTERVAL_MS);
        if (this.dataFlushTimer.unref) this.dataFlushTimer.unref();
    }

    private fsyncFile(path: string): void {
        let fd: number;
        try {
            fd = openSync(path, 'r');
        } catch (error: any) {
            if (error?.code === 'ENOENT') return;
            throw error;
        }
        try {
            fsyncSync(fd);
        } finally {
            closeSync(fd);
        }
    }

    private fsyncDir(dirPath: string): void {
        let fd: number;
        try {
            fd = openSync(dirPath, 'r');
        } catch (error: any) {
            if (error?.code === 'ENOENT') return;
            throw error;
        }
        try {
            fsyncSync(fd);
        } finally {
            closeSync(fd);
        }
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

        // Phase 1: streaming analysis — determine which transactions committed or aborted
        this.wal.streamAllLogEntries((entry) => {
            if (entry.operation === 'COMMIT') {
                committedTransactions.add(entry.transactionId);
                if (entry.lsn > this.lastCommittedLSN) {
                    this.lastCommittedLSN = entry.lsn;
                }
            } else if (entry.operation === 'ROLLBACK') {
                abortedTransactions.add(entry.transactionId);
            }
        });

        // Phase 2: redo + undo — single streaming pass
        const undoByKey = new Map<string, LogEntry>();
        this.wal.streamAllLogEntries((entry) => {
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
                if (!undoByKey.has(entry.key)) {
                    undoByKey.set(entry.key, entry);
                }
            }
        });

        // Phase 3: reverse undo — process buffered uncommitted ops
        const undoEntries = [...undoByKey.values()];
        for (let i = undoEntries.length - 1; i >= 0; i--) {
            this.undoOperation(undoEntries[i]);
        }
    }

    private redoOperation(entry: LogEntry): void {
        if (!entry.key || entry.afterImage === undefined) return;

        const filePath = partitionedPath(this.dbPath, entry.key!);
        this.atomicWriteFile(filePath, JSON.stringify(entry.afterImage));
    }

    private redoDelete(entry: LogEntry): void {
        if (!entry.key) return;

        const filePath = partitionedPath(this.dbPath, entry.key!);
        if (existsSync(filePath)) {
            unlinkSync(filePath);
        }
    }

    private undoOperation(entry: LogEntry): void {
        if (!entry.key) return;

        const filePath = partitionedPath(this.dbPath, entry.key!);

        if (entry.operation === 'WRITE') {
            if (entry.beforeImage === null || entry.beforeImage === undefined) {
                if (existsSync(filePath)) {
                    unlinkSync(filePath);
                }
            } else {
                this.atomicWriteFile(filePath, JSON.stringify(entry.beforeImage));
            }
        } else if (entry.operation === 'DELETE' && entry.beforeImage !== undefined && entry.beforeImage !== null) {
            this.atomicWriteFile(filePath, JSON.stringify(entry.beforeImage));
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
    private atomicWriteFile(filePath: string, content: string, forceFsync = false): void {
        const dir = dirname(filePath);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }

        const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
        writeFileSync(tmpPath, content);

        if (forceFsync || this.synchronous === 'full') {
            this.fsyncFile(tmpPath);
        }

        // atomic rename — readers see old or new, never partial
        renameSync(tmpPath, filePath);

        if (forceFsync || this.synchronous === 'full') {
            this.fsyncDir(dir);
        }
    }

    private static readonly MAX_ACTIVE_TXNS = 10000;

    // Transaction management
    beginTransaction(): string {
        if (this.activeTransactions.size >= ACIDStorageEngine.MAX_ACTIVE_TXNS) {
            throw new Error(`Too many active transactions (${this.activeTransactions.size} >= ${ACIDStorageEngine.MAX_ACTIVE_TXNS}) — commit or rollback before starting more`);
        }
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
            waitingLocks: new Set(),
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
    write(transactionId: string, key: string, data: any, cachedBeforeImage?: any): void | Promise<void> {
        const transaction = this.activeTransactions.get(transactionId);
        if (!transaction || transaction.status !== 'active') {
            throw new Error(`Invalid transaction: ${transactionId}`);
        }

        // Acquire exclusive lock — returns true (sync) or Promise (contended)
        const lockResult = this.lockManager.acquireLock(key, transactionId, 'exclusive');
        if (lockResult !== true) {
            // Slow path: lock is contended — return a Promise
            transaction.waitingLocks.add(key);
            return lockResult.then(() => {
                transaction.waitingLocks.delete(key);
                transaction.heldLocks.add(key);
                this.doWriteSync(transactionId, key, data, transaction, cachedBeforeImage);
            }).catch((err) => {
                transaction.waitingLocks.delete(key);
                throw err;
            });
        }

        // Fast path: lock granted synchronously — do the write work sync, return void
        transaction.heldLocks.add(key);
        this.doWriteSync(transactionId, key, data, transaction, cachedBeforeImage);
    }

    /**
     * Synchronous write work — called from write() after the lock is acquired.
     * Pure in-memory + buffer operations: before-image lookup, deepMerge, WAL buffer,
     * pendingWrites tracking. No syscalls, no Promises.
     */
    private doWriteSync(transactionId: string, key: string, data: any, transaction: any, cachedBeforeImage?: any): void {
        try {
            const pendingTx = this.pendingWrites.get(transactionId)!;

            // Determine "before image" — check pending writes, then committedBuffer, then cached, then disk
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
            } else if (cachedBeforeImage !== undefined) {
                currentData = cachedBeforeImage;
            } else {
                const filePath = partitionedPath(this.dbPath, key);
                if (existsSync(filePath)) {
                    try {
                        const content = readFileSync(filePath, 'utf-8');
                        currentData = content.trim() ? JSON.parse(content) : {};
                    } catch (error) {
                        throw new DataCorruptionError(`Data corruption detected in document '${key}': invalid JSON content at ${filePath}`);
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
     * Acquire an exclusive lock without writing. Used for SELECT FOR UPDATE
     * / transferMoney: acquire locks in global sorted order BEFORE reading
     * so reads are serializable and the read→write upgrade never deadlocks.
     * Same sync fast-path pattern as write/read — returns void or Promise.
     */
    acquireExclusiveLock(transactionId: string, key: string): void | Promise<void> {
        const transaction = this.activeTransactions.get(transactionId);
        if (!transaction || transaction.status !== 'active') {
            throw new Error(`Invalid transaction: ${transactionId}`);
        }
        const lockResult = this.lockManager.acquireLock(key, transactionId, 'exclusive');
        if (lockResult !== true) {
            transaction.waitingLocks.add(key);
            return lockResult.then(() => {
                transaction.waitingLocks.delete(key);
                transaction.heldLocks.add(key);
            }).catch((err) => {
                transaction.waitingLocks.delete(key);
                throw err;
            });
        }
        transaction.heldLocks.add(key);
    }

    /**
     * Acquire a shared lock for a transaction.
     */
    acquireSharedLock(transactionId: string, key: string): void | Promise<void> {
        const transaction = this.activeTransactions.get(transactionId);
        if (!transaction || transaction.status !== 'active') {
            throw new Error(`Invalid transaction: ${transactionId}`);
        }
        const lockResult = this.lockManager.acquireLock(key, transactionId, 'shared');
        if (lockResult !== true) {
            transaction.waitingLocks.add(key);
            return lockResult.then(() => {
                transaction.waitingLocks.delete(key);
                transaction.heldLocks.add(key);
            }).catch((err) => {
                transaction.waitingLocks.delete(key);
                throw err;
            });
        }
        transaction.heldLocks.add(key);
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
            transaction.waitingLocks.add(key);
            return lockResult.then(() => {
                transaction.waitingLocks.delete(key);
                transaction.heldLocks.add(key);
                return this.doReadSync(transactionId, key);
            }).catch((err) => {
                transaction.waitingLocks.delete(key);
                throw err;
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
            transaction.waitingLocks.add(key);
            return lockResult.then(() => {
                transaction.waitingLocks.delete(key);
                transaction.heldLocks.add(key);
                this.doDeleteSync(transactionId, key, transaction);
            }).catch((err) => {
                transaction.waitingLocks.delete(key);
                throw err;
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
                        throw new DataCorruptionError(`Data corruption detected in document '${key}': invalid JSON content at ${filePath}`);
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

        // 1. Write WAL COMMIT record. If this throws, transaction can safely rollback.
        let commitLsn: number;
        try {
            commitLsn = this.wal.writeLog({
                operation: 'COMMIT',
                transactionId
            });
        } catch (error) {
            try { this.rollbackTransaction(transactionId); } catch { /* approved: rollback during commit error best-effort */ }
            throw new Error(`Commit failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }

        // 2. Point of no return from the logical transaction engine. Durability depends on synchronous mode (immediate in 'full', interval in 'normal').
        transaction.status = 'committed';
        this.lastCommittedLSN = commitLsn;

        // DEFERRED data-file writes: move committed data to committedBuffer
        const pendingTx = this.pendingWrites.get(transactionId);
        if (pendingTx) {
            for (const [key, op] of pendingTx.entries()) {
                // If a snapshot is active at ckptLsn and this commit is after ckptLsn, preserve pre-snapshot state
                if (this.activeSnapshotLsn !== null && commitLsn > this.activeSnapshotLsn) {
                    if (!this.snapshotBeforeImages.has(key)) {
                        this.snapshotBeforeImages.set(key, {
                            state: op.beforeImage === null || op.beforeImage === undefined ? 'deleted' : 'present',
                            data: op.beforeImage !== null && op.beforeImage !== undefined ? cloneJson(op.beforeImage) : undefined
                        });
                    }
                }

                if (op.op === 'write' && op.afterImage !== undefined && op.afterImage !== null) {
                    this.committedBuffer.set(key, { data: op.afterImage, op: 'write' });
                    this.dirtyKeys.set(key, {
                        key,
                        lsn: commitLsn,
                        state: 'present',
                        data: cloneJson(op.afterImage)
                    });
                } else if (op.op === 'delete') {
                    this.committedBuffer.set(key, { data: null, op: 'delete' });
                    this.dirtyKeys.set(key, {
                        key,
                        lsn: commitLsn,
                        state: 'deleted',
                        data: undefined
                    });
                }
            }
        }

        // Release only the locks this tx held or was waiting on
        this.lockManager.releaseLocksForTx(transactionId, transaction.heldLocks, transaction.waitingLocks);

        // Cleanup in-memory state
        this.pendingWrites.delete(transactionId);
        this.activeTransactions.delete(transactionId);
        this.finishedTransactions.set(transactionId, 'committed');
        if (this.finishedTransactions.size > 1000) {
            const first = this.finishedTransactions.keys().next().value;
            if (first) this.finishedTransactions.delete(first);
        }

        // Bound WAL growth: periodically rotate when no active transactions are left.
        this.commitCount++;
        if (this.commitCount % this.COMMIT_INTERVAL === 0 &&
            this.getActiveTransactions().length === 0) {
            try {
                this.flushCommittedBuffer(true);
                this.wal.rotateLog();
                this.degraded = false;
                this.lastMaintenanceError = null;
            } catch (err: any) {
                // Post-commit maintenance failure must not invalidate the commit
                this.degraded = true;
                this.lastMaintenanceError = err instanceof Error ? err : new Error(String(err));
            }
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

        // Release only the locks this tx held or was waiting on
        this.lockManager.releaseLocksForTx(transactionId, transaction.heldLocks, transaction.waitingLocks);

        // Cleanup in-memory state
        this.pendingWrites.delete(transactionId);
        this.activeTransactions.delete(transactionId);
        this.finishedTransactions.set(transactionId, 'aborted');
        if (this.finishedTransactions.size > 1000) {
            const first = this.finishedTransactions.keys().next().value;
            if (first) this.finishedTransactions.delete(first);
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
            // Prototype-pollution guard — attacker-controlled JSON may contain
            // {"__proto__": ...} or {"constructor": {"prototype": ...}} which
            // would pollute Object.prototype if merged naively. hasOwnProperty
            // alone does NOT block __proto__ from JSON.parse.
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
            if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
            if (typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key]) &&
                typeof target[key] === 'object' && target[key] !== null && !Array.isArray(target[key])) {
                result[key] = this.deepMerge(target[key], source[key]);
            } else {
                result[key] = source[key];
            }
        }

        return result;
    }

    // Utility methods
    getTransactionStatus(transactionId: string): 'active' | 'committed' | 'aborted' | 'not_found' {
        const tx = this.activeTransactions.get(transactionId);
        if (tx) return tx.status;
        const finished = this.finishedTransactions.get(transactionId);
        if (finished) return finished;
        return 'not_found';
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
        this.flushCommittedBuffer(true);
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

    isKeyLocked(key: string): boolean {
        return this.lockManager.isKeyLocked(key);
    }

    isKeyInCommittedBuffer(key: string): boolean {
        return this.committedBuffer.has(key);
    }

    /**
     * Truncate WAL log with strict precondition checks.
     * Enforces that no active transactions exist, no pending uncommitted writes exist,
     * committedBuffer is drained, flushes committed buffer to disk, writes a CHECKPOINT,
     * and safely truncates the WAL.
     */
    truncateLog(): void {
        if (this.activeTransactions.size > 0) {
            throw new Error(`Cannot truncate WAL: ${this.activeTransactions.size} active transactions in progress`);
        }
        for (const [txId, writes] of this.pendingWrites) {
            if (writes.size > 0) {
                throw new Error(`Cannot truncate WAL: pending writes exist for transaction ${txId}`);
            }
        }
        if (this.committedBuffer.size > 0) {
            throw new Error(`Cannot truncate WAL: committed buffer not flushed (${this.committedBuffer.size} entries remaining)`);
        }
        this.flushCommittedBuffer(true);
        this.wal.forceFlush();
        this.wal.truncateLog();
    }

    /**
     * Flush the committedBuffer to data files. Called by the background timer
     * and by forceCheckpoint(). Writes buffered entries to data files using
     * the atomic temp→rename pattern. When unforced, processes in chunks to prevent
     * event loop starvation under sustained heavy write loads.
     */
    flushCommittedBuffer(forceFsync = false, maxBatch?: number): void {
        if (this.committedBuffer.size === 0) return;

        const syncNeeded = forceFsync || this.synchronous === 'full';
        const touchedDirs = new Set<string>();
        const limit = maxBatch !== undefined ? maxBatch : (forceFsync ? Infinity : this.checkpointBatchSize);

        let count = 0;
        for (const [key, entry] of this.committedBuffer) {
            if (count >= limit) break;
            count++;

            const filePath = partitionedPath(this.dbPath, key);
            touchedDirs.add(dirname(filePath));
            let success = false;
            if (entry.op === 'write') {
                try {
                    this.atomicWriteFile(filePath, JSON.stringify(entry.data), syncNeeded);
                    success = true;
                } catch (err) {
                    if (forceFsync) throw err;
                    // best-effort — WAL redo will handle on crash, retain in committedBuffer to retry
                } finally {
                    if (success) this.committedBuffer.delete(key);
                }
            } else if (entry.op === 'delete') {
                try {
                    if (existsSync(filePath)) unlinkSync(filePath);
                    success = true;
                } catch (err) {
                    if (forceFsync) throw err;
                    // retain in committedBuffer to retry
                } finally {
                    if (success) this.committedBuffer.delete(key);
                }
            }
        }

        if (syncNeeded) {
            for (const dir of touchedDirs) {
                try {
                    this.fsyncDir(dir);
                } catch (err) {
                    if (forceFsync) throw err;
                    /* approved: directory fsync best-effort in normal mode */
                }
            }
        }

        // If entries remain in buffer, yield event loop and continue draining on next tick
        if (this.committedBuffer.size > 0 && !forceFsync) {
            setImmediate(() => {
                if (this.committedBuffer.size > 0) {
                    this.flushCommittedBuffer(false);
                }
            });
        }
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

        // Final flush of any unflushed committed data (force=true: drain entire buffer before teardown)
        this.flushCommittedBuffer(true);

        // Clean up memory
        this.activeTransactions.clear();
        this.pendingWrites.clear();
        // WAL destroy stops the group-commit timer and forces a final fsync
        this.wal.destroy();
    }
}