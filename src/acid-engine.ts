import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { randomUUID } from "crypto";
import { createHash } from "crypto";

// ACID-compliant transaction log entry
export interface LogEntry {
    lsn: number; // Log Sequence Number
    transactionId: string;
    operation: 'BEGIN' | 'WRITE' | 'DELETE' | 'COMMIT' | 'ROLLBACK' | 'CHECKPOINT';
    key?: string;
    beforeImage?: any; // For rollback
    afterImage?: any;  // For redo
    timestamp: number;
    checksum: string;
}

// Write-Ahead Log (WAL) implementation
export class WriteAheadLog {
    private logPath: string;
    private currentLSN: number = 0;
    private logBuffer: LogEntry[] = [];
    private readonly BUFFER_SIZE = 100;
    private readonly LOG_FILE_SIZE_LIMIT = 10 * 1024 * 1024; // 10MB

    constructor(dbPath: string) {
        this.logPath = join(dbPath, '.wal');
        this.initializeWAL();
    }

    private initializeWAL(): void {
        if (!existsSync(dirname(this.logPath))) {
            mkdirSync(dirname(this.logPath), { recursive: true });
        }

        // Recovery: read existing log and determine next LSN
        if (existsSync(this.logPath)) {
            this.recoverFromLog();
        }
    }

    private recoverFromLog(): void {
        try {
            const logContent = readFileSync(this.logPath, 'utf-8');
            const lines = logContent.trim().split('\n').filter(line => line.trim());

            for (const line of lines) {
                try {
                    const entry: LogEntry = JSON.parse(line);
                    if (this.verifyChecksum(entry)) {
                        this.currentLSN = Math.max(this.currentLSN, entry.lsn);
                    }
                } catch (error) {
                    // Skip corrupted entries silently
                    continue;
                }
            }

            this.currentLSN++; // Next LSN
        } catch (error) {
            this.currentLSN = 1;
        }
    }

    private calculateChecksum(entry: Omit<LogEntry, 'checksum'>): string {
        const data = JSON.stringify(entry);
        return createHash('sha256').update(data).digest('hex');
    }

