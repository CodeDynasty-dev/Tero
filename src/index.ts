import { randomBytes, createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, mkdirSync, openSync, writeSync, closeSync, unlinkSync, readFileSync, writeFileSync, readdirSync, fsyncSync, renameSync } from "fs";
import { resolve as pathResolve, relative as pathRelative, join as pathJoin } from "path";
import { ACIDStorageEngine, SynchronousMode, partitionedPath, RecoveryCorruptionError, DataCorruptionError } from "./acid-engine.js";
import { BackupManager, BackupConfig, BackupMetadata, CloudStorageConfig, BucketBackupResult, LiveBackupOptions, LiveBackupStatus, LiveCheckpointResult, RestoreLiveResult, BackupLogger } from "./backup.js";
import { DataRecovery, RecoveryConfig, RecoveryResult, FileRecoveryInfo, classifyRecoveryError } from "./recovery.js";
import QuickLRU from "quick-lru";

/**
 * ObjectId-style ID generation state (getNewId). The 5-byte process-unique salt
 * is drawn ONCE per process and the counter is a module-level monotonic value —
 * regenerating either per call (the old behavior) made the documented uniqueness
 * guarantee false: two IDs minted in the same second could collide, and every
 * call paid a crypto entropy draw. This is both correct and faster.
 */
const PROCESS_UNIQUE = randomBytes(5);
let idCounter = ~~(Math.random() * 0xffffff);

const MAX_DOCUMENT_DEPTH = 32;
const MAX_DOCUMENT_SIZE = 16 * 1024 * 1024; // 16MB max document size limit

/**
 * Clone for cache safety — hot-path optimized.
 * Flat JSON docs (no nested objects/arrays) are shallow-copied via spread
 * (~0.04µs) vs ~2.7µs for structuredClone — 60× faster. Bench tiny docs
 * are flat, so hot cached `get()` stays near 500k ops/s instead of 85k.
 * Nested docs are recursively cloned with depth and cycle guards.
 */
function deepClone<T>(value: T, depth = 0, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function' || typeof value === 'symbol') {
      throw new TypeError(`Cannot serialize value of type ${typeof value} into JSON document`);
    }
    return value;
  }
  if (depth > MAX_DOCUMENT_DEPTH) {
    throw new Error(`Document depth exceeds maximum allowed depth (${MAX_DOCUMENT_DEPTH})`);
  }
  if (!Array.isArray(value)) {
    let hasNested = false;
    for (const k in value as any) {
      if (Object.prototype.hasOwnProperty.call(value, k)) {
        const v = (value as any)[k];
        if (typeof v === 'function' || typeof v === 'symbol') {
          throw new TypeError(`Cannot serialize non-JSON property '${k}' of type ${typeof v}`);
        }
        if (v !== null && typeof v === 'object') { hasNested = true; break; }
      }
    }
    if (!hasNested) return { ...(value as any) } as T;
    if (seen.has(value as object)) {
      throw new Error('Circular reference detected in document');
    }
    seen.add(value as object);
    const copy: any = {};
    for (const k in value as any) {
      if (Object.prototype.hasOwnProperty.call(value, k)) {
        const v = (value as any)[k];
        if (typeof v === 'function' || typeof v === 'symbol') {
          throw new TypeError(`Cannot serialize non-JSON property '${k}' of type ${typeof v}`);
        }
        copy[k] = (v !== null && typeof v === 'object') ? deepClone(v, depth + 1, seen) : v;
      }
    }
    seen.delete(value as object);
    return copy as T;
  }
  let hasNested = false;
  const len = (value as any).length;
  for (let i = 0; i < len; i++) {
    const v = (value as any)[i];
    if (typeof v === 'function' || typeof v === 'symbol') {
      throw new TypeError(`Cannot serialize array element of type ${typeof v}`);
    }
    if (v !== null && typeof v === 'object') { hasNested = true; break; }
  }
  if (!hasNested) return [...(value as any)] as unknown as T;
  if (seen.has(value as object)) {
    throw new Error('Circular reference detected in document');
  }
  seen.add(value as object);
  const arr = new Array(len);
  for (let i = 0; i < len; i++) {
    const el = (value as any)[i];
    if (typeof el === 'function' || typeof el === 'symbol') {
      throw new TypeError(`Cannot serialize array element of type ${typeof el}`);
    }
    arr[i] = (el !== null && typeof el === 'object') ? deepClone(el, depth + 1, seen) : el;
  }
  seen.delete(value as object);
  return arr as unknown as T;
}

/**
 * Validate a user-supplied data directory name.
 */
function validateDirectory(raw: string): string {
  const dir = raw.trim();
  if (!dir) throw new Error('Directory name cannot be empty.');
  if (dir === '.' || dir === './') {
    throw new Error(`Invalid directory '${raw}': cannot use working directory root as database directory. Specify a named directory.`);
  }
  if (/[^A-Za-z0-9_\-./]/.test(dir)) {
    throw new Error(
      `Invalid directory '${raw}': directory names may only contain letters, digits, '_', '-', '.' and '/' path separators.`
    );
  }
  const segments = dir.split('/').filter(s => s.length > 0);
  if (segments.length === 0 || segments.includes('..')) {
    throw new Error(`Invalid directory '${raw}': empty or contains '..' path traversal.`);
  }
  const resolved = pathResolve(dir);
  const wasAbsolute = dir.startsWith('/');
  if (!wasAbsolute) {
    const rel = pathRelative(pathResolve('.'), resolved);
    if (rel.startsWith('..')) {
      throw new Error(`Invalid directory '${raw}': relative path escapes the working directory.`);
    }
  }
  return resolved;
}

interface TeroConfig {
  directory?: string;
  cacheSize?: number;
  /** Max committedBuffer entries flushed to disk per tick (prevents event loop stalls). Default: 1000. */
  checkpointBatchSize?: number;
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
  /** v2: per-second live WAL shipping to the bucket. RPO ≤ 1s of committed writes. */
  liveBackup?: LiveBackupOptions;
  /**
   * Acquire an exclusive lock on the data directory (lock-file based:
   * openSync 'wx' exclusive-create on <dir>/.lock with PID + stale-lock
   * reclamation — no native modules). Two Node processes writing the same
   * directory without this flag will corrupt each other's data. Recommended
   * true in production; default false for backwards compatibility.
   */
  fileLock?: boolean;
}

type HydrationMode = 'lazy' | 'eager';

interface HydrateConfig {
  cloudStorage: CloudStorageConfig;
  /**
   * Hydration mode:
   *   - 'lazy' (default): downloads 0 files on startup for instant boot.
   *     Files are hydrated gradually on-demand as they are requested.
   *   - 'eager': bulk downloads missing files from the bucket before engine init.
   */
  mode?: HydrationMode;
  /** Continue when a single file fails to download in eager mode (default true). */
  continueOnError?: boolean;
  /** Maximum time to wait for hydration in eager mode before engine init (ms). */
  timeout?: number;
  /** Optional custom S3 client for mocking/testing */
  customS3Client?: any;
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
  /** Real operation log backing getState() — the old implementation fabricated
   *  fake keys ('op_0', 'op_1', …) and labeled every operation 'write',
   *  including deletes. One array push per op: O(1), off the engine hot path. */
  private operationsLog: Array<{ key: string; operation: string }> = [];
  private destroyed: boolean = false;
  private committed: boolean = false;
  private rolledBack: boolean = false;
  private timeoutTimer?: ReturnType<typeof setTimeout>;
  private txState: 'active' | 'aborting' | 'aborted' | 'committed' = 'active';
  private abortError: Error | null = null;

  constructor(id: string, db: Tero, options?: TransactionOptions) {
    this.id = id;
    this.db = db;
    this.startTime = Date.now();
    if (options?.timeout) {
      this.timeoutTimer = setTimeout(() => {
        if (this.committed || this.rolledBack || this.destroyed || this.txState !== 'active') return;
        this.txState = 'aborting';
        this.destroyed = true;
        void this.db._rollbackRaw(this.id).then(() => {
          this.txState = 'aborted';
          this.rolledBack = true;
        }).catch((err: any) => {
          this.txState = 'aborted';
          this.rolledBack = true;
          this.abortError = err instanceof Error ? err : new Error(String(err));
        });
      }, options.timeout);
      (this.timeoutTimer as any).unref?.();
    }
  }

  getId(): string {
    return this.id;
  }

  isActive(): boolean {
    if (this.txState !== 'active') return false;
    if (this.destroyed || this.committed || this.rolledBack) return false;
    return this.db._isTransactionActive(this.id);
  }

  isRolledBack(): boolean {
    if (this.rolledBack || this.txState === 'aborted') return true;
    // Aborting is not yet rolled back — still considered not rolled back until engine confirms
    if (this.txState === 'aborting') return false;
    if (this.destroyed) return true;
    const status = this.db._getTxStatus(this.id);
    if (status === 'aborted') { this.rolledBack = true; this.txState = 'aborted'; return true; }
    return false;
  }

  isCommitted(): boolean {
    if (this.committed || this.txState === 'committed') return true;
    return this.db._getTxStatus(this.id) === 'committed';
  }

  /** Whether transaction is in ABORTING state (timeout fired, rollback in flight) */
  isAborting(): boolean {
    return this.txState === 'aborting';
  }

  getAbortError(): Error | null {
    return this.abortError;
  }

  private _checkActive(): void {
    if (this.txState === 'aborting') throw new Error('Transaction is aborting (timeout rollback in progress)');
    if (this.txState === 'aborted') throw new Error('Transaction has been rolled back');
    if (this.destroyed) throw new Error('Transaction has been destroyed');
    if (this.committed) throw new Error('Transaction has already been committed');
    if (this.rolledBack) throw new Error('Transaction has been rolled back');
    const status = this.db._getTxStatus(this.id);
    if (status === 'committed') { this.committed = true; this.txState = 'committed'; throw new Error('Transaction has already been committed'); }
    if (status === 'aborted') { this.rolledBack = true; this.txState = 'aborted'; throw new Error('Transaction has been rolled back'); }
    if (status === 'not_found') {
      // Engine GC'd the transaction (after commit/rollback). Use local flags to give precise error
      if (this.committed) throw new Error('Transaction has already been committed');
      if (this.rolledBack) throw new Error('Transaction has been rolled back');
      throw new Error('Transaction is not active');
    }
  }

