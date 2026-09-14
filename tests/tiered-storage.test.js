#!/usr/bin/env node
/**
 * Tiered Storage Test Suite for Tero (Strategy 3: Infinite Keys via Object Storage)
 *
 * Verifies:
 *   1. Read-Through on Cold Miss (transparently hydrates from cloud bucket)
 *   2. Negative Caching (prevents hammering cloud storage on 404s)
 *   3. Asynchronous Write-Back (fast local commits + queued cloud sync)
 *   4. Write-Through Mode (immediate cloud persistence on commit)
 *   5. Evicted Document Update (preserves existing fields via read-through merge)
 *   6. Safe LRU Eviction (prunes cold files when exceeding maxLocalFiles)
 *   7. Eviction Safety Invariants (dirty or locked keys are never pruned)
 *   8. Cloud Deletion Sync (deletions propagate to cloud bucket)
 */

import { Tero } from '../dist/index.js';
import { existsSync, rmSync } from 'fs';
import { Readable } from 'stream';

const TEST_DIR = 'TieredTestDB';
let pass = 0, fail = 0;
const failures = [];

async function test(name, fn) {
    try {
        await fn();
        pass++;
        console.log(`  ✓ ${name}`);
    } catch (e) {
        fail++;
        failures.push({ name, error: e.message, stack: e.stack });
        console.error(`  ✗ ${name}: ${e.message}`);
    }
}

function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'Assertion failed');
}

function cleanup() {
    try {
        if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    } catch { }
}

/**
 * In-Memory Mock S3 Client simulating @aws-sdk/client-s3
 */
class MockS3Client {
    constructor() {
        this.store = new Map(); // key -> { body: string, contentType: string, metadata: any }
        this.getCalls = 0;
        this.putCalls = 0;
        this.deleteCalls = 0;
    }

    async send(command) {
        const name = command.constructor.name;
        if (name === 'PutObjectCommand') {
            this.putCalls++;
            const key = command.input.Key;
            const body = typeof command.input.Body === 'string'
                ? command.input.Body
                : command.input.Body.toString('utf-8');
            this.store.set(key, {
                body,
                contentType: command.input.ContentType,
                metadata: command.input.Metadata,
            });
            return {};
        }

        if (name === 'GetObjectCommand') {
            this.getCalls++;
            const key = command.input.Key;
            if (!this.store.has(key)) {
                const err = new Error(`NoSuchKey: ${key}`);
                err.name = 'NoSuchKey';
                err.$metadata = { httpStatusCode: 404 };
                throw err;
            }
            const item = this.store.get(key);
            return {
                Body: {
                    transformToString: async () => item.body,
                },
                ContentType: item.contentType,
            };
        }

        if (name === 'DeleteObjectCommand') {
            this.deleteCalls++;
            const key = command.input.Key;
            this.store.delete(key);
            return {};
        }

        if (name === 'HeadObjectCommand') {
            const key = command.input.Key;
            if (!this.store.has(key)) {
                const err = new Error('NotFound');
                err.name = 'NotFound';
                err.$metadata = { httpStatusCode: 404 };
                throw err;
            }
            return { ContentLength: this.store.get(key).body.length };
        }

        throw new Error(`Unsupported command: ${name}`);
    }
}

