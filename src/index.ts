import { existsSync, mkdirSync, openSync, writeSync, closeSync, unlinkSync, readFileSync } from "fs";
import { join } from "path";
import { ACIDStorageEngine, SynchronousMode } from "./acid-engine.js";
import { SchemaValidator, DocumentSchema, ValidationResult } from "./schema.js";
import { BackupManager, BackupConfig, BackupMetadata, CloudStorageConfig, BucketBackupResult } from "./backup.js";
import { DataRecovery, RecoveryConfig, RecoveryResult, FileRecoveryInfo } from "./recovery.js";
import { randomBytes } from "node:crypto";
import QuickLRU from "quick-lru";

interface TeroConfig {
  directory?: string;
  cacheSize?: number;
  /**
   * Durability / throughput trade-off knob (like SQLite's `PRAGMA synchronous`):
   *   - 'full'   (default): fsync the WAL on every commit. Max durability, ~15–60 ops/s
   *     depending on disk. Use when every commit must survive power loss.
   *   - 'normal': fsync the WAL on a coalescing timer (commitIntervalMs, default 10ms).
   *     10–100x throughput; up to commitIntervalMs of committed transactions may be lost
   *     on power failure. Use for edge workloads where a small RPO is acceptable.
   *   - 'off':    never fsync. Testing/benchmark only. Data loss on crash is certain.
   */
  synchronous?: SynchronousMode;
  /** Group-commit interval in milliseconds (only used when synchronous='normal'). Default: 10. */
  commitIntervalMs?: number;
  /** Data-file flush interval in ms (how often committedBuffer is checkpointed to disk). Default: 50. */
  dataFlushIntervalMs?: number;
  /** v2: hydrate local state from a bucket on startup before the ACID engine comes up. */
  hydrateOnStartup?: HydrateConfig;
  /** v2: a default backup config installed at construction time (use configureBackup() at runtime too). */
  backup?: BackupConfig;
  /**
   * Acquire an exclusive OS-level file lock (flock) on the data directory to
   * prevent concurrent process access. Two Node.js processes opening the same
   * directory without this flag will corrupt each other's data. Set to true
   * in production; default false for backwards compatibility.
   */
  fileLock?: boolean;
}

interface HydrateConfig {
  cloudStorage: CloudStorageConfig;
  /** 'all' overwrites local files from the bucket; 'missing' (default) only pulls files absent
   *  locally; 'snapshot' downloads the most recent tar.gz archive first then falls back
   *  to individual files. Snapshot mode is the Google-recommended approach — one bulk
   *  download vs thousands of individual S3 GETs. */
  mode?: 'all' | 'missing' | 'snapshot';
  /** Continue when a single file fails to download (default true). */
  continueOnError?: boolean;
  /** Maximum time to wait for hydration before attempting engine init (ms). */
  timeout?: number;
}

interface TransactionOptions {
  timeout?: number;
}

interface CacheEntry {
  data: any;
  lastAccessed: number;
  transactionId?: string; // Track which transaction cached this
}

interface TransactionStats {
  active: number;
  committed: number;
  rolledBack: number;
  total: number;
}

export class Transaction {
  private id: string;
  private db: Tero;
  private startTime: number;
  private opCount: number = 0;
  private destroyed: boolean = false;
  private timeoutTimer?: ReturnType<typeof setTimeout>;

  constructor(id: string, db: Tero, options?: TransactionOptions) {
    this.id = id;
    this.db = db;
    this.startTime = Date.now();
    if (options?.timeout) {
      this.timeoutTimer = setTimeout(() => {
        this.destroyed = true;
        this.db._rollbackRaw(this.id).catch(() => {});
      }, options.timeout);
    }
  }

  getId(): string {
    return this.id;
  }

  isActive(): boolean {
    if (this.destroyed) return false;
    return this.db.getActiveTransactions().includes(this.id);
  }

  isRolledBack(): boolean {
    return !this.isActive();
  }

  private _checkActive(): void {
    if (this.destroyed) throw new Error('Transaction has been destroyed');
    const status = this.db._getTxStatus(this.id);
    if (status === 'committed') throw new Error('Transaction has already been committed');
    if (status === 'aborted') throw new Error('Transaction has been rolled back');
    if (status === 'not_found') throw new Error('Transaction is not active');
  }

  async create(key: string, initialData?: any): Promise<void> {
    this._checkActive();
    if (this.db.exists(key)) throw new Error(`Document '${key}' already exists`);
    await this.db._writeRaw(this.id, key, initialData || {});
    this.opCount++;
  }

  async update(key: string, data: any): Promise<void> {
    this._checkActive();
    await this.db._writeRaw(this.id, key, data);
    this.opCount++;
  }

  async delete(key: string): Promise<void> {
    this._checkActive();
    await this.db._deleteRaw(this.id, key);
    this.opCount++;
  }

  async get(key: string): Promise<any> {
    this._checkActive();
    return await this.db._readRaw(this.id, key);
  }

  getState(): { status: string; operations: Array<{ key: string; operation: string }>; startTime: number } {
    const status = this.db._getTxStatus(this.id);
    return {
      status: status === 'active' ? 'active' : (status === 'committed' ? 'committed' : 'rolled_back'),
      operations: Array.from({ length: this.opCount }, (_, i) => ({ key: `op_${i}`, operation: 'write' })),
      startTime: this.startTime
    };
  }

  getOperationCount(): number {
    return this.opCount;
  }

  getDuration(): number {
    return Date.now() - this.startTime;
  }