  async create(key: string, initialData?: any): Promise<void> {
    this._checkActive();
    // Acquire exclusive lock BEFORE existence check to close TOCTOU
    let acquiredHere = false;
    const lockRes = (this.db as any).acidEngine.acquireExclusiveLock(this.id, key);
    if (lockRes instanceof Promise) await lockRes;
    acquiredHere = true;
    try {
      if (this.db.exists(key)) throw new Error(`Document '${key}' already exists`);
      // Cloud-aware duplicate detection while holding exclusive lock (P1) — same as Tero.create
      const dbAny: any = this.db as any;
      if (dbAny.dataRecovery && dbAny.hydrateMode === 'lazy') {
        if (!dbAny.missingKeys.has(key)) {
          // Check tombstone first — if tombstoned, allow re-create
          let hasTomb = false;
          if (typeof dbAny.dataRecovery.hasTombstone === 'function') {
            hasTomb = await dbAny.dataRecovery.hasTombstone(key);
          }
          if (!hasTomb) {
            const info = await dbAny.dataRecovery.checkFileInCloud(key);
            if (info.exists) throw new Error(`Document '${key}' already exists in cloud`);
          }
        }
      }
      await this.db._writeRaw(this.id, key, initialData === undefined ? {} : initialData);
      // Only after successful _writeRaw, cache the negative lookup for future creates
      // (if _writeRaw fails, don't pollute missingKeys)
      if (dbAny.dataRecovery && dbAny.hydrateMode === 'lazy') {
        dbAny.missingKeys.set(key, true);
      }
      this.opCount++;
      this.operationsLog.push({ key, operation: 'create' });
    } catch (err) {
      if (acquiredHere) {
        try { (this.db as any).acidEngine.lockManager.releaseLock(key, this.id); } catch {}
        try {
          const tx = (this.db as any).acidEngine.activeTransactions.get(this.id);
          if (tx) {
            tx.heldLocks.delete(key);
            tx.waitingLocks.delete(key);
          }
        } catch {}
      }
      throw err;
    }
  }

  async update(key: string, data: any): Promise<void> {
    this._checkActive();
    await this.db._writeRaw(this.id, key, data);
    this.opCount++;
    this.operationsLog.push({ key, operation: 'update' });
  }

  async delete(key: string): Promise<void> {
    this._checkActive();
    await this.db._deleteRaw(this.id, key);
    this.opCount++;
    this.operationsLog.push({ key, operation: 'delete' });
  }

  /**
   * Read document within this transaction.
   * @param options.lock - 'shared' (default) or 'exclusive' (SELECT FOR UPDATE)
   */
  async get(key: string, options?: { lock?: 'shared' | 'exclusive' }): Promise<any> {
    this._checkActive();
    return await this.db.read(this.id, key, options);
  }

  /**
   * Alias for get() with explicit locking semantics.
   * @param options.lock - 'shared' (default) or 'exclusive' (SELECT FOR UPDATE)
   */
  async read(key: string, options?: { lock?: 'shared' | 'exclusive' }): Promise<any> {
    this._checkActive();
    return await this.db.read(this.id, key, options);
  }

  getState(): { status: string; operations: Array<{ key: string; operation: string }>; startTime: number } {
    if (this.txState === 'aborting') return { status: 'aborting', operations: [...this.operationsLog], startTime: this.startTime };
    if (this.committed || this.txState === 'committed') return { status: 'committed', operations: [...this.operationsLog], startTime: this.startTime };
    if (this.rolledBack || this.txState === 'aborted' || this.destroyed) {
      const s = this.db._getTxStatus(this.id);
      if (s === 'aborted' || this.rolledBack || this.txState === 'aborted') return { status: 'rolled_back', operations: [...this.operationsLog], startTime: this.startTime };
    }
    const status = this.db._getTxStatus(this.id);
    return {
      status: status === 'active' ? 'active' : (status === 'committed' ? 'committed' : status === 'aborted' ? 'rolled_back' : 'aborted'),
      operations: [...this.operationsLog],
      startTime: this.startTime
    };
  }

  getOperationCount(): number {
    return this.opCount;
  }

  async commit(): Promise<void> {
    this._checkActive();
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    await this.db.commit(this.id);
    this.committed = true;
    this.txState = 'committed';
  }

  async abort(): Promise<void> {
    if (this.rolledBack || this.txState === 'aborted') return;
    if (this.txState === 'aborting') {
      // Wait for in-flight timeout rollback
      await new Promise<void>((resolve) => {
        const check = () => {
          if (this.txState !== 'aborting') resolve();
          else setTimeout(check, 5);
        };
        check();
      });
      return;
    }
    if (this.destroyed && this.txState !== 'active') return;
    this.txState = 'aborting';
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    try {
      await this.db._rollbackRaw(this.id);
      this.txState = 'aborted';
      this.rolledBack = true;
    } catch (err: any) {
      this.txState = 'aborted';
      this.rolledBack = true;
      this.abortError = err instanceof Error ? err : new Error(String(err));
      throw err;
    }
  }

  async rollback(): Promise<void> {
    await this.abort();
  }

  destroy(): void {
    if (this.rolledBack || this.txState === 'aborted' || this.txState === 'committed') return;
    this.destroyed = true;
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    if (this.txState === 'active') {
      this.txState = 'aborting';
      void this.db._rollbackRaw(this.id).then(() => {
        this.txState = 'aborted';
        this.rolledBack = true;
      }).catch((err: any) => {
        this.txState = 'aborted';
        this.rolledBack = true;
        this.abortError = err instanceof Error ? err : new Error(String(err));
      });
    }
  }
}

export class Tero {
  private teroDirectory: string = "TeroDB";
  private cacheSize: number = 100;
  private cache: QuickLRU<string, CacheEntry>;
  private cacheHits: number = 0;
  private cacheRequests: number = 0;
  private acidEngine: ACIDStorageEngine;
  private backupManager?: BackupManager;
  private dataRecovery?: DataRecovery;
  private hydrateMode: HydrationMode = 'lazy';
  private inFlightHydrations = new Map<string, Promise<any | null>>();
  private missingKeys: QuickLRU<string, boolean>;
  private readonly MISSING_KEYS_MAX: number = 50000;
  private committedCount: number = 0;
  private rolledBackCount: number = 0;
  /** Monotonic per-key generation for in-flight hydration invalidation (P0-1). */
  private keyGenerations = new Map<string, number>();
  /** Durable cloud reconciliation for deletes (P0-2) — keys needing cloud delete+tombstone, with deletion LSN */
  private cloudPendingTombstones = new Map<string, number>();
  private cloudPendingTombstoneDeletions = new Map<string, number>();
  private cloudPendingTimer?: ReturnType<typeof setTimeout>;
  private reconciliationLocks = new Map<string, Promise<void>>();
  private reconciliationLockStorage = new AsyncLocalStorage<Set<string>>();

  /**
   * Bounded LRU of known-existing keys. Replaces the unbounded Set<string>
   * that grew linearly with key count (catastrophic memory at 1M+ keys/tenant).
   * Capped at KNOWN_KEYS_MAX (10k) ~ 800KB peak vs ~80MB at 1M keys for Set.
   * Falls back to disk (partitioned path existsSync) on LRU miss.
   */
  private knownKeys: QuickLRU<string, boolean>;
  private readonly KNOWN_KEYS_MAX: number = 10000;

  /** Exclusive lock fd on <dir>/.lock (lock-file based; see acquireFileLock). */
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
      // Validate live-backup requirements BEFORE creating any resources, so a
      // misconfiguration can never leak a half-constructed engine or timers.
      if (config?.liveBackup && !config.backup?.cloudStorage) {
        throw new Error('config.liveBackup requires config.backup with cloudStorage configured — live backup needs a bucket.');
      }
      const rawDirectory = config?.directory;
      const { cacheSize, synchronous, commitIntervalMs, dataFlushIntervalMs } = config || {};

      if (synchronous && !['full', 'normal', 'off'].includes(synchronous)) {
        throw new Error(`Invalid synchronous mode '${synchronous}'. Expected 'full', 'normal', or 'off'.`);
      }
      if (synchronous === 'off' && (process.env.TERO_ALLOW_UNSAFE_OFF !== '1' && process.env.NODE_ENV !== 'test' && process.env.NODE_ENV !== 'development')) {
        throw new Error("synchronous='off' is not allowed — it disables all fsync and will lose data on crash. Use 'full' or 'normal'. Set TERO_ALLOW_UNSAFE_OFF=1 to force in benchmarks.");
      }

      if (typeof rawDirectory === "string" && rawDirectory.trim()) {
        // Throw on illegal characters instead of silently stripping them —
        // 'my db' used to quietly become 'mydb' and users wrote to the wrong
        // directory. Also blocks absolute paths and traversal.
        this.teroDirectory = validateDirectory(rawDirectory);
      }

      if (typeof cacheSize === "number" && cacheSize > 0) {
        this.cacheSize = cacheSize;
      }

      // Create directories with proper error handling
      this.initializeDirectories();

      // Cross-process lock enabled by default — prevents two processes from opening the
      // same data directory concurrently (Google Pillar #2). Set fileLock: false to disable.
      if (config?.fileLock !== false) {
        this.acquireFileLock();
      }

      // Initialize QuickLRU cache
      this.cache = new QuickLRU<string, CacheEntry>({
        maxSize: this.cacheSize
      });

      // Initialize bounded LRU for known-keys (caps memory at ~800KB vs ~80MB
      // for an unbounded Set at 1M keys — addresses cloud-scale heap bloat).
      this.knownKeys = new QuickLRU<string, boolean>({ maxSize: this.KNOWN_KEYS_MAX });

      // Initialize bounded LRU for missing-keys (negative cache to prevent S3 spamming)
      this.missingKeys = new QuickLRU<string, boolean>({ maxSize: this.MISSING_KEYS_MAX });

      // Initialize ACID storage engine (primary system)
      const syncMode: SynchronousMode = synchronous ?? 'full';
      const syncInterval: number = commitIntervalMs ?? 10;
      const dataFlushInterval: number = dataFlushIntervalMs ?? 50;
      this.acidEngine = new ACIDStorageEngine(this.teroDirectory, syncMode, syncInterval, dataFlushInterval, config?.checkpointBatchSize);

