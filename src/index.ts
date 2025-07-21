import { existsSync, mkdirSync } from "fs";
import { ACIDStorageEngine } from "./acid-engine.js";
import { SchemaValidator, DocumentSchema, ValidationResult } from "./schema.js";
import { BackupManager, BackupConfig, BackupMetadata } from "./backup.js";
import { DataRecovery, RecoveryConfig, RecoveryResult, FileRecoveryInfo } from "./recovery.js";
import { randomBytes } from "node:crypto";
import QuickLRU from "quick-lru";

interface TeroConfig {
  directory?: string;
  cacheSize?: number;
}

interface CacheEntry {
  data: any;
  lastAccessed: number;
  transactionId?: string; // Track which transaction cached this
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

  constructor(config?: TeroConfig) {
    try {
      const { directory, cacheSize } = config || {};

      if (typeof directory === "string" && directory.trim()) {
        // Sanitize directory path to prevent directory traversal
        this.teroDirectory = directory.replace(/[^a-zA-Z0-9_\-\/]/g, '');
      }

      if (typeof cacheSize === "number" && cacheSize > 0) {
        this.cacheSize = Math.min(cacheSize, 1000); // Cap at 1k entries
      }

      // Create directories with proper error handling
      this.initializeDirectories();

      // Initialize QuickLRU cache
      this.cache = new QuickLRU<string, CacheEntry>({
        maxSize: this.cacheSize
      });

      // Initialize ACID storage engine (primary system)
      this.acidEngine = new ACIDStorageEngine(this.teroDirectory);

      // Initialize schema validator
      this.schemaValidator = new SchemaValidator();
    } catch (error) {
      throw new Error(`Failed to initialize Tero: ${error instanceof Error ? error.message : 'Unknown error'}`);
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



  private invalidateCacheKeys(keys: string[]): void {
    for (const key of keys) {
      this.cache.delete(key);
    }
  }

  private updateCache(key: string, data: any, transactionId?: string): void {
    this.cache.set(key, {
      data: { ...data },
      lastAccessed: Date.now(),
      transactionId
    });
  }

  // Core ACID Operations
  beginTransaction(): string {
    try {
      return this.acidEngine.beginTransaction();
    } catch (error) {
      throw new Error(`Failed to begin transaction: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async write(transactionId: string, key: string, data: any, options?: {
    validate?: boolean;
    schemaName?: string;
    strict?: boolean;
  }): Promise<ValidationResult | void> {
    try {
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

      await this.acidEngine.write(transactionId, key, data);

      // Update cache with transaction context
      this.updateCache(key, data, transactionId);

      if (options?.validate || options?.schemaName) {
        return { valid: true, errors: [], data };
      }
    } catch (error) {
      throw new Error(`Write failed for key '${key}': ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async read(transactionId: string, key: string): Promise<any> {
    try {
      this.validateKey(key);
      this.cacheRequests++;

      // Check cache first, but only if it's from the same transaction or committed
      const cachedEntry = this.cache.get(key);
      if (cachedEntry && (!cachedEntry.transactionId || cachedEntry.transactionId === transactionId)) {
        this.cacheHits++;
        cachedEntry.lastAccessed = Date.now();
        return cachedEntry.data;
      }

      // Read from ACID engine
      const data = await this.acidEngine.read(transactionId, key);

      if (data !== null) {
        this.updateCache(key, data, transactionId);
      }

      return data;
    } catch (error) {
      throw new Error(`Read failed for key '${key}': ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async delete(transactionId: string, key: string): Promise<void> {
    try {
      this.validateKey(key);
      await this.acidEngine.delete(transactionId, key);

      // Remove from cache
      this.cache.delete(key);
    } catch (error) {
      throw new Error(`Delete failed for key '${key}': ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async commit(transactionId: string): Promise<void> {
    try {
      // Get affected keys before commit
      const transaction = this.acidEngine.getActiveTransactions().includes(transactionId);
      if (!transaction) {
        throw new Error(`Transaction ${transactionId} not found or not active`);
      }

      await this.acidEngine.commitTransaction(transactionId);

      // Invalidate cache entries for this transaction to force fresh reads
      const keysToInvalidate: string[] = [];
      for (const [key, entry] of this.cache.entries()) {
        if (entry.transactionId === transactionId) {
          keysToInvalidate.push(key);
        }
      }
      this.invalidateCacheKeys(keysToInvalidate);
    } catch (error) {
      throw new Error(`Failed to commit transaction: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async rollback(transactionId: string): Promise<void> {
    try {
      await this.acidEngine.rollbackTransaction(transactionId);

      // Remove cache entries for this transaction
      const keysToRemove: string[] = [];
      for (const [key, entry] of this.cache.entries()) {
        if (entry.transactionId === transactionId) {
          keysToRemove.push(key);
        }
      }
      this.invalidateCacheKeys(keysToRemove);
    } catch (error) {
      throw new Error(`Failed to rollback transaction: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  // Convenience Methods (Auto-transaction)
  async create(key: string, initialData?: any, options?: {
    validate?: boolean;
    schemaName?: string;
    strict?: boolean;
  }): Promise<ValidationResult | boolean> {
    const transactionId = this.beginTransaction();

    try {
      // Check if file already exists
      const existing = await this.read(transactionId, key);
      if (existing !== null) {
        await this.rollback(transactionId);
        return false; // File already exists
      }

      // Create with initial data or empty object
      const result = await this.write(transactionId, key, initialData || {}, options);
      await this.commit(transactionId);

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
    const transactionId = this.beginTransaction();

    try {
      const result = await this.write(transactionId, key, data, options);
      await this.commit(transactionId);
      return result;
    } catch (error) {
      await this.rollback(transactionId);
      throw error;
    }
  }

  async get(key: string): Promise<any> {
    const transactionId = this.beginTransaction();

    try {
      const data = await this.read(transactionId, key);
      await this.commit(transactionId);
      return data;
    } catch (error) {
      await this.rollback(transactionId);
      throw error;
    }
  }

  async remove(key: string): Promise<void> {
    const transactionId = this.beginTransaction();

    try {
      await this.delete(transactionId, key);
      await this.commit(transactionId);
    } catch (error) {
      await this.rollback(transactionId);
      throw error;
    }
  }

  exists(key: string): boolean {
    try {
      this.validateKey(key);
      return existsSync(`${this.teroDirectory}/${key}.json`);
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
    const transactionId = this.beginTransaction();

    try {
      for (const op of operations) {
        await this.write(transactionId, op.key, op.data, options);
      }
      await this.commit(transactionId);
    } catch (error) {
      await this.rollback(transactionId);
      throw new Error(`Batch write failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async batchRead(keys: string[]): Promise<{ [key: string]: any }> {
    const transactionId = this.beginTransaction();
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

    const transactionId = this.beginTransaction();

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

  // Backup Management
  configureBackup(config: BackupConfig): void {
    try {
      this.backupManager = new BackupManager(this.teroDirectory, config);
    } catch (error) {
      throw new Error(`Failed to configure backup: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async performBackup(): Promise<{ success: boolean; metadata: BackupMetadata; cloudUploaded?: boolean }> {
    if (!this.backupManager) {
      throw new Error('Backup not configured. Call configureBackup() first.');
    }
    return await this.backupManager.performBackup();
  }

  // Data Recovery
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

  // Utility Methods
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
    const result = {
      totalFiles: 0,
      corruptedFiles: [] as string[],
      missingFiles: [] as string[],
      healthy: true
    };

    try {
      const { readdirSync } = await import('fs');
      const files = readdirSync(this.teroDirectory)
        .filter((file: string) => file.endsWith('.json'));

      result.totalFiles = files.length;

      for (const file of files) {
        const key = file.replace('.json', '');
        try {
          const data = await this.get(key);
          if (data === null) {
            result.missingFiles.push(key);
            result.healthy = false;
          }
        } catch (error) {
          result.corruptedFiles.push(key);
          result.healthy = false;
        }
      }

      return result;
    } catch (error) {
      throw new Error(`Data integrity verification failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  clearCache(): void {
    this.cache.clear();
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
export { DocumentSchema, ValidationResult, BackupConfig, BackupMetadata, RecoveryConfig, RecoveryResult, FileRecoveryInfo };