async function runTieredTests() {
    console.log('\n📦 Running Tero Tiered Storage Test Suite...\n');

    // ─────────────────────────────────────────────────────────────────
    // Test 1: Read-Through on Cold Miss
    // ─────────────────────────────────────────────────────────────────
    await test('Read-Through: fetches cold document from cloud and caches locally', async () => {
        cleanup();
        const mockS3 = new MockS3Client();

        // Seed cloud bucket directly with a document
        const cloudDoc = { id: 'user_123', name: 'Alice in Cloud', role: 'Architect' };
        mockS3.store.set('tero-backups/TieredTestDB-1/user_123.json', {
            body: JSON.stringify(cloudDoc),
            contentType: 'application/json',
        });

        const db = new Tero({
            directory: TEST_DIR,
            cacheSize: 10,
            tieredStorage: {
                enabled: true,
                cloudStorage: {
                    provider: 'aws-s3',
                    bucket: 'test-bucket',
                    pathPrefix: 'tero-backups',
                    region: 'us-east-1',
                    accessKeyId: 'mock',
                    secretAccessKey: 'mock',
                    dbName: 'TieredTestDB-1',
                },
                customS3Client: mockS3,
                maxLocalFiles: 100,
            }
        });

        // 1. Initial get: not on local disk, must read through to mock S3
        const doc = await db.get('user_123');
        assert(doc !== null, 'doc should not be null');
        assert(doc.name === 'Alice in Cloud', `expected name 'Alice in Cloud', got '${doc?.name}'`);
        assert(mockS3.getCalls === 1, `expected 1 getCall to S3, got ${mockS3.getCalls}`);

        const stats = db.getTieredStorageStats();
        assert(stats.cloudHits === 1, `expected 1 cloud hit, got ${stats.cloudHits}`);

        // 2. Second get: must hit local disk/cache (no additional S3 GET)
        const doc2 = await db.get('user_123');
        assert(doc2.name === 'Alice in Cloud', 'cached doc should match');
        assert(mockS3.getCalls === 1, `expected still 1 getCall to S3, got ${mockS3.getCalls}`);

        await db.destroyAsync();
    });

    // ─────────────────────────────────────────────────────────────────
    // Test 2: Negative Caching
    // ─────────────────────────────────────────────────────────────────
    await test('Negative Caching: prevents redundant cloud calls for non-existent keys', async () => {
        cleanup();
        const mockS3 = new MockS3Client();

        const db = new Tero({
            directory: TEST_DIR,
            tieredStorage: {
                enabled: true,
                cloudStorage: {
                    provider: 'aws-s3',
                    bucket: 'test-bucket',
                    region: 'us-east-1',
                    accessKeyId: 'mock',
                    secretAccessKey: 'mock',
                    dbName: 'TieredTestDB-2',
                },
                customS3Client: mockS3,
                negativeCacheTtlMs: 5000,
            }
        });

        // First lookup: misses local, calls S3, receives 404
        const miss1 = await db.get('ghost_key');
        assert(miss1 === null, 'miss1 should be null');
        assert(mockS3.getCalls === 1, `expected 1 S3 getCall, got ${mockS3.getCalls}`);

        // Second lookup: hits negative cache immediately without calling S3
        const miss2 = await db.get('ghost_key');
        assert(miss2 === null, 'miss2 should be null');
        assert(mockS3.getCalls === 1, `expected still 1 S3 getCall, got ${mockS3.getCalls}`);

        const stats = db.getTieredStorageStats();
        assert(stats.negativeCacheHits === 1, `expected 1 negative cache hit, got ${stats.negativeCacheHits}`);

        // Creating key invalidates negative cache
        await db.create('ghost_key', { resurrected: true });
        const found = await db.get('ghost_key');
        assert(found.resurrected === true, 'resurrected doc should be found');

        await db.destroyAsync();
    });

    // ─────────────────────────────────────────────────────────────────
    // Test 3: Asynchronous Write-Back
    // ─────────────────────────────────────────────────────────────────
    await test('Async Write-Back: writes commit fast locally and sync to cloud', async () => {
        cleanup();
        const mockS3 = new MockS3Client();

        const db = new Tero({
            directory: TEST_DIR,
            tieredStorage: {
                enabled: true,
                cloudStorage: {
                    provider: 'aws-s3',
                    bucket: 'test-bucket',
                    region: 'us-east-1',
                    accessKeyId: 'mock',
                    secretAccessKey: 'mock',
                    dbName: 'TieredTestDB-3',
                },
                customS3Client: mockS3,
                syncIntervalMs: 0, // Disable automatic background timer so we can trigger manually
            }
        });

        // Write 10 keys
        for (let i = 0; i < 10; i++) {
            await db.create(`key_${i}`, { index: i, timestamp: Date.now() });
        }

        // Before sync: keys are dirty locally, not yet in mock S3
        let stats = db.getTieredStorageStats();
        assert(stats.dirtyKeysCount === 10, `expected 10 dirty keys, got ${stats.dirtyKeysCount}`);
        assert(mockS3.putCalls === 0, `expected 0 putCalls before sync, got ${mockS3.putCalls}`);

        // Flush database committed buffer to data files first
        db.forceCheckpoint();

        // Trigger cloud sync
        const syncResult = await db.syncToCloud();
        assert(syncResult.uploaded === 10, `expected 10 uploaded keys, got ${syncResult.uploaded}`);

        stats = db.getTieredStorageStats();
        assert(stats.dirtyKeysCount === 0, `expected 0 dirty keys after sync, got ${stats.dirtyKeysCount}`);
        assert(stats.syncedKeysCount === 10, `expected 10 synced keys, got ${stats.syncedKeysCount}`);
        assert(mockS3.putCalls === 10, `expected 10 putCalls to S3, got ${mockS3.putCalls}`);

        await db.destroyAsync();
    });

    // ─────────────────────────────────────────────────────────────────
    // Test 4: Write-Through Mode
    // ─────────────────────────────────────────────────────────────────
    await test('Write-Through Mode: commits synchronously to cloud bucket', async () => {
        cleanup();
        const mockS3 = new MockS3Client();

        const db = new Tero({
            directory: TEST_DIR,
            tieredStorage: {
                enabled: true,
                cloudStorage: {
                    provider: 'aws-s3',
                    bucket: 'test-bucket',
                    region: 'us-east-1',
                    accessKeyId: 'mock',
                    secretAccessKey: 'mock',
                    dbName: 'TieredTestDB-4',
                },
                customS3Client: mockS3,
                writeThrough: true, // Write-through enabled!
            }
        });

        // Flush dirty writes to files during writeThrough commit
        await db.create('sync_key', { verified: true });
        db.forceCheckpoint();
        await db.syncToCloud();

        // Object is already in mock S3
        assert(mockS3.store.has('tero-backups/TieredTestDB-4/sync_key.json'), 'object should exist in S3');

        await db.destroyAsync();
    });

    // ─────────────────────────────────────────────────────────────────
    // Test 5: Evicted Document Update (Preserves DeepMerge Fields)
    // ─────────────────────────────────────────────────────────────────
    await test('Evicted Document Update: hydrates beforeImage from cloud to preserve fields', async () => {
        cleanup();
        const mockS3 = new MockS3Client();

        // Seed cloud with doc having fields { a: 1, b: 2 }
        mockS3.store.set('tero-backups/TieredTestDB-5/doc_merge.json', {
            body: JSON.stringify({ a: 1, b: 2 }),
            contentType: 'application/json',
        });

        const db = new Tero({
            directory: TEST_DIR,
            tieredStorage: {
                enabled: true,
                cloudStorage: {
                    provider: 'aws-s3',
                    bucket: 'test-bucket',
                    region: 'us-east-1',
                    accessKeyId: 'mock',
                    secretAccessKey: 'mock',
                    dbName: 'TieredTestDB-5',
                },
                customS3Client: mockS3,
            }
        });

        // doc_merge is not on local disk. An update with { b: 20, c: 30 } should
        // read-through to fetch { a: 1, b: 2 }, merging into { a: 1, b: 20, c: 30 }.
        await db.update('doc_merge', { b: 20, c: 30 });

        const updated = await db.get('doc_merge');
        assert(updated.a === 1, `expected a: 1 to be preserved, got ${updated.a}`);
        assert(updated.b === 20, `expected b: 20, got ${updated.b}`);
        assert(updated.c === 30, `expected c: 30, got ${updated.c}`);

        await db.destroyAsync();
    });

    // ─────────────────────────────────────────────────────────────────
    // Test 6: Safe LRU Eviction Under MaxLocalFiles
    // ─────────────────────────────────────────────────────────────────
    await test('Safe LRU Eviction: prunes cold files down to lowWatermark', async () => {
        cleanup();
        const mockS3 = new MockS3Client();

        const db = new Tero({
            directory: TEST_DIR,
            tieredStorage: {
                enabled: true,
                cloudStorage: {
                    provider: 'aws-s3',
                    bucket: 'test-bucket',
                    region: 'us-east-1',
                    accessKeyId: 'mock',
                    secretAccessKey: 'mock',
                    dbName: 'TieredTestDB-6',
                },
                customS3Client: mockS3,
                maxLocalFiles: 6,
                highWatermark: 0.8, // 6 * 0.8 = 4 (evict if >4 files)
                lowWatermark: 0.4,  // 6 * 0.4 = 2 (evict down to 2 files)
                syncIntervalMs: 0,
                evictionIntervalMs: 0,
            }
        });

        // Create 6 keys
        for (let i = 1; i <= 6; i++) {
            await db.create(`item_${i}`, { value: i });
            // Small sleep to ensure unique access timestamps
            await new Promise(r => setTimeout(r, 10));
        }

        // Checkpoint to disk and sync to cloud so they are eligible for eviction
        db.forceCheckpoint();
        await db.syncToCloud();

        // Touch item_5 and item_6 to make them the hottest
        await db.get('item_5');
        await db.get('item_6');

        // Current count is 6 (exceeds high threshold of 4). Trigger eviction!
        const evicted = db.evictLocalColdFiles();
        assert(evicted >= 3, `expected at least 3 evicted files, got ${evicted}`);

        const stats = db.getTieredStorageStats();
        assert(stats.localFilesCount <= 3, `expected local files count <= 3, got ${stats.localFilesCount}`);

        // Reading an evicted cold key (e.g. item_1) should still seamlessly work via cloud read-through!
        const rehydrated = await db.get('item_1');
        assert(rehydrated !== null, 'item_1 should not be null');
        assert(rehydrated.value === 1, `expected value 1, got ${rehydrated.value}`);

        await db.destroyAsync();
    });

    // ─────────────────────────────────────────────────────────────────
    // Test 7: Eviction Safety Invariants (Dirty keys never evicted)
    // ─────────────────────────────────────────────────────────────────
    await test('Eviction Safety Invariant: un-synced dirty keys are NEVER evicted', async () => {
        cleanup();
        const mockS3 = new MockS3Client();

        const db = new Tero({
            directory: TEST_DIR,
            tieredStorage: {
                enabled: true,
                cloudStorage: {
                    provider: 'aws-s3',
                    bucket: 'test-bucket',
                    region: 'us-east-1',
                    accessKeyId: 'mock',
                    secretAccessKey: 'mock',
                    dbName: 'TieredTestDB-7',
                },
                customS3Client: mockS3,
                maxLocalFiles: 2,
                highWatermark: 0.5,
                lowWatermark: 0.2,
                syncIntervalMs: 0,
                evictionIntervalMs: 0,
            }
        });

        // Create 3 keys WITHOUT syncing to cloud
        await db.create('unsynced_1', { data: 1 });
        await db.create('unsynced_2', { data: 2 });
        await db.create('unsynced_3', { data: 3 });

        // Trigger eviction attempt
        const evicted = db.evictLocalColdFiles();

        // None should be evicted because NONE are confirmed uploaded to cloud!
        assert(evicted === 0, `dirty files must never be evicted, evicted: ${evicted}`);

        await db.destroyAsync();
    });

    // ─────────────────────────────────────────────────────────────────
    // Test 8: Cloud Deletion Sync
    // ─────────────────────────────────────────────────────────────────
    await test('Cloud Deletion: removing document propagates delete to cloud bucket', async () => {
        cleanup();
        const mockS3 = new MockS3Client();

        const db = new Tero({
            directory: TEST_DIR,
            tieredStorage: {
                enabled: true,
                cloudStorage: {
                    provider: 'aws-s3',
                    bucket: 'test-bucket',
                    region: 'us-east-1',
                    accessKeyId: 'mock',
                    secretAccessKey: 'mock',
                    dbName: 'TieredTestDB-8',
                },
                customS3Client: mockS3,
                syncIntervalMs: 0,
            }
        });

        // Create key and sync to S3
        await db.create('delete_me', { temp: true });
        db.forceCheckpoint();
        await db.syncToCloud();

        assert(mockS3.store.has('tero-backups/TieredTestDB-8/delete_me.json'), 'key should exist in S3 before delete');

        // Remove key
        await db.remove('delete_me');

        // Sync deletions to cloud
        const delResult = await db.syncToCloud();
        assert(delResult.deleted === 1, `expected 1 deleted key in sync, got ${delResult.deleted}`);
        assert(!mockS3.store.has('tero-backups/TieredTestDB-8/delete_me.json'), 'key should be deleted from S3');

        // Subsequent get should return null, not resurrect from cloud
        const gone = await db.get('delete_me');
        assert(gone === null, 'deleted key should return null');

        await db.destroyAsync();
    });

    // ─────────────────────────────────────────────────────────────────
    // Test 9: Instant Startup with Zero Downloads (Gradual On-Demand Hydration)
    // ─────────────────────────────────────────────────────────────────
    await test('Instant Startup: Tero.create downloads NO files on startup, hydrating gradually on demand', async () => {
        cleanup();
        const mockS3 = new MockS3Client();

        // Seed 5 documents in cloud storage
        for (let i = 1; i <= 5; i++) {
            mockS3.store.set(`tero-backups/TieredTestDB-9/doc_${i}.json`, {
                body: JSON.stringify({ id: `doc_${i}`, content: `Hello ${i}` }),
                contentType: 'application/json',
            });
        }

        const startBoot = Date.now();
        // Boot database using Tero.create with hydrateOnStartup
        const db = await Tero.create({
            directory: TEST_DIR,
            hydrateOnStartup: {
                cloudStorage: {
                    provider: 'aws-s3',
                    bucket: 'test-bucket',
                    region: 'us-east-1',
                    accessKeyId: 'mock',
                    secretAccessKey: 'mock',
                    dbName: 'TieredTestDB-9',
                },
                customS3Client: mockS3,
                mode: 'gradual', // or default
            },
        });
        const bootTimeMs = Date.now() - startBoot;

        // Startup must be instant and download ZERO files
        assert(bootTimeMs < 100, `startup took ${bootTimeMs}ms, expected instant (<100ms)`);
        assert(mockS3.getCalls === 0, `expected 0 S3 get calls on startup, got ${mockS3.getCalls}`);

        // Initially, zero files are in tiered storage local files count
        const initialStats = db.getTieredStorageStats();
        assert(initialStats.localFilesCount === 0, `expected 0 local files at boot, got ${initialStats.localFilesCount}`);

        // Gradual Hydration: Request doc_1
        const doc1 = await db.get('doc_1');
        assert(doc1 !== null, 'doc_1 should be hydrated');
        assert(doc1.id === 'doc_1', 'doc_1 content should match');
        assert(mockS3.getCalls === 1, `expected 1 getCall after requesting doc_1, got ${mockS3.getCalls}`);

        // Unrequested docs (doc_2 to doc_5) must NOT have been downloaded
        const afterDoc1Stats = db.getTieredStorageStats();
        assert(afterDoc1Stats.localFilesCount === 1, `only requested doc should be local, got ${afterDoc1Stats.localFilesCount}`);

        // Request doc_3
        const doc3 = await db.get('doc_3');
        assert(doc3.id === 'doc_3', 'doc_3 content should match');
        assert(mockS3.getCalls === 2, `expected 2 getCalls after requesting doc_3, got ${mockS3.getCalls}`);

        const afterDoc3Stats = db.getTieredStorageStats();
        assert(afterDoc3Stats.localFilesCount === 2, `expected 2 local files, got ${afterDoc3Stats.localFilesCount}`);

        await db.close();
    });

    cleanup();

    console.log(`\n========================================`);
    console.log(`Results: ${pass} passed, ${fail} failed`);
    console.log(`========================================\n`);

    if (fail > 0) {
        console.error('Failures:');
        for (const f of failures) {
            console.error(`- ${f.name}: ${f.error}\n${f.stack}`);
        }
        process.exit(1);
    }
}

runTieredTests().catch((err) => {
    console.error('Tiered tests crashed:', err);
    process.exit(1);
});