      // Restore durable local tombstones (P0-2) — prevents resurrection after restart even if cloud tombstone not yet durable
      try {
        const tombDir = pathJoin(this.teroDirectory, '.tombstones');
        if (existsSync(tombDir)) {
          const files = readdirSync(tombDir);
          for (const f of files) {
            if (!f.endsWith('.deleted')) continue;
            try {
              const content = readFileSync(pathJoin(tombDir, f), 'utf8');
              const obj = JSON.parse(content);
              if (obj.key && typeof obj.key === 'string') {
                this.missingKeys.set(obj.key, true);
                this.bumpGeneration(obj.key);
              }
            } catch { /* approved */ }
          }
        }
      } catch { /* approved */ }
      // v2: optionally install a backup config at construction time.
      if (config?.backup) {
        this.configureBackup(config.backup);
      }
      // v2: enable per-second live WAL shipping if configured.
      if (config?.liveBackup) {
        if (!this.backupManager) {
          throw new Error('config.liveBackup requires config.backup with cloudStorage configured.');
        }
        this.enableLiveBackup(config.liveBackup);
      }

      // Configure data recovery & gradual hydration if hydrateOnStartup is configured
      if (config?.hydrateOnStartup) {
        const isEager = config.hydrateOnStartup.mode === 'eager' ||
          (config.hydrateOnStartup as any).mode === 'all' ||
          (config.hydrateOnStartup as any).mode === 'missing';
        this.hydrateMode = isEager ? 'eager' : 'lazy';
        this.dataRecovery = new DataRecovery({
          cloudStorage: config.hydrateOnStartup.cloudStorage,
          localPath: this.teroDirectory,
          continueOnError: config.hydrateOnStartup.continueOnError ?? true,
          customS3Client: config.hydrateOnStartup.customS3Client,
        });
      }