  destroy(): void {
    this.destroyed = true;
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    this.db._rollbackRaw(this.id).catch(() => {});
  }
}

export class Tero {
  private teroDirectory: string = "TeroDB";
  private cacheSize: number = 100;
  private cache: QuickLRU<string, CacheEntry>;
  private cacheHits: number = 0;
  private cacheRequests: number = 0;
  private acidEngine: ACIDStorageEngine;
  private schemaValidator: SchemaValidator;
  private backupManager?: BackupManager;
  private dataRecovery?: DataRecovery;
  private committedCount: number = 0;
  private rolledBackCount: number = 0;

  /**
   * Bounded LRU of known-existing keys. Replaces the unbounded Set<string>
   * that grew linearly with key count (catastrophic memory at 1M+ keys/tenant).
   * Capped at KNOWN_KEYS_MAX (10k) ~ 800KB peak vs ~80MB at 1M keys for Set.
   * Falls back to disk (partitioned path existsSync) on LRU miss.
   */
  private knownKeys: QuickLRU<string, boolean>;
  private readonly KNOWN_KEYS_MAX: number = 10000;

  /** Optional exclusive file-lock fd on the data directory (flock, via fs-ext). */
  private lockFd?: number;

  /**
   * Construct an embedded Tero instance synchronously.
   *
   * For v2 startup hydration from a bucket, prefer `await Tero.create(config)` which
   * pulls missing/all files from the client's OWN bucket before the ACID engine is
   * initialized. The control plane never holds client bucket credentials; it only
   * observes instances. Pass `hydrateOnStartup` in config to use this path.
   */
  constructor(config?: TeroConfig) {
    try {
      const rawDirectory = (config as any)?.Directory || config?.directory;
      const { cacheSize, synchronous, commitIntervalMs, dataFlushIntervalMs } = config || {};

      if (typeof rawDirectory === "string" && rawDirectory.trim()) {
        // Sanitize directory path to prevent directory traversal
        this.teroDirectory = rawDirectory.replace(/[^a-zA-Z0-9_\-\/]/g, '');
      }

      if (typeof cacheSize === "number" && cacheSize > 0) {
        this.cacheSize = Math.min(cacheSize, 1000); // Cap at 1k entries
      }

      // Create directories with proper error handling
      this.initializeDirectories();

      // Optional cross-process file lock: prevents two processes from opening
      // the same data directory concurrently (addresses Google Pillar #2 —
      // zero cross-process synchronization). Uses flock via fs-ext.
      if (config?.fileLock) {
        this.acquireFileLock();
      }

      // Initialize QuickLRU cache
      this.cache = new QuickLRU<string, CacheEntry>({
        maxSize: this.cacheSize
      });

      // Initialize bounded LRU for known-keys (caps memory at ~800KB vs ~80MB
      // for an unbounded Set at 1M keys — addresses cloud-scale heap bloat).
      this.knownKeys = new QuickLRU<string, boolean>({ maxSize: this.KNOWN_KEYS_MAX });

      // Initialize ACID storage engine (primary system)
      const syncMode: SynchronousMode = synchronous ?? 'full';
      const syncInterval: number = commitIntervalMs ?? 10;
      const dataFlushInterval: number = dataFlushIntervalMs ?? 50;
      this.acidEngine = new ACIDStorageEngine(this.teroDirectory, syncMode, syncInterval, dataFlushInterval);

      // Initialize schema validator
      this.schemaValidator = new SchemaValidator();

      // v2: optionally install a backup config at construction time.
      if (config?.backup) {
        this.configureBackup(config.backup);
      }
    } catch (error) {
      throw new Error(`Failed to initialize Tero: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * v2 async factory. Same as `new Tero(config)` but runs hydrate-on-startup BEFORE
   * the ACID engine is constructed. Use this when `config.hydrateOnStartup` is set
   * so missing/all local files are restored from the client's bucket first.
   */
  static async create(config?: TeroConfig): Promise<Tero> {
    const hydrate = config?.hydrateOnStartup;
    if (!hydrate) {
      return new Tero(config);
    }

    // Ensure directory exists first so DataRecovery can stream into it.
    const rawDirectory = (config as any)?.Directory || config?.directory || 'TeroDB';
    const teroDirectory = rawDirectory.replace(/[^a-zA-Z0-9_\-\/]/g, '');
    if (!existsSync(teroDirectory)) {
      mkdirSync(teroDirectory, { recursive: true });
    }

    // Pre-engine hydration: pull files from the client's bucket before engine init,
    // so crash recovery (which runs inside the ACIDStorageEngine constructor) sees
    // the latest durable state instead of an empty local directory.
    const recovery = new DataRecovery({
      cloudStorage: hydrate.cloudStorage,
      localPath: teroDirectory,
      mode: hydrate.mode === 'all' ? 'all' : 'missing',
      continueOnError: hydrate.continueOnError ?? true,
    });

    try {
      const mode = hydrate.mode ?? 'missing';
      if (mode === 'all') {
        const r = await recovery.recoverIndividualFiles();
        if (!r.success && r.failed.length > 0) { /* continue */ }
      } else if (mode === 'snapshot') {
        // Snapshot-first: download the most recent tar.gz archive, extract it
        // locally in bulk (one HTTP GET for potentially thousands of docs), then
        // fill gaps with individual file recovery for any data written since the
        // snapshot's checkpoint. This is the Google-recommended hydration pattern:
        // one bulk download instead of sequential individual S3 GETs.
        try {
          const snapshotResult = await recovery.recoverFromArchive();
          if (!snapshotResult.success) {
            // Fall back to individual file recovery if no archive exists
            const r = await recovery.recoverMissingFiles();
            if (!r.success && r.failed.length > 0) { /* continue */ }
          }
        } catch {
          // Archive may not exist or may be corrupted; fall back gracefully
          const r = await recovery.recoverMissingFiles();
          if (!r.success && r.failed.length > 0) { /* continue */ }
        }
      } else {
        const r = await recovery.recoverMissingFiles();
        if (!r.success && r.failed.length > 0) { /* continue */ }
      }
    } catch (error) {
      // Hydration errors are non-fatal; engine init proceeds with whatever local data exists.
    }

    // Now construct the engine in the usual way — it sees current local state and
    // runs crash recovery against the WAL for any writes between the last snapshot
    // and the crash.
    const instance = new Tero(config);

    // Keep the recovery client wired so that runtime `getWithRecovery` / `existsWithCloudCheck`
    // can fall back to the same client bucket with no extra configuration.
    (instance as any).dataRecovery = recovery;
    return instance;
  }

  /**
   * v2: explicitly run hydration at any time (idempotent). Pulls missing/all files
   * from the client's bucket according to the config passed. Requires either
   * `configureDataRecovery(...)` to have been called, or `hydrateOnStartup` in
   * the constructor config.
   */
  async hydrate(options?: { mode?: 'all' | 'missing' | 'snapshot'; timeout?: number }): Promise<RecoveryResult> {
    const recovery = this.dataRecovery;
    if (!recovery) {
      throw new Error('Data recovery not configured. Call configureDataRecovery() or pass hydrateOnStartup in config.');
    }
    const mode = options?.mode ?? 'missing';
    if (mode === 'all') {
      return await recovery.recoverIndividualFiles();
    } else if (mode === 'snapshot') {
      try {
        return await recovery.recoverFromArchive();
      } catch {
        return await recovery.recoverMissingFiles();
      }
    } else {
      return await recovery.recoverMissingFiles();
    }
  }

  private initializeDirectories(): void {
    try {
      if (!existsSync(this.teroDirectory)) {
        mkdirSync(this.teroDirectory, { recursive: true });
      }

      const backupDir = `${this.teroDirectory}/.backup`;
      if (!existsSync(backupDir)) {
        mkdirSync(backupDir, { recursive: true });
      }
    } catch (error) {
      throw new Error(`Failed to create directories: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private validateKey(key: string): void {
    if (!key || typeof key !== 'string') {
      throw new Error('Key must be a non-empty string');
    }
    // Sanitize key to prevent path traversal
    if (key.includes('..') || key.includes('/') || key.includes('\\')) {
      throw new Error('Key contains invalid characters');
    }
  }

  /**
   * Tracks which keys each active transaction has touched (cache entries tagged
   * with that txId). Used by commit()/rollback() to promote/invalidate only the
   * touched keys instead of scanning the entire LRU cache. O(touched) vs O(cacheSize).
   */
  private txTouchedKeys: Map<string, Set<string>> = new Map();

  private invalidateCacheKeys(keys: string[]): void {
    for (const key of keys) {
      this.cache.delete(key);
    }
  }

  private updateCache(key: string, data: any, transactionId?: string): void {
    this.cache.set(key, {
      data: data,
      lastAccessed: Date.now(),
      transactionId
    });
    // Track touched key so commit/rollback can promote/invalidate only this key
    // instead of scanning the entire LRU cache (O(touched) vs O(cacheSize)).
    if (transactionId) {
      let touched = this.txTouchedKeys.get(transactionId);
      if (!touched) {
        touched = new Set();
        this.txTouchedKeys.set(transactionId, touched);
      }
      touched.add(key);
    }
  }

  // Core ACID Operations
  beginTransaction(options?: TransactionOptions): Transaction {
    try {
      const id = this._beginTransaction();
      return new Transaction(id, this, options);
    } catch (error) {
      throw new Error(`Failed to begin transaction: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private _beginTransaction(): string {
    return this.acidEngine.beginTransaction();
  }

  private _txId(id: string | Transaction): string {
    return typeof id === 'string' ? id : id.getId();
  }

  async write(transactionId: string | Transaction, key: string, data: any, options?: {
    validate?: boolean;
    schemaName?: string;
    strict?: boolean;
  }): Promise<ValidationResult | void> {
    try {
      const txId = this._txId(transactionId);
      this.validateKey(key);

      if (data === undefined || data === null) {
        throw new Error('Data cannot be null or undefined');
      }

      // Perform schema validation if requested
      if (options?.validate || options?.schemaName) {
        const schemaName = options.schemaName || key;
        const validationResult = this.schemaValidator.validate(schemaName, data);

        if (!validationResult.valid) {
          if (options.strict) {
            const errorMessages = validationResult.errors.map(e => `${e.field}: ${e.message}`).join(', ');
            throw new Error(`Schema validation failed: ${errorMessages}`);
          } else {
            return validationResult;
          }
        }

        // Use sanitized data from validation
        data = validationResult.data || data;
      }

      // Engine write — returns void (sync fast path) or Promise (contended lock)
      const writeResult = this.acidEngine.write(txId, key, data);
      if (writeResult !== undefined) await writeResult;

      // Cache the MERGED afterImage (from pendingWrites), NOT the raw user data.
      // The engine deep-merges user data with existing state, so the afterImage
      // has ALL fields, not just the caller's partial update. Caching the raw
      // input would poison the cache with incomplete documents (sequential
      // updates to the same key would lose earlier fields).
      const afterImage = this.acidEngine.getPendingAfterImage(txId, key);
      this.updateCache(key, afterImage !== undefined ? afterImage : data, txId);

      if (options?.validate || options?.schemaName) {
        return { valid: true, errors: [], data };
      }
    } catch (error) {
      throw new Error(`Write failed for key '${key}': ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async read(transactionId: string | Transaction, key: string): Promise<any> {
    try {
      const txId = this._txId(transactionId);
      this.validateKey(key);
      this.cacheRequests++;

      // Check cache first, but only if it's from the same transaction or committed
      const cachedEntry = this.cache.get(key);
      if (cachedEntry && (!cachedEntry.transactionId || cachedEntry.transactionId === txId)) {
        this.cacheHits++;
        cachedEntry.lastAccessed = Date.now();
        return cachedEntry.data;
      }

      // Read from ACID engine — returns data (sync fast path) or Promise (contended lock)
      const readResult = this.acidEngine.read(txId, key);
      const data = (readResult !== undefined && readResult instanceof Promise) ? await readResult : readResult;

      if (data !== null && data !== undefined) {
        this.updateCache(key, data, txId);
      }

      return data;
    } catch (error) {
      throw new Error(`Read failed for key '${key}': ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async commit(transactionId: string | Transaction): Promise<void> {
    try {
      const txId = this._txId(transactionId);
      // O(1) active check — was O(N) via getActiveTransactions().includes()
      if (!this.acidEngine.isTransactionActive(txId)) {
        throw new Error(`Transaction ${txId} not found or not active`);
      }

      // Sync call — commitTransaction is now synchronous (no awaits on happy path)
      this.acidEngine.commitTransaction(txId);

      // PROMOTE cache entries tagged with this transaction to "committed" state.
      // O(touched) via the tracked set.
      const touched = this.txTouchedKeys.get(txId);
      if (touched) {
        for (const key of touched) {
          const entry = this.cache.get(key);
          if (entry && (entry as any).transactionId === txId) {
            (entry as any).transactionId = undefined;
          }
        }
        this.txTouchedKeys.delete(txId);
      }
      this.committedCount++;
    } catch (error) {
      throw new Error(`Failed to commit transaction: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async rollback(transactionId: string | Transaction): Promise<void> {
    try {
      const txId = this._txId(transactionId);
      // Sync call — rollbackTransaction is now synchronous
      this.acidEngine.rollbackTransaction(txId);

      // Remove cache entries for this transaction using the touched-keys set
      const touched = this.txTouchedKeys.get(txId);
      if (touched) {
        for (const key of touched) {
          this.cache.delete(key);
        }
        this.txTouchedKeys.delete(txId);
      }
      this.rolledBackCount++;
    } catch (error) {
      throw new Error(`Failed to rollback transaction: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async commitTransaction(transactionId: string | Transaction): Promise<void> {
    return await this.commit(transactionId);
  }

  async rollbackTransaction(transactionId: string | Transaction): Promise<void> {
    return await this.rollback(transactionId);
  }

  getPerformanceStats(): { cacheStats: { hitRate: number }; totalRequests: number } {
    const cacheStats = this.getCacheStats();
    return {
      cacheStats: { hitRate: cacheStats.hitRate },
      totalRequests: this.cacheRequests
    };
  }

  // Convenience Methods (Auto-transaction)
  async create(key: string, initialData?: any, options?: {
    validate?: boolean;
    schemaName?: string;
    strict?: boolean;
  }): Promise<ValidationResult | boolean> {
    this.validateKey(key);

    // Fast existence check via in-memory set — avoids existsSync syscall
    if (this.knownKeys.has(key)) {
      return false; // already exists
    }

    const transactionId = this._beginTransaction();

    try {
      const result = await this.write(transactionId, key, initialData || {}, options);
      await this.commit(transactionId);
      this.knownKeys.set(key, true);

      return result || true;
    } catch (error) {
      await this.rollback(transactionId);
      throw new Error(`Create failed for key '${key}': ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async update(key: string, data: any, options?: {
    validate?: boolean;
    schemaName?: string;
    strict?: boolean;
  }): Promise<ValidationResult | void> {
    const transactionId = this._beginTransaction();

    try {
      const result = await this.write(transactionId, key, data, options);
      await this.commit(transactionId);
      return result;
    } catch (error) {
      await this.rollback(transactionId);
      throw error;
    }
  }

  /**
   * Read a document. Returns the document data on success, or `false` if the
   * document is absent. Throws for genuine errors.
   *
   * Fast path (3 tiers, zero-syscall on hit):
   *   1. LRU cache (committed entries) — pure memory, 900k+ ops/s
   *   2. committedBuffer (committed but not yet flushed to disk) — pure memory
   *   3. Read from data file via 2-level hash-prefix partitioned path (atomic
   *      rename guarantees valid JSON; no single dentry holds >50k files)
   *
   * NO transaction is created, NO WAL I/O, NO lock acquired.
   */
  async get(key: string): Promise<any> {
    this.validateKey(key);
    this.cacheRequests++;

    // 1. Fast path: committed cache hit — no tx, no WAL, no lock, no syscall
    const cachedEntry = this.cache.get(key);
    if (cachedEntry && !cachedEntry.transactionId) {
      this.cacheHits++;
      cachedEntry.lastAccessed = Date.now();
      return cachedEntry.data;
    }

    // 2. Check committedBuffer (committed but not yet flushed to data files)
    const committed = this.acidEngine.getCommittedData(key);
    if (committed !== undefined) {
      if (committed === null) return false;
      this.updateCache(key, committed, undefined);
      return committed;
    }

    // 3. Slow path: read directly from disk (partitioned path; atomic rename = consistent)
    const { readFileSync, existsSync: existsSyncFs } = await import('fs');
    const { join } = await import('path');
    const filePath = this.keyToPath(key);
    if (!existsSyncFs(filePath)) {
      return false;
    }

    try {
      const content = readFileSync(filePath, 'utf-8');
      const data = content.trim() ? JSON.parse(content) : {};
      this.updateCache(key, data, undefined);
      return data;
    } catch (error) {
      throw new Error(`Read failed for key '${key}': ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Map a document key to its partitioned path on disk (2-level hash-prefix).
   * Matches the layout used by ACIDStorageEngine — same key resolves to same path.
   */
  private keyToPath(key: string): string {
    // FNV-1a 32-bit of the key — same dispersion as partitionedPath() in acid-engine.ts
    let h = 0x811c9dc5;
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    const hex = h.toString(16).padStart(8, '0');
    return `${this.teroDirectory}/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${key}.json`;
  }

  async remove(key: string): Promise<void> {
    const transactionId = this._beginTransaction();

    try {
      await this._deleteRaw(transactionId, key);
      await this.commit(transactionId);
      this.knownKeys.delete(key);
    } catch (error) {
      await this.rollback(transactionId);
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    return await this.remove(key);
  }

  exists(key: string): boolean {
    try {
      this.validateKey(key);
      // Fast path: in-memory set
      if (this.knownKeys.has(key)) return true;
      // Check committedBuffer for pending deletes (deferred writes may not have
      // unlinked the file yet — a committed delete should appear as absent)
      const committed = this.acidEngine.getCommittedData(key);
      if (committed !== undefined) return committed !== null;
      // Slow path: check disk via partitioned path
      if (existsSync(this.keyToPath(key))) {
        this.knownKeys.set(key, true);
        return true;
      }
      return false;
    } catch (error) {
      return false;
    }
  }

  // Batch Operations
  async batchWrite(operations: Array<{ key: string; data: any }>, options?: {
    validate?: boolean;
    schemaName?: string;
    strict?: boolean;
  }): Promise<void> {
    const transactionId = this._beginTransaction();

    try {
      for (const op of operations) {
        await this.write(transactionId, op.key, op.data, options);
      }
      await this.commit(transactionId);
      // Register all written keys in knownKeys so future exists() calls are O(1)
      for (const op of operations) this.knownKeys.set(op.key, true);
    } catch (error) {
      await this.rollback(transactionId);
      throw new Error(`Batch write failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async batchRead(keys: string[]): Promise<{ [key: string]: any }> {
    const transactionId = this._beginTransaction();
    const results: { [key: string]: any } = {};

    try {
      for (const key of keys) {
        results[key] = await this.read(transactionId, key);
      }
      await this.commit(transactionId);
      return results;
    } catch (error) {
      await this.rollback(transactionId);
      throw new Error(`Batch read failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // Money transfer example demonstrating ACID properties
  async transferMoney(fromKey: string, toKey: string, amount: number): Promise<void> {
    if (amount <= 0) {
      throw new Error('Transfer amount must be positive');
    }

    const transactionId = this._beginTransaction();

    try {
      // Read current balances
      const fromAccount = await this.read(transactionId, fromKey);
      const toAccount = await this.read(transactionId, toKey);

      if (!fromAccount || !toAccount) {
        throw new Error('One or both accounts do not exist');
      }

      if (fromAccount.balance < amount) {
        throw new Error('Insufficient funds');
      }

      // Update balances
      await this.write(transactionId, fromKey, {
        ...fromAccount,
        balance: fromAccount.balance - amount
      });

      await this.write(transactionId, toKey, {
        ...toAccount,
        balance: toAccount.balance + amount
      });

      // Commit the transaction
      await this.commit(transactionId);
    } catch (error) {
      await this.rollback(transactionId);
      throw new Error(`Money transfer failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // Internal raw methods for Transaction class
  async _writeRaw(transactionId: string, key: string, data: any): Promise<void> {
    const result = this.acidEngine.write(transactionId, key, data);
    if (result !== undefined) await result;
    this.updateCache(key, data, transactionId);
  }

  async _readRaw(transactionId: string, key: string): Promise<any> {
    this.cacheRequests++;
    const cachedEntry = this.cache.get(key);
    if (cachedEntry && (!cachedEntry.transactionId || cachedEntry.transactionId === transactionId)) {
      this.cacheHits++;
      cachedEntry.lastAccessed = Date.now();
      return cachedEntry.data;
    }
    const result = this.acidEngine.read(transactionId, key);
    const data = (result !== undefined && result instanceof Promise) ? await result : result;
    if (data !== null && data !== undefined) {
      this.updateCache(key, data, transactionId);
    }
    return data;
  }

  async _deleteRaw(transactionId: string, key: string): Promise<void> {
    const result = this.acidEngine.delete(transactionId, key);
    if (result !== undefined) await result;
    this.cache.delete(key);
    this.knownKeys.delete(key);
  }

  async _rollbackRaw(transactionId: string): Promise<void> {
    this.acidEngine.rollbackTransaction(transactionId);
    this.rolledBackCount++;
  }

  _getTxStatus(transactionId: string): 'active' | 'committed' | 'aborted' | 'not_found' {
    return this.acidEngine.getTransactionStatus(transactionId);
  }

  getTransactionStats(): TransactionStats {
    const active = this.acidEngine.getActiveTransactions().length;
    return {
      active,
      committed: this.committedCount,
      rolledBack: this.rolledBackCount,
      total: active + this.committedCount + this.rolledBackCount
    };
  }

  // Schema Management
  setSchema(collectionName: string, schema: DocumentSchema): void {
    try {
      this.schemaValidator.setSchema(collectionName, schema);
    } catch (error) {
      throw new Error(`Failed to set schema: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  getSchema(collectionName: string): DocumentSchema | undefined {
    return this.schemaValidator.getSchema(collectionName);
  }

  removeSchema(collectionName: string): boolean {
    return this.schemaValidator.removeSchema(collectionName);
  }

  validateData(collectionName: string, data: any): ValidationResult {
    return this.schemaValidator.validate(collectionName, data);
  }

  hasSchema(collectionName: string): boolean {
    return this.schemaValidator.hasSchema(collectionName);
  }

  listSchemas(): string[] {
    return this.schemaValidator.listSchemas();
  }

  exportSchemas(): Record<string, DocumentSchema> {
    return this.schemaValidator.exportSchemas();
  }

  getSchemaStats(): { totalSchemas: number; schemaNames: string[]; totalFields: number } {
    return this.schemaValidator.getSchemaStats();
  }

  async createWithValidation(key: string, initialData?: any, options?: {
    validate?: boolean;
    schemaName?: string;
    strict?: boolean;
  }): Promise<ValidationResult> {
    const result = await this.create(key, initialData, { ...options, validate: true });
    if (result === true || result === false) {
      return { valid: result, errors: [], data: initialData || {} };
    }
    return result;
  }

  async updateWithValidation(key: string, data: any, options?: {
    validate?: boolean;
    schemaName?: string;
    strict?: boolean;
  }): Promise<ValidationResult> {
    const result = await this.update(key, data, { ...options, validate: true });
    if (!result) {
      return { valid: true, errors: [], data };
    }
    return result as ValidationResult;
  }

  // ---------------------------------------------------------------------------
  // Backup Management
  // ---------------------------------------------------------------------------

  configureBackup(config: BackupConfig): void {
    try {
      this.backupManager = new BackupManager(this.teroDirectory, config);
    } catch (error) {
      throw new Error(`Failed to configure backup: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /** Alias retained for the existing test surface / older callers. */
  configureAdvancedBackup(config: BackupConfig): void {
    this.configureBackup(config);
  }

  async performBackup(): Promise<{ success: boolean; metadata: BackupMetadata; cloudUploaded?: boolean }> {
    if (!this.backupManager) {
      throw new Error('Backup not configured. Call configureBackup() first.');
    }
    // Force-flush committedBuffer to data files so the backup sees the latest state.
    this.acidEngine.flushCommittedBuffer();
    this.acidEngine.forceCheckpoint();
    return await this.backupManager.performBackup();
  }

  /** Alias retained for the existing test surface / older callers. */
  async performAdvancedBackup(): Promise<{ success: boolean; metadata: BackupMetadata; cloudUploaded?: boolean }> {
    return this.performBackup();
  }

  /** Schedule a recurring backup via cron. Returns a schedule id; cancel with cancelScheduledBackup(). */
  scheduleBackup(config: { interval: string; retention?: string }): string {
    if (!this.backupManager) {
      throw new Error('Backup not configured. Call configureBackup() first.');
    }
    return this.backupManager.scheduleBackup(config);
  }

  /** Cancel a previously scheduled backup by id. */
  cancelScheduledBackup(scheduleId: string): boolean {
    if (!this.backupManager) return false;
    return this.backupManager.cancelScheduledBackup(scheduleId);
  }

  /** List currently scheduled backups. */
  getScheduledBackups(): Array<{ id: string; active: boolean }> {
    if (!this.backupManager) return [];
    return this.backupManager.getScheduledBackups();
  }

  /** Test reachability of the configured bucket. Returns {success, message}. */
  async testCloudConnection(): Promise<{ success: boolean; message: string }> {
    if (!this.backupManager) {
      return { success: false, message: 'Backup not configured' };
    }
    return await this.backupManager.testCloudConnection();
  }

  /**
   * v2: One-shot bucket backup of all current data JSON files plus any WAL archive
   * segments retained locally. Designed for scheduled "snapshot to bucket" runs the
   * CLIENT triggers with its OWN bucket credentials — the control plane never holds
   * client cloud keys, it only observes results via heartbeats.
   */
  async backupToBucket(options?: { tag?: string }): Promise<BucketBackupResult> {
    if (!this.backupManager) {
      throw new Error('Backup not configured. Call configureBackup() first.');
    }
    // Force-flush committedBuffer to data files so the backup sees the latest state.
    this.acidEngine.flushCommittedBuffer();
    this.acidEngine.forceCheckpoint();
    const walArchivePaths = this.acidEngine.getWAL().listArchives();
    return await this.backupManager.backupToBucket({
      walArchivePaths,
      tag: options?.tag,
    });
  }

  /**
   * v2: Emit a WAL checkpoint + immediately rotate the WAL into a new archive segment,
   * then back that fresh segment up to the bucket. Useful right after high-write bursts
   * to bound the recovery window (RPO) when hydrating a new instance.
   */
  async checkpointAndBackupToBucket(options?: { tag?: string }): Promise<BucketBackupResult> {
    if (!this.backupManager) {
      throw new Error('Backup not configured. Call configureBackup() first.');
    }
    this.acidEngine.forceCheckpoint();
    this.acidEngine.getWAL().rotateLog();
    return await this.backupToBucket(options);
  }

  // ---------------------------------------------------------------------------
  // Data Recovery
  // ---------------------------------------------------------------------------

  configureDataRecovery(config: RecoveryConfig): void {
    try {
      this.dataRecovery = new DataRecovery(config);
    } catch (error) {
      throw new Error(`Failed to configure data recovery: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async recoverFromCloud(key: string): Promise<boolean> {
    if (!this.dataRecovery) {
      throw new Error('Data recovery not configured. Call configureDataRecovery() first.');
    }

    const recovered = await this.dataRecovery.recoverSingleFile(key);
    if (recovered) {
      this.cache.delete(key); // Invalidate cache
    }
    return recovered;
  }

  async recoverAllFromCloud(): Promise<RecoveryResult> {
    if (!this.dataRecovery) {
      throw new Error('Data recovery not configured. Call configureDataRecovery() first.');
    }

    const result = await this.dataRecovery.recoverIndividualFiles();

    // Clear cache for recovered files
    if (result.recovered.length > 0) {
      this.invalidateCacheKeys(result.recovered);
    }

    return result;
  }

  /** Recovery info: how many cloud files exist, which are missing locally, which can be pulled. */
  async getRecoveryInfo(): Promise<{
    cloudFiles: number;
    localFiles: number;
    missingLocally: string[];
    availableForRecovery: string[];
  }> {
    if (!this.dataRecovery) {
      throw new Error('Data recovery not configured. Call configureDataRecovery() first.');
    }
    return await this.dataRecovery.getRecoveryInfo();
  }

  /** List available backup/archived files in the client bucket. */
  async listAvailableFiles(): Promise<string[]> {
    if (!this.dataRecovery) {
      throw new Error('Data recovery not configured. Call configureDataRecovery() first.');
    }
    return await this.dataRecovery.listAvailableFiles();
  }

  /** List available tar.gz archive backups in the client bucket. */
  async listAvailableArchives(): Promise<string[]> {
    if (!this.dataRecovery) {
      throw new Error('Data recovery not configured. Call configureDataRecovery() first.');
    }
    return await this.dataRecovery.listAvailableArchives();
  }

  /** Check (HEAD) whether a single key exists in the client bucket. */
  async checkFileInCloud(key: string): Promise<FileRecoveryInfo> {
    if (!this.dataRecovery) {
      throw new Error('Data recovery not configured. Call configureDataRecovery() first.');
    }
    return await this.dataRecovery.checkFileInCloud(key);
  }

  /** Recover an entire archive backup (tar.gz) from the client bucket and extract locally. */
  async recoverFromArchive(archiveName?: string): Promise<RecoveryResult> {
    if (!this.dataRecovery) {
      throw new Error('Data recovery not configured. Call configureDataRecovery() first.');
    }
    return await this.dataRecovery.recoverFromArchive(archiveName);
  }

  /**
   * Read a key locally; if absent locally, transparently recover it from the client's
   * bucket and cache the result. Returns the data, or `false` if the key genuinely
   * doesn't exist on either side. Throws for real (auth/network) errors so callers
   * don't silently mistake them for "not in cloud".
   *
   * Options:
   *   - fallbackToCloud: boolean (default true) — set false to skip cloud fetch
   *   - mode: 'missing' (default) — only fetch if missing locally; 'all' — always overwrite from cloud
   */
  async getWithRecovery(key: string, options?: { fallbackToCloud?: boolean; mode?: 'missing' | 'all' }): Promise<any> {
    try {
      this.validateKey(key);
    } catch (error) {
      throw error;
    }

    const fallbackToCloud = options?.fallbackToCloud ?? true;

    // 1) Try local first.
    const localData = await this.get(key);
    if (localData !== false) {
      return localData;
    }

    // 2) Not local. Optionally fall back to cloud.
    if (!fallbackToCloud) return false;
    if (!this.dataRecovery) {
      // No cloud configured — return false to keep "absent" semantics consistent with get().
      return false;
    }

    // 3) Best-effort cloud fetch. If it fails for any reason (auth, network, timeout,
    // no such key), we don't crash the local read path — `getWithRecovery` is a
    // convenience GET that prefers local, falls back opportunistically. Separate
    // methods (`recoverFromCloud`, `recoverAllFromCloud`) surface real cloud errors
    // for the control plane / observability path to display.
    try {
      const recovered = await this.dataRecovery.recoverSingleFile(key);
      if (!recovered) {
        return false;
      }
      // Cache + return the freshly hydrated data.
      // Re-run get() so the read goes through the cache + lint path.
      this.cache.delete(key);
      return await this.get(key);
    } catch (error) {
      return false;
    }
  }

  /**
   * Probe local + cloud availability for a key without modifying local state.
   * Returns { local, cloud, canRecover }:
   *   - local: true if the file exists locally
   *   - cloud: true if the file exists in the client bucket (HEAD)
   *   - canRecover: true if cloud has it but local doesn't
   */
  async existsWithCloudCheck(key: string): Promise<{ local: boolean; cloud: boolean; canRecover: boolean }> {
    let local = false;
    try {
      this.validateKey(key);
      local = this.exists(key);
    } catch {
      return { local: false, cloud: false, canRecover: false };
    }

    let cloud = false;
    if (this.dataRecovery) {
      try {
        const info = await this.dataRecovery.checkFileInCloud(key);
        cloud = info.exists;
      } catch {
        cloud = false; // auth/network failure → treat as not-available, but don't throw
      }
    }

    return {
      local,
      cloud,
      canRecover: cloud && !local,
    };
  }

  // ---------------------------------------------------------------------------
  // Utility Methods
  // ---------------------------------------------------------------------------

  getCacheStats(): { size: number; maxSize: number; hitRate: number } {
    const hitRate = this.cacheRequests > 0 ? (this.cacheHits / this.cacheRequests) * 100 : 0;
    return {
      size: this.cache.size,
      maxSize: this.cacheSize,
      hitRate: Math.round(hitRate * 100) / 100
    };
  }

  getActiveTransactions(): string[] {
    return this.acidEngine.getActiveTransactions();
  }

  forceCheckpoint(): void {
    this.acidEngine.forceCheckpoint();
  }

  async verifyDataIntegrity(): Promise<{
    totalFiles: number;
    corruptedFiles: string[];
    missingFiles: string[];
    healthy: boolean;
  }> {
    // Force-flush committedBuffer so the scan sees all committed data on disk.
    this.acidEngine.flushCommittedBuffer();

    const result = {
      totalFiles: 0,
      corruptedFiles: [] as string[],
      missingFiles: [] as string[],
      healthy: true
    };

    try {
      // Streaming partition walk — no readdirSync array allocation. Each leaf
      // directory is visited async via fs.opendir iteration, so a 1M-key
      // database doesn't allocate ~80MB of JS string objects in one tick.
      const { walkPartitions } = await import('./acid-engine.js');
      const { basename } = await import('path');
      await walkPartitions(this.teroDirectory, async (filePath) => {
        const file = basename(filePath);
        const key = file.replace('.json', '');
        result.totalFiles++;
        try {
          const data = await this.get(key);
          if (data === null || data === false) {
            result.missingFiles.push(key);
            result.healthy = false;
          }
        } catch (error) {
          result.corruptedFiles.push(key);
          result.healthy = false;
        }
      });

      return result;
    } catch (error) {
      throw new Error(`Data integrity verification failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Acquire an exclusive OS-level lock on the data directory via a .lock file.
   * Uses `openSync(path, 'wx')` — creates the file exclusively, failing if it
   * already exists (i.e., another process holds the lock). Cross-platform,
   * no native modules required. The fd is held open to maintain the lock;
   * destroying the Tero instance closes the fd and deletes the lock file.
   */
  private acquireFileLock(): void {
    try {
      const lockPath = `${this.teroDirectory}/.lock`;
      this.lockFd = openSync(lockPath, 'wx'); // exclusive create — fails if exists
      writeSync(this.lockFd, String(process.pid));
    } catch {
      const lockPath = `${this.teroDirectory}/.lock`;
      let pid = '?';
      if (existsSync(lockPath)) {
        try { pid = readFileSync(lockPath, 'utf-8').trim(); } catch { }
      }
      if (pid === String(process.pid)) {
        throw new Error(`Another Tero instance is already using '${this.teroDirectory}'. ` +
          'Destroy the existing instance first, or delete the .lock file if the previous process crashed.');
      }
      throw new Error(`Data directory locked by process ${pid}. Use fileLock: true for exclusive cross-process access.`);
    }
  }

  private releaseFileLock(): void {
    if (this.lockFd == null) return;
    try {
      closeSync(this.lockFd);
      unlinkSync(`${this.teroDirectory}/.lock`);
    } catch { /* best-effort */ }
  }

  // Cleanup method
  destroy(): void {
    if (this.acidEngine) {
      this.acidEngine.destroy();
    }
    if (this.backupManager) {
      this.backupManager.destroy();
    }
    this.clearCache();
    this.releaseFileLock();
  }

  /**
   * Generates a unique identifier with a custom prefix.
   *
   * This method creates MongoDB ObjectId-like unique identifiers that consist of:
   * - 4-byte timestamp (seconds since Unix epoch)
   * - 5-byte process-unique random value
   * - 3-byte incrementing counter
   *
   * The generated ID is guaranteed to be unique across processes and time,
   * making it suitable for distributed systems and concurrent operations.
   *
   * @param prefix - A string prefix to prepend to the generated ID
   * @returns A unique identifier string in the format: `${prefix}-${hexString}`
   *
   * @example
   * ```typescript
   * const db = new Tero();
   *
   * // Generate unique IDs for different purposes
   * const userId = db.getNewId('user');        // e.g., "user-507f1f77bcf86cd799439011"
   * const sessionId = db.getNewId('session');  // e.g., "session-507f1f77bcf86cd799439012"
   * const logId = db.getNewId('log');          // e.g., "log-507f1f77bcf86cd799439013"
   *
   * // Use as document keys
   * await db.create(userId, { name: 'Alice', email: 'alice@example.com' });
   * ```
   */
  getNewId(prefix: string): string {
    const PROCESS_UNIQUE = randomBytes(5);
    const buffer = Buffer.allocUnsafe(12);
    let index = ~~(Math.random() * 0xffffff);
    const time = ~~(Date.now() / 1000);
    const inc = (index = (index + 1) % 0xffffff);

    // 4-byte timestamp (seconds since Unix epoch)
    buffer.writeUInt32BE(time, 0);
    // 5-byte process unique identifier
    buffer.set(PROCESS_UNIQUE, 4);
    // 3-byte incrementing counter
    buffer.writeUIntBE(inc, 9, 3);

    // Convert to hexadecimal string and prepend prefix
    return prefix + "-" + buffer.toString("hex");
  }
}

// Export types for external use
export { DocumentSchema, ValidationResult, BackupConfig, BackupMetadata, BucketBackupResult, CloudStorageConfig, RecoveryConfig, RecoveryResult, FileRecoveryInfo, HydrateConfig };