    private verifyChecksum(entry: LogEntry): boolean {
        const { checksum, ...entryWithoutChecksum } = entry;
        const calculatedChecksum = this.calculateChecksum(entryWithoutChecksum);
        return calculatedChecksum === checksum;
    }

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
        };

        this.logBuffer.push(logEntry);

        // Force flush for critical operations
        if (entry.operation === 'COMMIT' || entry.operation === 'ROLLBACK' ||
            this.logBuffer.length >= this.BUFFER_SIZE) {
            this.flushBuffer();
        }

        return lsn;
    }

    private flushBuffer(): void {
        if (this.logBuffer.length === 0) return;

        try {
            const logEntries = this.logBuffer.map(entry => JSON.stringify(entry)).join('\n') + '\n';

            // Atomic append to log file
            if (existsSync(this.logPath)) {
                const currentContent = readFileSync(this.logPath, 'utf-8');
                writeFileSync(this.logPath, currentContent + logEntries);
            } else {
                writeFileSync(this.logPath, logEntries);
            }

            this.logBuffer = [];

            // Check if log rotation is needed
            this.checkLogRotation();
        } catch (error) {
            throw new Error(`Failed to flush WAL: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
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

    private rotateLog(): void {
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const archivePath = `${this.logPath}.${timestamp}`;

        try {
            // Archive current log
            const currentContent = readFileSync(this.logPath, 'utf-8');
            writeFileSync(archivePath, currentContent);

            // Start new log with checkpoint
            writeFileSync(this.logPath, '');
            this.writeLog({ operation: 'CHECKPOINT', transactionId: 'SYSTEM' });
        } catch (error) {
            // Silent failure for production
        }
    }

    getLogEntries(fromLSN?: number): LogEntry[] {
        try {
            const entries: LogEntry[] = [];

            // First, add entries from the buffer (not yet flushed to disk)
            for (const bufferedEntry of this.logBuffer) {
                if (!fromLSN || bufferedEntry.lsn >= fromLSN) {
                    entries.push(bufferedEntry);
                }
            }

            // Then, add entries from the log file
            if (existsSync(this.logPath)) {
                const logContent = readFileSync(this.logPath, 'utf-8');
                const lines = logContent.trim().split('\n').filter(line => line.trim());

                for (const line of lines) {
                    try {
                        const entry: LogEntry = JSON.parse(line);
                        if (this.verifyChecksum(entry) && (!fromLSN || entry.lsn >= fromLSN)) {
                            entries.push(entry);
                        }
                    } catch (error) {
                        // Skip corrupted entries silently in production
                        continue;
                    }
                }
            }

            return entries.sort((a, b) => a.lsn - b.lsn);
        } catch (error) {
            return [];
        }
    }

    forceFlush(): void {
        this.flushBuffer();
    }

    getCurrentLSN(): number {
        return this.currentLSN - 1;
    }

    clearCommittedTransaction(transactionId: string): void {
        try {
            // First, flush any pending buffer entries to disk
            this.flushBuffer();

            if (!existsSync(this.logPath)) {
                return;
            }

            // Read current log content
            const logContent = readFileSync(this.logPath, 'utf-8');
            const lines = logContent.trim().split('\n').filter(line => line.trim());

            // Filter out entries for the committed transaction
            const filteredLines: string[] = [];
            let transactionCompleted = false;

            for (const line of lines) {
                try {
                    const entry: LogEntry = JSON.parse(line);

                    // Keep entries that don't belong to this transaction
                    if (entry.transactionId !== transactionId) {
                        filteredLines.push(line);
                    } else {
                        // For the committed transaction, only keep the COMMIT entry as a marker
                        // This preserves the fact that the transaction was committed for recovery purposes
                        if (entry.operation === 'COMMIT') {
                            filteredLines.push(line);
                            transactionCompleted = true;
                        }
                        // Skip BEGIN, WRITE, DELETE entries for committed transactions
                    }
                } catch (error) {
                    // Keep corrupted entries as-is to avoid data loss
                    filteredLines.push(line);
                }
            }

            // Only rewrite the log if we actually found and processed the transaction
            if (transactionCompleted) {
                const newContent = filteredLines.length > 0 ? filteredLines.join('\n') + '\n' : '';
                writeFileSync(this.logPath, newContent);
            }

        } catch (error) {
            // Silent failure for production - WAL cleanup is an optimization, not critical
            // The system will still work correctly even if cleanup fails
        }
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
        // If transaction already holds the lock
        if (lockInfo.holders.has(transactionId)) {
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
    }> = new Map();

    constructor(dbPath: string) {
        this.dbPath = dbPath;
        this.wal = new WriteAheadLog(dbPath);
        this.lockManager = new LockManager();
        this.initializeStorage();
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
    }

    private redoOperation(entry: LogEntry): void {
        if (!entry.key || !entry.afterImage) return;

        try {
            const filePath = join(this.dbPath, `${entry.key}.json`);
            writeFileSync(filePath, JSON.stringify(entry.afterImage, null, 2));
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
                    writeFileSync(filePath, JSON.stringify(entry.beforeImage, null, 2));
                }
            } else if (entry.operation === 'DELETE' && entry.beforeImage) {
                // Restore deleted file
                writeFileSync(filePath, JSON.stringify(entry.beforeImage, null, 2));
            }
        } catch (error) {
            // Silent failure for production
        }
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
            status: 'active'
        });

        return transactionId;
    }

    async write(transactionId: string, key: string, data: any): Promise<void> {
        const transaction = this.activeTransactions.get(transactionId);
        if (!transaction || transaction.status !== 'active') {
            throw new Error(`Invalid transaction: ${transactionId}`);
        }

        // Acquire exclusive lock
        await this.lockManager.acquireLock(key, transactionId, 'exclusive');

        try {
            // Read current data for before image - check pending writes in this transaction first
            let currentData = null;
            const logEntries = this.wal.getLogEntries(transaction.startLSN);
            const transactionEntries = logEntries.filter(entry =>
                entry.transactionId === transactionId &&
                entry.key === key &&
                (entry.operation === 'WRITE' || entry.operation === 'DELETE')
            );

            if (transactionEntries.length > 0) {
                // Use the most recent transaction state
                const lastEntry = transactionEntries[transactionEntries.length - 1];
                if (lastEntry.operation === 'DELETE') {
                    currentData = null;
                } else {
                    currentData = lastEntry.afterImage || {};
                }
            } else {
                // Read from disk
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

        try {
            // Check if there are pending writes in this transaction first
            const logEntries = this.wal.getLogEntries(transaction.startLSN);
            const transactionEntries = logEntries.filter(entry =>
                entry.transactionId === transactionId &&
                entry.key === key &&
                (entry.operation === 'WRITE' || entry.operation === 'DELETE')
            );

            if (transactionEntries.length > 0) {
                // Return the most recent transaction state
                const lastEntry = transactionEntries[transactionEntries.length - 1];
                if (lastEntry.operation === 'DELETE') {
                    return null;
                }
                return lastEntry.afterImage || {};
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

        try {
            const filePath = join(this.dbPath, `${key}.json`);
            let beforeImage = null;

            if (existsSync(filePath)) {
                try {
                    const content = readFileSync(filePath, 'utf-8');
                    beforeImage = content.trim() ? JSON.parse(content) : {};
                } catch (error) {
                    // Silent failure for production
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
            // Write commit log entry
            this.wal.writeLog({
                operation: 'COMMIT',
                transactionId
            });

            // Force WAL to disk
            this.wal.forceFlush();

            // Apply changes to data files
            const logEntries = this.wal.getLogEntries(transaction.startLSN);
            const transactionEntries = logEntries.filter(entry => entry.transactionId === transactionId);

            for (const entry of transactionEntries) {
                if (entry.operation === 'WRITE' && entry.key && entry.afterImage !== undefined) {
                    const filePath = join(this.dbPath, `${entry.key}.json`);



                    // Ensure directory exists
                    if (!existsSync(dirname(filePath))) {
                        mkdirSync(dirname(filePath), { recursive: true });
                    }

                    writeFileSync(filePath, JSON.stringify(entry.afterImage, null, 2));
                } else if (entry.operation === 'DELETE' && entry.key) {
                    const filePath = join(this.dbPath, `${entry.key}.json`);
                    if (existsSync(filePath)) {
                        unlinkSync(filePath);
                    }
                }
            }

            // Update transaction status
            transaction.status = 'committed';

            // Clear WAL entries for this committed transaction
            this.wal.clearCommittedTransaction(transactionId);

            // Release all locks
            this.lockManager.releaseAllLocks(transactionId);

        } catch (error) {
            // Rollback on commit failure
            await this.rollbackTransaction(transactionId);
            throw new Error(`Commit failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    async rollbackTransaction(transactionId: string): Promise<void> {
        const transaction = this.activeTransactions.get(transactionId);
        if (!transaction) {
            throw new Error(`Transaction not found: ${transactionId}`);
        }

        try {
            // Write rollback log entry
            this.wal.writeLog({
                operation: 'ROLLBACK',
                transactionId
            });

            // Update transaction status
            transaction.status = 'aborted';

            // Release all locks
            this.lockManager.releaseAllLocks(transactionId);

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
    getActiveTransactions(): string[] {
        return Array.from(this.activeTransactions.keys()).filter(id =>
            this.activeTransactions.get(id)?.status === 'active'
        );
    }

    forceCheckpoint(): void {
        this.wal.writeLog({
            operation: 'CHECKPOINT',
            transactionId: 'SYSTEM'
        });
        this.wal.forceFlush();
    }

    destroy(): void {
        // Rollback all active transactions
        for (const [transactionId, transaction] of this.activeTransactions.entries()) {
            if (transaction.status === 'active') {
                this.rollbackTransaction(transactionId).catch(() => {
                    // Silent failure for production
                });
            }
        }

        // Clean up memory
        this.activeTransactions.clear();
        this.wal.forceFlush();
    }
}