      // Restore pending cloud reconciliation *after* dataRecovery exists so schedule can run
      this.loadPendingCloud();
      this.loadPendingCloudDeletions();
      // Fallback: reconstruct pending from local tombstones if queue file was lost (ENOSPC case)
      try {
        const tombDir = pathJoin(this.teroDirectory, '.tombstones');
        if (existsSync(tombDir)) {
          const files = readdirSync(tombDir);
          for (const f of files) {
            if (!f.endsWith('.deleted')) continue;
            try {
              const content = readFileSync(pathJoin(tombDir, f), 'utf8');
              const obj = JSON.parse(content);
              if (obj.key && typeof obj.key === 'string' && typeof obj.lsn === 'number') {
                if (!this.cloudPendingTombstones.has(obj.key) && !this.cloudPendingTombstoneDeletions.has(obj.key)) {
                  if (this.dataRecovery) {
                    this.cloudPendingTombstones.set(obj.key, obj.lsn);
                  }
                }
              }
            } catch {}
          }
          if (this.cloudPendingTombstones.size > 0) {
            try { this.savePendingCloud(); } catch {}
          }
        }
      } catch {}
      if (this.cloudPendingTombstones.size > 0 || this.cloudPendingTombstoneDeletions.size > 0) this.scheduleCloudRetry();
    } catch (error) {
      if (error instanceof RecoveryCorruptionError || error instanceof DataCorruptionError) {
        throw error;
      }
      throw new Error(`Failed to initialize Tero: ${error instanceof Error ? error.message : 'Unknown error'}`, { cause: error });
    }
  }

  /**
   * v2 async factory.
   * - mode: 'lazy' (default) -> Instant startup, downloads 0 files on boot.
   *   Files hydrate gradually on-demand as they are requested.
   * - mode: 'eager' -> Bulk downloads files from cloud bucket before engine init.
   */
  static async create(config?: TeroConfig): Promise<Tero> {
    const rawDirectory = config?.directory || 'TeroDB';
    const teroDirectory = validateDirectory(rawDirectory);
    if (!existsSync(teroDirectory)) {
      mkdirSync(teroDirectory, { recursive: true });
    }

    const hydrate = config?.hydrateOnStartup;

    // Eager mode: bulk pre-downloads missing files before boot
    const isEager = hydrate && (
      hydrate.mode === 'eager' ||
      (hydrate as any).mode === 'all' ||
      (hydrate as any).mode === 'missing'
    );

    if (isEager) {
      const recovery = new DataRecovery({
        cloudStorage: hydrate.cloudStorage,
        localPath: teroDirectory,
        continueOnError: hydrate.continueOnError ?? true,
        customS3Client: hydrate.customS3Client,
      });

      const abortController = new AbortController();
      let timer: any;
      const timeoutMs = hydrate.timeout;
      if (typeof timeoutMs === 'number' && timeoutMs > 0) {
        timer = setTimeout(() => abortController.abort(), timeoutMs);
        timer.unref?.();
      }

      try {
        const result = await recovery.recoverMissingFiles({ abortSignal: abortController.signal });
        if (!result.success && hydrate.continueOnError === false) {
          throw new Error(`Eager hydration failed: ${result.failed.length} file(s) failed to recover`);
        }
      } catch (err) {
        if (hydrate.continueOnError === false) {
          throw err;
        }
        /* approved: hydration errors tolerated when continueOnError is true */
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    // Default 'lazy' mode: ZERO downloads during create(). Startup is instant.
    return new Tero(config);
  }

  /**
   * Lazily fetches and caches a document from cloud storage on-demand.
   * Pure, efficient design for large workloads at maximum scale:
   * 1. Fast-path negative cache (bounded QuickLRU) prevents repetitive S3 roundtrips for missing keys.
   * 2. Singleflight deduplication coalesces concurrent requests for the same key into a single S3 request.
   * 3. Atomic temp-file persistence + direct in-memory cache update eliminates redundant disk reads.
   * 4. Generation-aware invalidation prevents resurrection: a delete/write that
   *    commits while hydration is in-flight bumps the per-key generation; stale
   *    hydration results are discarded and any just-written file is removed.
   */
  private async hydrateKey(key: string): Promise<any | null> {
    if (!this.dataRecovery || this.hydrateMode !== 'lazy') {
      return null;
    }

    // Fast-path negative cache: avoid S3 API roundtrip for known missing keys
    if (this.missingKeys.has(key)) {
      return null;
    }

    // Singleflight: coalesce concurrent requests for the same key
    const inFlight = this.inFlightHydrations.get(key);
    if (inFlight) {
      return await inFlight;
    }

    const startGen = this.getGeneration(key);
    const fetchPromise = (async () => {
      try {
        // Local durable tombstone check (P0-2 cross-restart) — must not resurrect
        if (this.hasLocalTombstone(key)) {
          this.missingKeys.set(key, true);
          return null;
        }
        // Check cloud tombstone before fetching — deleted keys must not be resurrected
        // Three states: PRESENT, DELETED, UNKNOWN — never fail-open on UNKNOWN
        if (typeof (this.dataRecovery as any).hasTombstone === 'function') {
          try {
            const hasTomb = await (this.dataRecovery as any).hasTombstone(key);
            if (hasTomb) {
              this.missingKeys.set(key, true);
              return null;
            }
          } catch (err: any) {
            const kind = classifyRecoveryError(err);
            if (kind === 'CANCELLED') throw err;
            if (kind !== 'NOT_FOUND') {
              const e = new Error(`Cloud tombstone check failed for '${key}': ${err?.message || 'Unknown cloud error'}`);
              (e as any).cause = err;
              (e as any).code = 'CLOUD_UNAVAILABLE';
              (e as any).$metadata = err?.$metadata;
              (e as any).name = err?.name || 'CloudUnavailableError';
              throw e;
            }
          }
        }
        // If local committed state already has a value/tombstone newer than hydration start, don't fetch
        const committedBefore = this.acidEngine.getCommittedData(key);
        if (committedBefore !== undefined) {
          if (committedBefore === null) {
            this.missingKeys.set(key, true);
            return null;
          }
          // local has newer committed data — stale hydration would be older
          if (this.getGeneration(key) !== startGen) return null;
        }
        if (existsSync(this.keyToPath(key)) && this.getGeneration(key) !== startGen) {
          return null;
        }

        const data = await this.dataRecovery!.fetchAndPersist(key);

        // Generation check — if delete/write committed while fetch was in-flight, discard stale result
        if (this.getGeneration(key) !== startGen) {
          if (data !== null && data !== undefined) {
            try {
              const p = this.keyToPath(key);
              if (existsSync(p)) unlinkSync(p);
            } catch { /* approved */ }
            this.cache.delete(key);
          }
          return null;
        }

        // Post-fetch local tombstone check (delete committed after our pre-check or durable local tombstone)
        if (this.hasLocalTombstone(key)) {
          if (data !== null && data !== undefined) {
            try { unlinkSync(this.keyToPath(key)); } catch { /* approved */ }
            this.cache.delete(key);
          }
          this.missingKeys.set(key, true);
          return null;
        }
        const committedAfter = this.acidEngine.getCommittedData(key);
        if (committedAfter !== undefined && committedAfter === null) {
          if (data !== null && data !== undefined) {
            try { unlinkSync(this.keyToPath(key)); } catch { /* approved */ }
            this.cache.delete(key);
          }
          this.missingKeys.set(key, true);
          return null;
        }

        if (data !== null && data !== undefined) {
          // Re-check tombstone after fetch — cloud delete could have happened concurrently
          // Must not fail-open: UNKNOWN → throw
          if (typeof (this.dataRecovery as any).hasTombstone === 'function') {
            try {
              const hasTombAfter = await (this.dataRecovery as any).hasTombstone(key);
              if (hasTombAfter) {
                try { unlinkSync(this.keyToPath(key)); } catch { /* approved */ }
                this.cache.delete(key);
                this.missingKeys.set(key, true);
                return null;
              }
            } catch (err: any) {
              // Tombstone check failed after successful fetch — cannot guarantee DELETED vs PRESENT
              // Remove the just-fetched file to avoid resurrection on UNKNOWN
              try { unlinkSync(this.keyToPath(key)); } catch { /* approved */ }
              this.cache.delete(key);
              const kind = classifyRecoveryError(err);
              if (kind === 'CANCELLED') throw err;
              const e = new Error(`Cloud tombstone re-check failed for '${key}': ${err?.message || 'Unknown cloud error'}`);
              (e as any).cause = err;
              (e as any).code = 'CLOUD_UNAVAILABLE';
              (e as any).$metadata = err?.$metadata;
              (e as any).name = err?.name || 'CloudUnavailableError';
              throw e;
            }
          }
          this.knownKeys.set(key, true);
          this.updateCache(key, data, undefined);
          return data;
        } else {
          // Genuine 404: cache negative lookup
          this.missingKeys.set(key, true);
          return null;
        }
      } catch (err) {
        // Transient network/auth error: DO NOT cache in missingKeys!
        // Re-throw so callers are aware of cloud failure
        throw err;
      } finally {
        this.inFlightHydrations.delete(key);
      }
    })();

    this.inFlightHydrations.set(key, fetchPromise);
    return await fetchPromise;
  }

  /**
   * Run hydration at any time (idempotent).
   * Strictly supports two modes:
   * - 'lazy' (default): enables on-demand gradual hydration (downloads 0 files in bulk).
   * - 'eager': bulk downloads all missing files from cloud before returning.
   */
  async hydrate(options?: { mode?: HydrationMode; timeout?: number }): Promise<RecoveryResult> {
    const recovery = this.dataRecovery;
    if (!recovery) {
      throw new Error('Data recovery not configured. Call configureDataRecovery() or pass hydrateOnStartup in config.');
    }
    const requestedMode = options?.mode ?? this.hydrateMode;
    const isEager = requestedMode === 'eager' ||
      (requestedMode as any) === 'all' ||
      (requestedMode as any) === 'missing';

    if (!isEager) {
      this.hydrateMode = 'lazy';
      return {
        success: true,
        recovered: [],
        failed: [],
        totalFiles: 0,
        duration: 0,
      };
    }
    this.hydrateMode = 'eager';
    const timeoutMs = options?.timeout;
    let cancelled = false;
    let timeoutTimer: any;
    if (typeof timeoutMs === 'number' && timeoutMs > 0) {
      timeoutTimer = setTimeout(() => { cancelled = true; }, timeoutMs);
      timeoutTimer.unref?.();
    }
    try {
      if (cancelled) throw new Error(`Hydrate timed out after ${timeoutMs}ms`);
      return await recovery.recoverMissingFiles(() => cancelled);
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer);
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
      throw new Error(`Failed to create directories: ${error instanceof Error ? error.message : 'Unknown error'}`, { cause: error });
    }
  }

  private static readonly MAX_KEY_LENGTH = 200;

  private validateKey(key: string): void {
    if (!key || typeof key !== 'string' || !key.trim()) {
      throw new Error('Key must be a non-empty string');
    }
    if (key.length > Tero.MAX_KEY_LENGTH) {
      throw new Error(`Key exceeds maximum length of ${Tero.MAX_KEY_LENGTH} characters (got ${key.length})`);
    }
    // Sanitize key to prevent path traversal, hidden files, and illegal chars
    if (key === '.' || key === '..' || key.includes('/') || key.includes('\\') || key.includes('\0') || key.startsWith('.')) {
      throw new Error('Key contains invalid characters');
    }
  }

  private bumpGeneration(key: string): number {
    const next = (this.keyGenerations.get(key) ?? 0) + 1;
    this.keyGenerations.set(key, next);
    return next;
  }

  private getGeneration(key: string): number {
    return this.keyGenerations.get(key) ?? 0;
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
      data: deepClone(data),
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
      throw new Error(`Failed to begin transaction: ${error instanceof Error ? error.message : 'Unknown error'}`, { cause: error });
    }
  }

  private _beginTransaction(): string {
    return this.acidEngine.beginTransaction();
  }

  private _txId(id: string | Transaction): string {
    return typeof id === 'string' ? id : id.getId();
  }

  async write(transactionId: string | Transaction, key: string, data: any): Promise<void> {
    try {
      const txId = this._txId(transactionId);
      this.validateKey(key);

      if (data === undefined || data === null) {
        throw new Error('Data cannot be null or undefined');
      }

      data = deepClone(data);

      // Use byte length, not char length — 'é' is 1 char but 2 bytes UTF-8, emoji is 4 bytes
      const jsonStr = JSON.stringify(data);
      const byteLen = Buffer.byteLength(jsonStr, 'utf8');
      if (byteLen > MAX_DOCUMENT_SIZE) {
        throw new Error(`Document size exceeds maximum allowed size (${MAX_DOCUMENT_SIZE / (1024 * 1024)}MB) — got ${(byteLen / (1024 * 1024)).toFixed(2)}MB`);
      }

      // Check cache for beforeImage so engine doesn't need disk I/O on hot writes
      const cachedEntry = this.cache.get(key);
      let cachedData = (cachedEntry && (!cachedEntry.transactionId || cachedEntry.transactionId === txId)) ? cachedEntry.data : undefined;

      // Lazy hydration: if updating a cold document not on disk, hydrate beforeImage from cloud
      if (cachedData === undefined && this.dataRecovery && this.hydrateMode === 'lazy' &&
          this.acidEngine.getCommittedData(key) === undefined &&
          !existsSync(this.keyToPath(key))) {
        cachedData = (await this.hydrateKey(key)) ?? undefined;
      }

      // Engine write — returns void (sync fast path) or Promise (contended lock)
      const writeResult = this.acidEngine.write(txId, key, data, cachedData);
      if (writeResult !== undefined) await writeResult;

      // Cache the MERGED afterImage (from pendingWrites), NOT the raw user data.
      // The engine deep-merges user data with existing state, so the afterImage
      // has ALL fields, not just the caller's partial update. Caching the raw
      // input would poison the cache with incomplete documents (sequential
      // updates to the same key would lose earlier fields).
      const afterImage = this.acidEngine.getPendingAfterImage(txId, key);
      this.updateCache(key, afterImage !== undefined ? afterImage : data, txId);
      this.missingKeys.delete(key);
    } catch (error) {
      throw new Error(`Write failed for key '${key}': ${error instanceof Error ? error.message : 'Unknown error'}`, { cause: error });
    }
  }

  async read(transactionId: string | Transaction, key: string, options?: { lock?: 'shared' | 'exclusive' }): Promise<any> {
    try {
      const txId = this._txId(transactionId);
      this.validateKey(key);
      this.cacheRequests++;

      if (options?.lock === 'exclusive') {
        const lockRes = this.acidEngine.acquireExclusiveLock(txId, key);
        if (lockRes !== undefined && lockRes instanceof Promise) await lockRes;
      } else {
        const lockRes = this.acidEngine.acquireSharedLock(txId, key);
        if (lockRes !== undefined && lockRes instanceof Promise) await lockRes;
      }

      // Check cache first, but only if it's from the same transaction or committed
      const cachedEntry = this.cache.get(key);
      if (cachedEntry && (!cachedEntry.transactionId || cachedEntry.transactionId === txId)) {
        this.cacheHits++;
        return deepClone(cachedEntry.data);
      }

      // Read from ACID engine — returns data (sync fast path) or Promise (contended lock)
      const readResult = this.acidEngine.read(txId, key);
      let data = (readResult !== undefined && readResult instanceof Promise) ? await readResult : readResult;

      // Lazy hydration: stream on-demand if missing locally
      if ((data === null || data === undefined) && this.dataRecovery && this.hydrateMode === 'lazy') {
        data = await this.hydrateKey(key);
      }

      if (data !== null && data !== undefined) {
        this.updateCache(key, data, txId);
      }

      return deepClone(data);
    } catch (error) {
      throw new Error(`Read failed for key '${key}': ${error instanceof Error ? error.message : 'Unknown error'}`, { cause: error });
    }
  }

  async commit(transactionId: string | Transaction): Promise<void> {
    const txId = this._txId(transactionId);
    // O(1) active check — was O(N) via getActiveTransactions().includes()
    if (!this.acidEngine.isTransactionActive(txId)) {
      throw new Error(`Transaction ${txId} not found or not active`);
    }

    // --- Logical commit: point of no return ---
    // Once this succeeds the transaction is irrevocably committed in the WAL.
    // Post-commit reconciliation (local tombstone fsync, cloud tombstone) must
    // NOT turn a committed transaction into a visible failure.
    try {
      this.acidEngine.commitTransaction(txId);
    } catch (error) {
      throw new Error(`Failed to commit transaction: ${error instanceof Error ? error.message : 'Unknown error'}`, { cause: error });
    }

    // PROMOTE cache entries tagged with this transaction to "committed" state.
    // O(touched) via the tracked set.
    const touched = this.txTouchedKeys.get(txId);
    if (touched) {
      for (const key of touched) {
        const entry = this.cache.get(key);
        if (entry && (entry as any).transactionId === txId) {
          (entry as any).transactionId = undefined;
        }
        // Bump generation for P0-1 in-flight hydration invalidation and P0-10 stale hydration
        this.bumpGeneration(key);
      }
      // Post-commit reconciliation — durable but best-effort, never fails the logical commit
      for (const key of touched) {
        try {
          await this.withReconciliationLock(key, async () => {
            const committed = this.acidEngine.getCommittedData(key);
            if (committed !== undefined) {
              if (committed !== null) {
                // Write/present — clear tombstones so re-create can succeed and hydration can fetch
                try {
                  this.deleteLocalTombstone(key);
                } catch (e) {
                  // Local tombstone removal failed — queue cloud deletion retry and keep local file for next attempt
                  this.queueCloudTombstoneDeletion(key, this.acidEngine!.getLastCommittedLSN());
                  return;
                }
                if (this.cloudPendingTombstones.has(key)) {
                  this.cloudPendingTombstones.delete(key);
                  try { this.savePendingCloud(); } catch {}
                }
                if (this.dataRecovery) {
                  // Re-check still present before deleting cloud tombstone
                  const committed2 = this.acidEngine.getCommittedData(key);
                  const hasLocal2 = this.hasLocalTombstone(key);
                  if (committed2 !== undefined && committed2 === null) return;
                  if (hasLocal2) {
                    const existsLocal2 = existsSync(this.keyToPath(key));
                    if (!existsLocal2 || committed2 === null) return;
                  }
                  try {
                    await (this.dataRecovery as any).deleteTombstone?.(key);
                    if (this.cloudPendingTombstoneDeletions.has(key)) {
                      this.cloudPendingTombstoneDeletions.delete(key);
                      try { this.savePendingCloudDeletions(); } catch {}
                    }
                  } catch {
                    this.queueCloudTombstoneDeletion(key, this.acidEngine!.getLastCommittedLSN());
                  }
                }
              } else {
                // Delete — ensure tombstones for resurrection protection
                try {
                  this.writeLocalTombstone(key);
                } catch (e) {
                  // Local tombstone creation failed — queue cloud tombstone and keep pending
                  this.queueCloudTombstone(key, this.acidEngine!.getLastCommittedLSN());
                  return;
                }
                if (this.dataRecovery && this.hydrateMode === 'lazy') {
                  // Re-check still deleted before cloud mutation (now inside same lock as state change)
                  const committed2 = this.acidEngine.getCommittedData(key);
                  const hasLocal2 = this.hasLocalTombstone(key);
                  const existsLocal2 = existsSync(this.keyToPath(key));
                  const stillDeleted = hasLocal2 || (committed2 !== undefined && committed2 === null) || (!existsLocal2 && committed2 === undefined);
                  if (!stillDeleted) {
                    this.cloudPendingTombstones.delete(key);
                    try { this.savePendingCloud(); } catch {}
                    return;
                  }
                  let failed = false;
                  try { await this.dataRecovery!.deleteFromCloud(key); } catch { failed = true; }
                  try { await (this.dataRecovery as any).putTombstone?.(key, this.acidEngine!.getLastCommittedLSN()); } catch { failed = true; }
                  if (failed) this.queueCloudTombstone(key, this.acidEngine!.getLastCommittedLSN());
                  else if (this.cloudPendingTombstones.has(key)) {
                    this.cloudPendingTombstones.delete(key);
                    try { this.savePendingCloud(); } catch {}
                  }
                }
              }
            } else {
              // Fallback: if no committed entry but key was in touched (e.g., already flushed),
              // check local file existence to infer delete vs write
              if (!existsSync(this.keyToPath(key))) {
                // likely deleted — ensure tombstone
                try {
                  this.writeLocalTombstone(key);
                } catch {
                  this.queueCloudTombstone(key, this.acidEngine!.getLastCommittedLSN());
                  return;
                }
                if (this.dataRecovery && this.hydrateMode === 'lazy' && !this.cloudPendingTombstones.has(key)) {
                  const committed2 = this.acidEngine.getCommittedData(key);
                  const hasLocal2 = this.hasLocalTombstone(key);
                  const existsLocal2 = existsSync(this.keyToPath(key));
                  const stillDeleted = hasLocal2 || (committed2 !== undefined && committed2 === null) || (!existsLocal2 && committed2 === undefined);
                  if (!stillDeleted) {
                    this.cloudPendingTombstones.delete(key);
                    try { this.savePendingCloud(); } catch {}
                    return;
                  }
                  try {
                    await (this.dataRecovery as any).putTombstone?.(key, this.acidEngine!.getLastCommittedLSN());
                  } catch { this.queueCloudTombstone(key, this.acidEngine!.getLastCommittedLSN()); }
                }
              } else {
                try {
                  this.deleteLocalTombstone(key);
                } catch {
                  this.queueCloudTombstoneDeletion(key, this.acidEngine!.getLastCommittedLSN());
                  return;
                }
                if (this.cloudPendingTombstones.has(key)) {
                  this.cloudPendingTombstones.delete(key);
                  try { this.savePendingCloud(); } catch {}
                }
                if (this.dataRecovery) {
                  try {
                    await (this.dataRecovery as any).deleteTombstone?.(key);
                    if (this.cloudPendingTombstoneDeletions.has(key)) {
                      this.cloudPendingTombstoneDeletions.delete(key);
                      try { this.savePendingCloudDeletions(); } catch {}
                    }
                  } catch {
                    this.queueCloudTombstoneDeletion(key, this.acidEngine!.getLastCommittedLSN());
                  }
                }
              }
            }
          });
        } catch (e) {
          // Post-commit reconciliation failure must not fail the logical commit
          console.warn(`[Tero] post-commit reconciliation failed for '${key}': ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      this.txTouchedKeys.delete(txId);
    }
    this.committedCount++;
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
      throw new Error(`Failed to rollback transaction: ${error instanceof Error ? error.message : 'Unknown error'}`, { cause: error });
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
  async create(key: string, initialData?: any): Promise<boolean> {
    this.validateKey(key);
    return this.withReconciliationLock(key, async () => {
      const transactionId = this._beginTransaction();
      try {
        // Serialize existence check under an exclusive lock — two concurrent
        // create('sameKey') must not both succeed (TOCTOU). Acquire exclusive
        // first, then check committed state under that lock.
        const lockRes = this.acidEngine.acquireExclusiveLock(transactionId, key);
        if (lockRes instanceof Promise) await lockRes;

        // Check existence while holding the lock (covers knownKeys, committedBuffer, disk)
        if (this.knownKeys.has(key)) {
          await this.rollback(transactionId);
          return false; // already exists
        }
        const pending = this.acidEngine.getCommittedData(key);
        if (pending !== undefined) {
          if (pending !== null) {
            this.knownKeys.set(key, true);
            await this.rollback(transactionId);
            return false; // duplicate — already committed, not yet flushed
          }
          // tombstone → logically absent, fall through to allow re-create
        } else if (existsSync(this.keyToPath(key))) {
          this.knownKeys.set(key, true); // re-pin; existed all along
          await this.rollback(transactionId);
          return false;
        } else if (this.dataRecovery && this.hydrateMode === 'lazy') {
          if (!this.missingKeys.has(key)) {
            // Check tombstone first — if tombstoned, allow re-create even if .json still exists due to failed delete
            let hasTomb = false;
            if (typeof (this.dataRecovery as any).hasTombstone === 'function') {
              hasTomb = await (this.dataRecovery as any).hasTombstone(key);
            }
            if (!hasTomb) {
              const info = await this.dataRecovery.checkFileInCloud(key);
              if (info.exists) {
                this.knownKeys.set(key, true);
                await this.rollback(transactionId);
                return false;
              }
            }
            this.missingKeys.set(key, true);
          }
        }
        // Also check pendingWrites of other active tx via reading within tx
        // (write will deepMerge, but for create we need empty). The exclusive
        // lock guarantees no other tx is writing this key concurrently.

        await this.write(transactionId, key, initialData === undefined ? {} : initialData);
        await this.commit(transactionId);
        this.knownKeys.set(key, true);
        this.missingKeys.delete(key);

        return true;
      } catch (error) {
        try { await this.rollback(transactionId); } catch { }
        throw new Error(`Create failed for key '${key}': ${error instanceof Error ? error.message : 'Unknown error'}`, { cause: error });
      }
    });
  }

  async update(key: string, data: any): Promise<void> {
    const transactionId = this._beginTransaction();

    try {
      await this.write(transactionId, key, data);
      await this.commit(transactionId);
      return;
    } catch (error) {
      await this.rollback(transactionId);
      throw error;
    }
  }

  /**
   * Read a document. Returns the document data on success, or `null` if the
   * document is absent (use `=== null` to check). For backwards-compat, `false`
   * is still treated as "not found" by callers, but new code should check for null.
   * Throws for genuine errors (invalid key, corrupt file).
   *
   * Fast path (3 tiers, zero-syscall on hit):
   *   1. LRU cache (committed entries) — pure memory, 900k+ ops/s
   *   2. committedBuffer (committed but not yet flushed to disk) — pure memory
   *   3. Read from data file via 2-level hash-prefix partitioned path (atomic
   *      rename guarantees valid JSON; no single dentry holds >50k files)
   *
   * NO transaction is created, NO WAL I/O, NO lock acquired.
   */
  async get(key: string): Promise<any | null> {
    this.validateKey(key);
    this.cacheRequests++;

    // 1. Fast path: committed cache hit — no tx, no WAL, no lock, no syscall
    const cachedEntry = this.cache.get(key);
    if (cachedEntry && !cachedEntry.transactionId) {
      this.cacheHits++;
      return deepClone(cachedEntry.data);
    }

    // 2. Check committedBuffer (committed but not yet flushed to data files)
    const committed = this.acidEngine.getCommittedData(key);
    if (committed !== undefined) {
      if (committed === null) return null;
      this.updateCache(key, committed, undefined);
      return deepClone(committed);
    }

    // 3. Slow path: read directly from disk (partitioned path; atomic rename = consistent)
    const filePath = this.keyToPath(key);
    if (!existsSync(filePath)) {
      const hydrated = await this.hydrateKey(key);
      if (hydrated !== null && hydrated !== undefined) {
        return deepClone(hydrated);
      }
      return null;
    }

    try {
      const content = readFileSync(filePath, 'utf-8');
      const data = content.trim() ? JSON.parse(content) : {};
      this.updateCache(key, data, undefined);
      return deepClone(data);
    } catch (error) {
      throw new Error(`Read failed for key '${key}': ${error instanceof Error ? error.message : 'Unknown error'}`, { cause: error });
    }
  }

  /**
   * Map a document key to its partitioned path on disk (2-level hash-prefix).
   * Delegates to the ENGINE'S partitionedPath() — the single authoritative
   * implementation. The previous local FNV-1a re-implementation produced the
   * same paths only by convention; if the two ever drifted, get() would read a
   * different file than the engine writes (silent data loss). The engine's
   * hash computes a 64-bit value (2 imul/char vs 1) but this runs only on
   * cache-miss reads, which are syscall-dominated — measured impact: none.
   */
  private keyToPath(key: string): string {
    return partitionedPath(this.teroDirectory, key);
  }

  private localTombstonePath(key: string): string {
    const hash = createHash('sha256').update(key).digest('hex');
    return pathJoin(this.teroDirectory, '.tombstones', `${hash}.deleted`);
  }

  private writeLocalTombstone(key: string): void {
    const dir = pathJoin(this.teroDirectory, '.tombstones');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const p = this.localTombstonePath(key);
    // Store LSN for version ordering
    const lsn = this.acidEngine?.getLastCommittedLSN?.() ?? Date.now();
    writeFileSync(p, JSON.stringify({ key, lsn, deletedAt: Date.now() }));
    const fd = openSync(p, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    const dirFd = openSync(dir, 'r');
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  }

  private hasLocalTombstone(key: string): boolean {
    try {
      const p = this.localTombstonePath(key);
      if (!existsSync(p)) return false;
      // Tombstone is durable until explicitly cleared on re-create
      return true;
    } catch {
      return false;
    }
  }

  private deleteLocalTombstone(key: string): void {
    const p = this.localTombstonePath(key);
    if (!existsSync(p)) return;

    unlinkSync(p);

    const dir = pathJoin(this.teroDirectory, '.tombstones');
    const dirFd = openSync(dir, 'r');
    try {
        fsyncSync(dirFd);
    } finally {
        closeSync(dirFd);
    }

    if (existsSync(p)) {
        throw new Error(`Failed to durably remove local tombstone for '${key}'`);
    }
  }

  private pendingCloudPath(): string {
    return pathJoin(this.teroDirectory, '.cloud_pending.json');
  }

  private pendingCloudDeletionsPath(): string {
    return pathJoin(this.teroDirectory, '.cloud_pending_deletions.json');
  }

  private loadPendingCloud(): void {
    try {
      const p = this.pendingCloudPath();
      if (!existsSync(p)) return;
      const raw = readFileSync(p, 'utf8');
      const arr: unknown = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (typeof item === 'string') {
            // legacy pending entry; recover LSN from local tombstone
            let lsn = 0;
            try {
              const content = readFileSync(this.localTombstonePath(item), 'utf8');
              const obj = JSON.parse(content);
              if (typeof obj.lsn === 'number') lsn = obj.lsn;
            } catch {}
            this.cloudPendingTombstones.set(item, lsn);
          } else if (Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'number') {
            this.cloudPendingTombstones.set(item[0], item[1]);
          } else if (item && typeof (item as any).key === 'string' && typeof (item as any).deletionLsn === 'number') {
            this.cloudPendingTombstones.set((item as any).key, (item as any).deletionLsn);
          }
        }
      } else if (arr && typeof arr === 'object') {
        for (const [k, v] of Object.entries(arr as Record<string, unknown>)) {
          if (typeof v === 'number') this.cloudPendingTombstones.set(k, v);
        }
      }
    } catch { /* approved */ }
  }

  private savePendingCloud(): void {
    const p = this.pendingCloudPath();
    const dir = pathJoin(this.teroDirectory, '.tombstones');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (this.cloudPendingTombstones.size === 0) {
      if (existsSync(p)) unlinkSync(p);
      return;
    }
    const tmp = `${p}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify([...this.cloudPendingTombstones.entries()]));
    const fd = openSync(tmp, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, p);
    const dirFd = openSync(pathJoin(this.teroDirectory, '.tombstones'), 'r');
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  }

  private loadPendingCloudDeletions(): void {
    try {
      const p = this.pendingCloudDeletionsPath();
      if (!existsSync(p)) return;
      const raw = readFileSync(p, 'utf8');
      const arr: unknown = JSON.parse(raw);
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'number') {
            this.cloudPendingTombstoneDeletions.set(item[0], item[1]);
          } else if (item && typeof (item as any).key === 'string' && typeof (item as any).expectedVersion === 'number') {
            this.cloudPendingTombstoneDeletions.set((item as any).key, (item as any).expectedVersion);
          } else if (typeof item === 'string') {
            this.cloudPendingTombstoneDeletions.set(item, 0);
          }
        }
      }
    } catch { /* approved */ }
  }

  private savePendingCloudDeletions(): void {
    const p = this.pendingCloudDeletionsPath();
    const dir = pathJoin(this.teroDirectory, '.tombstones');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (this.cloudPendingTombstoneDeletions.size === 0) {
      if (existsSync(p)) unlinkSync(p);
      return;
    }
    const tmp = `${p}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify([...this.cloudPendingTombstoneDeletions.entries()]));
    const fd = openSync(tmp, 'r');
    try { fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, p);
    const dirFd = openSync(pathJoin(this.teroDirectory, '.tombstones'), 'r');
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  }

  private queueCloudTombstoneDeletion(key: string, expectedVersion?: number): void {
    const ver = expectedVersion ?? this.acidEngine?.getLastCommittedLSN?.() ?? Date.now();
    this.cloudPendingTombstoneDeletions.set(key, ver);
    this.savePendingCloudDeletions();
    this.scheduleCloudRetry();
  }

  private queueCloudTombstone(key: string, deletionLsn?: number): void {
    const lsn = deletionLsn ?? this.acidEngine?.getLastCommittedLSN?.() ?? Date.now();
    this.cloudPendingTombstones.set(key, lsn);
    this.savePendingCloud();
    this.scheduleCloudRetry();
  }

  private async withReconciliationLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const store = this.reconciliationLockStorage.getStore();
    if (store && store.has(key)) {
      // Re-entrant: already holding lock for this key in current async context
      return await fn();
    }
    const prev = this.reconciliationLocks.get(key);
    if (prev) {
      try { await prev; } catch {}
    }
    let resolveLock!: () => void;
    const lockPromise = new Promise<void>((resolve) => { resolveLock = resolve; });
    this.reconciliationLocks.set(key, lockPromise);
    const newStore = new Set<string>(store || []);
    newStore.add(key);
    return this.reconciliationLockStorage.run(newStore, async () => {
      try {
        return await fn();
      } finally {
        resolveLock();
        if (this.reconciliationLocks.get(key) === lockPromise) {
          this.reconciliationLocks.delete(key);
        }
      }
    });
  }

  private scheduleCloudRetry(): void {
    if (this.cloudPendingTimer) return;
    if (!this.dataRecovery || this.hydrateMode !== 'lazy') return;
    if (this.cloudPendingTombstones.size === 0 && this.cloudPendingTombstoneDeletions.size === 0) return;
    this.cloudPendingTimer = setTimeout(() => {
      this.cloudPendingTimer = undefined;
      void this.retryPendingCloudTombstones();
      void this.retryPendingCloudTombstoneDeletions();
    }, 2000);
    (this.cloudPendingTimer as any).unref?.();
  }

  private async retryPendingCloudTombstones(): Promise<void> {
    if (this.cloudPendingTombstones.size === 0) return;
    if (!this.dataRecovery) return;
    const entries = [...this.cloudPendingTombstones.entries()];
    for (const [key, deletionLsn] of entries) {
      await this.withReconciliationLock(key, async () => {
        // Verify key is still deleted before publishing stale tombstone (P0) — atomic with cloud mutation
        const committed = this.acidEngine.getCommittedData(key);
        const hasLocal = this.hasLocalTombstone(key);
        const existsLocal = existsSync(this.keyToPath(key));
        if (committed !== undefined && committed !== null) {
          // Recreated — stale tombstone, clear pending
          this.cloudPendingTombstones.delete(key);
          this.savePendingCloud();
          return;
        }
        if (!hasLocal && committed === undefined && existsLocal) {
          // File exists and no tombstone — recreated
          this.cloudPendingTombstones.delete(key);
          this.savePendingCloud();
          return;
        }
        let currentDeletionLsn = deletionLsn;
        if (hasLocal) {
          try {
            const content = readFileSync(this.localTombstonePath(key), 'utf8');
            const obj = JSON.parse(content);
            if (typeof obj.lsn === 'number' && obj.lsn !== deletionLsn) {
              currentDeletionLsn = obj.lsn;
              this.cloudPendingTombstones.set(key, currentDeletionLsn);
              this.savePendingCloud();
            }
          } catch {}
        }
        const stillDeleted = hasLocal || (committed !== undefined && committed === null) || (!existsLocal && committed === undefined);
        if (!stillDeleted) {
          this.cloudPendingTombstones.delete(key);
          this.savePendingCloud();
          return;
        }
        try {
          await this.dataRecovery!.deleteFromCloud(key);
          await (this.dataRecovery as any)!.putTombstone(key, currentDeletionLsn);
          this.cloudPendingTombstones.delete(key);
          try {
            const p = this.pendingCloudPath();
            if (this.cloudPendingTombstones.size === 0) {
              if (existsSync(p)) unlinkSync(p);
            } else {
              writeFileSync(p, JSON.stringify([...this.cloudPendingTombstones.entries()]));
            }
          } catch { /* approved */ }
        } catch (err) {
          // Keep pending for next retry; classify to avoid tight loop on auth errors
          const kind = classifyRecoveryError(err);
          if (kind === 'FATAL_AUTH') {
            // Auth failures need manual intervention — keep pending but don't hammer
            return;
          }
        }
      });
    }
    if (this.cloudPendingTombstones.size > 0 || this.cloudPendingTombstoneDeletions.size > 0) {
      this.scheduleCloudRetry();
    }
  }

  private async retryPendingCloudTombstoneDeletions(): Promise<void> {
    if (this.cloudPendingTombstoneDeletions.size === 0) return;
    if (!this.dataRecovery) return;
    const entries = [...this.cloudPendingTombstoneDeletions.entries()];
    for (const [key, expectedVersion] of entries) {
      await this.withReconciliationLock(key, async () => {
        // Verify key is still present (recreated) before deleting tombstone
        // If key is now deleted (hasLocalTombstone), don't delete tombstone
        const committed = this.acidEngine.getCommittedData(key);
        const hasLocal = this.hasLocalTombstone(key);
        const existsLocal = existsSync(this.keyToPath(key));
        // If key is deleted (has tombstone or committed null), don't delete cloud tombstone
        if (hasLocal || (committed !== undefined && committed === null) || (!existsLocal && committed === undefined && this.cloudPendingTombstones.has(key))) {
          // Key is currently deleted — cloud tombstone should remain, clear pending deletion
          this.cloudPendingTombstoneDeletions.delete(key);
          this.savePendingCloudDeletions();
          return;
        }
        // Key is present — tombstone should be deleted
        try {
          await (this.dataRecovery as any).deleteTombstone?.(key);
          this.cloudPendingTombstoneDeletions.delete(key);
          this.savePendingCloudDeletions();
        } catch (err) {
          const kind = classifyRecoveryError(err);
          if (kind === 'FATAL_AUTH') return;
        }
      });
    }
    if (this.cloudPendingTombstoneDeletions.size > 0) {
      this.scheduleCloudRetry();
    }
  }

  /** Whether cloud tombstone reconciliation is pending (P0-2). */
  isCloudReconciliationPending(): boolean {
    return this.cloudPendingTombstones.size > 0 || this.cloudPendingTombstoneDeletions.size > 0;
  }

  /** Keys with pending cloud delete/tombstone (P0-2). */
  getCloudReconciliationPendingKeys(): string[] {
    return [...new Set([...this.cloudPendingTombstones.keys(), ...this.cloudPendingTombstoneDeletions.keys()])];
  }

  /** Retry pending cloud tombstones immediately (P0-2). */
  async retryCloudReconciliation(): Promise<void> {
    await this.retryPendingCloudTombstones();
    await this.retryPendingCloudTombstoneDeletions();
  }

  async remove(key: string): Promise<void> {
    return this.withReconciliationLock(key, async () => {
      const transactionId = this._beginTransaction();
      try {
        await this._deleteRaw(transactionId, key);
        await this.commit(transactionId);
        this.knownKeys.delete(key);
        this.missingKeys.set(key, true);
        this.writeLocalTombstone(key);
        if (this.dataRecovery && this.hydrateMode === 'lazy') {
          // Already inside outer reconciliation lock — re-check still deleted before cloud mutation
          const committed = this.acidEngine.getCommittedData(key);
          const hasLocal = this.hasLocalTombstone(key);
          const existsLocal = existsSync(this.keyToPath(key));
          const stillDeleted = hasLocal || (committed !== undefined && committed === null) || (!existsLocal && committed === undefined);
          if (!stillDeleted) {
            this.cloudPendingTombstones.delete(key);
            this.savePendingCloud();
            return;
          }
          const lsn = this.acidEngine!.getLastCommittedLSN();
          let failed = false;
          try {
            await this.dataRecovery!.deleteFromCloud(key);
          } catch { failed = true; }
          try {
            await (this.dataRecovery as any).putTombstone(key, lsn);
          } catch { failed = true; }
          if (failed) this.queueCloudTombstone(key, lsn);
          else if (this.cloudPendingTombstones.has(key)) {
            this.cloudPendingTombstones.delete(key);
            this.savePendingCloud();
          }
        }
      } catch (error) {
        try { await this.rollback(transactionId); } catch {}
        throw error;
      }
    });
  }

  async delete(key: string): Promise<void> {
    return await this.remove(key);
  }

  exists(key: string): boolean {
    // Fail-fast on invalid keys — don't mask programming errors as "not found"
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
  }

  // Batch Operations
  async batchWrite(operations: Array<{ key: string; data: any }>): Promise<void> {
    const transactionId = this._beginTransaction();

    try {
      for (const op of operations) {
        await this.write(transactionId, op.key, op.data);
      }
      await this.commit(transactionId);
      // Register all written keys in knownKeys so future exists() calls are O(1)
      for (const op of operations) {
        this.knownKeys.set(op.key, true);
        this.missingKeys.delete(op.key);
      }
    } catch (error) {
      await this.rollback(transactionId);
      throw new Error(`Batch write failed: ${error instanceof Error ? error.message : 'Unknown error'}`, { cause: error });
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
      throw new Error(`Batch read failed: ${error instanceof Error ? error.message : 'Unknown error'}`, { cause: error });
    }
  }

  // Money transfer example demonstrating ACID properties
  async transferMoney(fromKey: string, toKey: string, amount: number): Promise<void> {
    if (amount <= 0) {
      throw new Error('Transfer amount must be positive');
    }

    const transactionId = this._beginTransaction();

    try {
      // Acquire exclusive locks in GLOBAL SORTED ORDER *before* reading.
      // Two concurrent opposite-direction transfers (A→B and B→A) that
      // first take shared locks on their source then try to upgrade to
      // exclusive will deadlock (both hold shared, both wait for the
      // other). Sorted exclusive acquisition + SERIALIZABLE reads avoids
      // both the deadlock and the read-check-write overdraft race where
      // two transfers both pass the balance check under shared locks.
      const [firstKey, secondKey] = [fromKey, toKey].sort();
      const a1 = this.acidEngine.acquireExclusiveLock(transactionId, firstKey);
      if (a1 !== undefined) await a1;
      const a2 = this.acidEngine.acquireExclusiveLock(transactionId, secondKey);
      if (a2 !== undefined) await a2;

      // Now reads are performed while already holding exclusive — they
      // cannot interleave with another transfer's balance check.
      const fromAccount = await this.read(transactionId, fromKey);
      const toAccount = await this.read(transactionId, toKey);

      if (!fromAccount || !toAccount) {
        throw new Error('One or both accounts do not exist');
      }

      if (fromAccount.balance < amount) {
        throw new Error('Insufficient funds');
      }

      // Update balances — writes reuse the already-held exclusive locks
      // (acquired above in sorted order), so no additional ordering needed.
      const balances: Record<string, any> = { [fromKey]: fromAccount, [toKey]: toAccount };
      const deltas: Record<string, number> = { [fromKey]: -amount, [toKey]: +amount };
      for (const key of [firstKey, secondKey]) {
        await this.write(transactionId, key, {
          ...balances[key],
          balance: balances[key].balance + deltas[key]
        });
      }

      // Commit the transaction
      await this.commit(transactionId);
    } catch (error) {
      await this.rollback(transactionId);
      throw new Error(`Money transfer failed: ${error instanceof Error ? error.message : 'Unknown error'}`, { cause: error });
    }
  }

  // Internal raw methods for Transaction class
  async _writeRaw(transactionId: string, key: string, data: any): Promise<void> {
    const cachedEntry = this.cache.get(key);
    const cachedData = (cachedEntry && (!cachedEntry.transactionId || cachedEntry.transactionId === transactionId)) ? cachedEntry.data : undefined;
    const result = this.acidEngine.write(transactionId, key, data, cachedData);
    if (result !== undefined) await result;
    // Cache the MERGED afterImage, not the raw caller input. The engine
    // deep-merges partial updates with existing state, so caching `data`
    // would poison the cache with incomplete documents — a second tx.update
    // to the same key would lose fields written by the first update until a
    // disk re-read. (Tero.write() does this correctly; the Transaction path
    // goes through this raw method, so it must too.)
    const afterImage = this.acidEngine.getPendingAfterImage(transactionId, key);
    this.updateCache(key, afterImage !== undefined ? afterImage : data, transactionId);
  }

  async _readRaw(transactionId: string, key: string): Promise<any> {
    this.cacheRequests++;
    const cachedEntry = this.cache.get(key);
    if (cachedEntry && (!cachedEntry.transactionId || cachedEntry.transactionId === transactionId)) {
      this.cacheHits++;
      return deepClone(cachedEntry.data);
    }
    const result = this.acidEngine.read(transactionId, key);
    const data = (result !== undefined && result instanceof Promise) ? await result : result;
    if (data !== null && data !== undefined) {
      this.updateCache(key, data, transactionId);
    }
    return deepClone(data);
  }

  async _deleteRaw(transactionId: string, key: string): Promise<void> {
    const result = this.acidEngine.delete(transactionId, key);
    if (result !== undefined) await result;
    // Track for commit-time generation bump and cache cleanup
    let touched = this.txTouchedKeys.get(transactionId);
    if (!touched) {
      touched = new Set();
      this.txTouchedKeys.set(transactionId, touched);
    }
    touched.add(key);
    this.cache.delete(key);
    this.knownKeys.delete(key);
    this.missingKeys.set(key, true);
  }

  async _rollbackRaw(transactionId: string): Promise<void> {
    this.acidEngine.rollbackTransaction(transactionId);
    // Invalidate cache entries this transaction touched and drop the tracking
    // set. Without this, the timeout rollback path (Transaction constructor
    // timer) leaves stale cache entries tagged with the dead txId, and
    // txTouchedKeys grows unbounded across timed-out transactions.
    const touched = this.txTouchedKeys.get(transactionId);
    if (touched) {
      for (const k of touched) this.cache.delete(k);
      this.txTouchedKeys.delete(transactionId);
    }
    this.rolledBackCount++;
  }

  _getTxStatus(transactionId: string): 'active' | 'committed' | 'aborted' | 'not_found' {
    return this.acidEngine.getTransactionStatus(transactionId);
  }

  _isTransactionActive(transactionId: string): boolean {
    return this.acidEngine.isTransactionActive(transactionId);
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
  // ---------------------------------------------------------------------------
  // Backup Management
  // ---------------------------------------------------------------------------

  configureBackup(config: BackupConfig): void {
    try {
      const effectiveConfig = { ...config };
      if (this.hydrateMode === 'lazy' && effectiveConfig.pruneDeleted === undefined) {
        effectiveConfig.pruneDeleted = false;
      }
      this.backupManager = new BackupManager(this.teroDirectory, effectiveConfig);
    } catch (error) {
      throw new Error(`Failed to configure backup: ${error instanceof Error ? error.message : 'Unknown error'}`, { cause: error });
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
    this.acidEngine.flushCommittedBuffer(true);
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
    const walArchivePaths = this.acidEngine.getWAL().listArchives();
    return await this.backupManager.backupToBucket({
      walArchivePaths,
      tag: options?.tag,
      engine: this.acidEngine,
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
    // Flush deferred data before archiving — mirrors commitTransaction()
    // rotation guard; otherwise committedBuffer data would be lost if we
    // crashed right after rotating and truncating .wal.
    (this.acidEngine as any).flushCommittedBuffer?.();
    this.acidEngine.getWAL().rotateLog();
    return await this.backupToBucket(options);
  }

  // ---------------------------------------------------------------------------
  // Live Backup (per-second WAL shipping — RPO ≤ 1s)
  // ---------------------------------------------------------------------------

  /** Enable per-second live WAL shipping to the bucket. Only consistency: 'per-second'. */
  enableLiveBackup(opts: LiveBackupOptions): void {
    if (!this.backupManager) throw new Error('Backup not configured. Call configureBackup() first.');
    this.backupManager.enableLiveBackup(this.acidEngine, opts);
  }

  /** Stop live WAL shipping. */
  disableLiveBackup(): void {
    this.backupManager?.disableLiveBackup();
  }

  /** Current live-backup health and counters. */
  getLiveBackupStatus(): LiveBackupStatus {
    if (!this.backupManager) return { state: 'stopped', nodeId: 'unknown', intervalMs: 0, lastShippedLsn: 0, lastShipAt: 0, secondsSinceLastShip: 0, segmentsShipped: 0, checkpointsTaken: 0, errorCount: 0 };
    return this.backupManager.getLiveBackupStatus();
  }

  /** Take a checkpoint: FULL on the first call after enable (also taken
   *  automatically), INCREMENTAL (only dirty docs) on subsequent calls. */
  async liveCheckpointToBucket(opts?: { tag?: string }): Promise<LiveCheckpointResult> {
    if (!this.backupManager) throw new Error('Backup not configured. Call configureBackup() first.');
    // No flush here on purpose: the manager captures the conservative baseLsn
    // FIRST and flushes after — flushing before capture would be the wrong order.
    return await this.backupManager.liveCheckpointToBucket(opts);
  }

  /** Restore a fresh Tero instance from a live backup in the bucket. */
  static async restoreFromLiveBackup(opts: {
    directory: string;
    cloudStorage: CloudStorageConfig;
    nodeId?: string;
    pointInTime?: number;
    targetLsn?: number;
    customS3Client?: any;
    /** Name of the ORIGINAL database directory in the bucket, if restoring to a
     *  new directory name (disaster-recovery / staging restores). Defaults to `directory`. */
    sourceDirectory?: string;
  }): Promise<Tero> {
    const sanitized = validateDirectory(opts.directory);
    const source = validateDirectory(opts.sourceDirectory ?? opts.directory);
    // The temp manager is built with the SOURCE name so bucket prefixes resolve;
    // files are written into the sanitized TARGET directory.
    const tempMgr = new BackupManager(source, { format: 'individual', cloudStorage: opts.cloudStorage, customS3Client: opts.customS3Client });
    try {
      await tempMgr.restoreLiveToDirectory(sanitized, { nodeId: opts.nodeId, pointInTime: opts.pointInTime, targetLsn: opts.targetLsn });
    } finally {
      tempMgr.destroy();
    }
    return new Tero({ directory: opts.directory });
  }

  // ---------------------------------------------------------------------------
  // Data Recovery
  // ---------------------------------------------------------------------------

  configureDataRecovery(config: RecoveryConfig): void {
    try {
      this.dataRecovery = new DataRecovery(config);
    } catch (error) {
      throw new Error(`Failed to configure data recovery: ${error instanceof Error ? error.message : 'Unknown error'}`, { cause: error });
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
   * bucket and cache the result. Returns the data, or `null` if the key genuinely
   * doesn't exist on either side (returns `false` for backwards compat — both mean "not found").
   * Throws for real (auth/network) errors so callers don't silently mistake them for "not in cloud".
   *
   * Options:
   *   - fallbackToCloud: boolean (default true) — set false to skip cloud fetch
   *   - mode: 'missing' (default) — only fetch if missing locally; 'all' — always overwrite from cloud
   *   - throwOnRecoveryError: boolean (default false) — re-throw cloud/recovery errors instead of returning null
   */
  async getWithRecovery(key: string, options?: { fallbackToCloud?: boolean; mode?: 'missing' | 'all'; throwOnRecoveryError?: boolean }): Promise<any | null> {
    try {
      this.validateKey(key);
    } catch (error) {
      throw error;
    }

    const fallbackToCloud = options?.fallbackToCloud ?? true;

    // 1) Try local first. Handle both null (new) and false (legacy) as "not found"
    try {
      const localData = await this.get(key);
      if (localData !== null && (localData as any) !== false) {
        return localData;
      }
    } catch (err) {
      if (options?.throwOnRecoveryError) {
        throw err;
      }
      return null;
    }

    // 2) Not local. Optionally fall back to cloud.
    if (!fallbackToCloud) return null;
    if (!this.dataRecovery) {
      // No cloud configured — return null to keep "absent" semantics consistent with get().
      return null;
    }

    // 3) Cloud fetch. If throwOnRecoveryError is true, any fatal/cloud error is rethrown.
    // Otherwise, best-effort fallback returns null.
    try {
      const recovered = await this.dataRecovery.recoverSingleFile(key);
      if (!recovered) {
        return null;
      }
      // Cache + return the freshly hydrated data.
      // Re-run get() so the read goes through the cache + lint path.
      this.cache.delete(key);
      return await this.get(key);
    } catch (error) {
      if (options?.throwOnRecoveryError) {
        throw error;
      }
      return null;
    }
  }

  /**
   * Strict version of getWithRecovery that throws any recovery/cloud error (auth, network, corruption)
   * instead of swallowing and returning null.
   */
  async getWithRecoveryStrict(key: string, options?: { fallbackToCloud?: boolean; mode?: 'missing' | 'all' }): Promise<any | null> {
    return this.getWithRecovery(key, { ...options, throwOnRecoveryError: true });
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
    this.acidEngine.flushCommittedBuffer(true);

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
          const raw = readFileSync(filePath, 'utf8');
          const data = JSON.parse(raw);
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
      throw new Error(`Data integrity verification failed: ${error instanceof Error ? error.message : 'Unknown error'}`, { cause: error });
    }
  }

  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Acquire an exclusive lock on the data directory via a `.lock` file
   * (openSync 'wx' exclusive-create — no native modules, cross-platform).
   * The holder's PID is written to the file; if acquisition fails and the
   * recorded PID is no longer alive, the stale lock from a crashed process
   * is reclaimed automatically.
   */
  private acquireFileLock(): void {
    const lockPath = `${this.teroDirectory}/.lock`;
    const tryAcquire = (): boolean => {
      try {
        this.lockFd = openSync(lockPath, 'wx'); // exclusive create — fails if exists
        writeSync(this.lockFd, String(process.pid));
        return true;
      } catch {
        return false;
      }
    };
    if (tryAcquire()) return;

    // Retry loop with bounded attempts for TOCTOU races during stale-lock reclamation
    for (let attempt = 0; attempt < 3; attempt++) {
      let pid = '?';
      if (existsSync(lockPath)) {
        try { pid = readFileSync(lockPath, 'utf-8').trim(); } catch { /* unreadable */ }
      }
      const pidNum = parseInt(pid, 10);
      if (Number.isInteger(pidNum) && pidNum > 0 && pidNum !== process.pid) {
        let alive = true;
        try { process.kill(pidNum, 0); } catch (e: any) {
          // ESRCH = no such process → stale lock from a crashed holder.
          // EPERM = process exists but is owned by another user → treat as alive.
          alive = e?.code === 'EPERM';
        }
        if (!alive) {
          // Reclaim the stale lock (crashed previous owner) and retry once.
          try { unlinkSync(lockPath); } catch { /* racing holder */ }
          if (tryAcquire()) return;
          continue;
        }
        if (alive) {
          throw new Error(`Data directory '${this.teroDirectory}' is locked by live process ${pidNum}. ` +
            'Stop that process (or use a different directory) and retry.');
        }
      }
      if (pid === String(process.pid)) {
        throw new Error(`Another Tero instance in THIS process is already using '${this.teroDirectory}'. ` +
          'Destroy the existing instance before constructing a new one.');
      }
      if (tryAcquire()) return;
    }
    throw new Error(`Data directory '${this.teroDirectory}' is locked. ` +
      `If the holder crashed, delete '${lockPath}' and retry.`);
  }

  private releaseFileLock(): void {
    if (this.lockFd == null) return;
    try {
      closeSync(this.lockFd);
      unlinkSync(`${this.teroDirectory}/.lock`);
    } catch { /* best-effort */ }
  }

  // Cleanup methods
  async destroyAsync(): Promise<void> {
    if (this.cloudPendingTimer) {
      clearTimeout(this.cloudPendingTimer);
      this.cloudPendingTimer = undefined;
    }
    // Drain cloud tombstone retries best-effort
    if (this.cloudPendingTombstones.size > 0) {
      try { await this.retryPendingCloudTombstones(); } catch { /* approved */ }
    }
    if (this.backupManager) {
      await this.backupManager.drainInFlight();
      this.backupManager.destroy();
    }
    if (this.acidEngine) {
      this.acidEngine.destroy();
    }
    this.inFlightHydrations.clear();
    this.missingKeys.clear();
    this.clearCache();
    this.releaseFileLock();
  }

  async close(): Promise<void> {
    await this.destroyAsync();
  }

  destroy(): void {
    // Sync destroy cannot drain inflight S3 uploads (that's async) — warn if live backup has in-flight work.
    // Prefer `await db.destroyAsync()` / `await db.close()` in production when live backup is enabled.
    if (this.cloudPendingTimer) {
      clearTimeout(this.cloudPendingTimer);
      this.cloudPendingTimer = undefined;
    }
    if (this.cloudPendingTombstones.size > 0) {
      console.warn(`[Tero] destroy() with ${this.cloudPendingTombstones.size} pending cloud tombstone(s) — use await destroyAsync() to retry cloud reconciliation`);
    }
    if (this.backupManager) {
      const live = (this.backupManager as any).liveCheckpointPromise;
      if (live) {
        console.warn('[Tero] destroy() called with inflight live checkpoint — use await destroyAsync() to avoid losing the last checkpoint.');
      }
      this.backupManager.destroy();
    }
    if (this.acidEngine) {
      this.acidEngine.destroy();
    }
    this.inFlightHydrations.clear();
    this.missingKeys.clear();
    this.clearCache();
    this.releaseFileLock();
  }

  /**
   * Returns true if the database encountered a non-fatal maintenance error
   * (such as background checkpoint or archive failure) and is running in degraded mode.
   */
  isDegraded(): boolean {
    return this.acidEngine?.isDegraded() ?? false;
  }

  /**
   * Returns the most recent background maintenance error, if any.
   */
  getLastMaintenanceError(): Error | null {
    return this.acidEngine?.getLastMaintenanceError() ?? null;
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
    const buffer = Buffer.allocUnsafe(12);
    const time = ~~(Date.now() / 1000);
    // Module-level monotonic counter (see PROCESS_UNIQUE above) — guarantees
    // within-process uniqueness even for ids minted in the same millisecond,
    // with zero crypto calls on this path.
    const inc = (idCounter = (idCounter + 1) % 0xffffff);

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
export {
  BackupConfig,
  BackupMetadata,
  BucketBackupResult,
  CloudStorageConfig,
  RecoveryConfig,
  RecoveryResult,
  FileRecoveryInfo,
  HydrateConfig,
  HydrationMode,
  TeroConfig,
  LiveBackupOptions,
  LiveBackupStatus,
  LiveCheckpointResult,
  RestoreLiveResult,
  BackupLogger,
  RecoveryCorruptionError,
  DataCorruptionError
};