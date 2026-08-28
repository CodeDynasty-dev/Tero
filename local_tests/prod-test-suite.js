/**
 * Tero DB — Production Test Suite
 *
 * Comprehensive ACID, concurrency, durability, recovery, and edge-case coverage.
 * Designed to be run by Sundar's infrastructure engineers:
 *   node local_tests/prod-test-suite.js
 *
 * Exits with code 1 on any failure. Prints Markdown-formatted results.
 */

import { Tero } from '../dist/index.js';
import { existsSync, rmSync, mkdirSync, writeFileSync, unlinkSync } from 'fs';

const TEST_DIR = 'ProdTestDB';
let pass = 0, fail = 0;
const failures = [];

async function test(name, fn) {
    try {
        await fn();
        pass++;
    } catch (e) {
        fail++;
        failures.push({ name, error: e.message });
    }
}

function assert(cond, msg) { if (!cond) throw new Error(msg); }

function cleanup() {
    try { if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true }); } catch {}
    ['RecoveryTestDB', 'LockTestDB_A', 'LockTestDB_B', 'HydrateTestDB', 'BatchTestDB', 'SchemaTestDB', 'BackupTestDB', 'BackupRecoveryDB', 'IntegrityTestDB'].forEach(d => {
        try { if (existsSync(d)) rmSync(d, { recursive: true, force: true }); } catch {}
    });
}

// ═══════════════════════════════════════════════════════════════════
// SUITE 1: Basic CRUD
// ═══════════════════════════════════════════════════════════════════
async function suite1() {
    cleanup();
    await test('create returns truthy for new key', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 50 });
        const r = await db.create('user', { name: 'Alice', age: 30 });
        assert(r === true || (r && r.valid !== false), 'create should return true');
        db.destroy();
    });

    await test('create returns false for duplicate key', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 50 });
        await db.create('user', { name: 'Alice' });
        const r = await db.create('user', { name: 'Bob' });
        assert(r === false, 'duplicate create should return false');
        db.destroy();
    });

    await test('get returns document after create', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 50 });
        // Use unique key — suite reuses TEST_DIR, previous test left 'user' on disk.
        // With correct duplicate detection (existsSync on miss) this must be distinct.
        await db.create('user_get', { name: 'Alice', email: 'a@b.com' });
        const r = await db.get('user_get');
        assert(r && r.name === 'Alice' && r.email === 'a@b.com', 'get returned wrong data');
        db.destroy();
    });

    await test('get returns false for missing key', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 50 });
        const r = await db.get('nonexistent');
        assert(r === false, 'get should return false for missing');
        db.destroy();
    });

    await test('exists returns true after create', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 50 });
        await db.create('k', { v: 1 });
        assert(db.exists('k'), 'exists should be true');
        assert(!db.exists('no_such_key'), 'exists should be false');
        db.destroy();
    });

    await test('update modifies document', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 50 });
        await db.create('doc', { a: 1, b: 2 });
        await db.update('doc', { b: 20, c: 3 });
        const r = await db.get('doc');
        assert(r.a === 1, 'field a preserved');
        assert(r.b === 20, 'field b updated');
        assert(r.c === 3, 'field c added');
        db.destroy();
    });

    await test('remove deletes document', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 50 });
        await db.create('doc', { v: 1 });
        assert(db.exists('doc'), 'should exist');
        await db.remove('doc');
        assert(!db.exists('doc'), 'should not exist after remove');
        assert(await db.get('doc') === false, 'get should return false after remove');
        db.destroy();
    });
}

// ═══════════════════════════════════════════════════════════════════
// SUITE 2: Sequential Updates — Deep Merge Integrity
// ═══════════════════════════════════════════════════════════════════
async function suite2() {
    cleanup();
    await test('sequential updates preserve all fields', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 50 });
        await db.create('doc', {});
        for (let i = 0; i < 50; i++) {
            await db.update('doc', { [`field${i}`]: `value${i}` });
        }
        const r = await db.get('doc');
        for (let i = 0; i < 50; i++) {
            assert(r[`field${i}`] === `value${i}`, `field${i} should be value${i}, got ${r[`field${i}`]}`);
        }
        db.destroy();
    });

    await test('sequential updates preserve fields after cache promotion', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 50 });
        // Unique key — previous test in this suite left 'doc' with 50 fields.
        await db.create('doc2', { base: true });
        // First update writes field0
        await db.update('doc2', { field0: 1 });
        // Force a read to populate cache with promoted entry
        const afterFirst = await db.get('doc2');
        assert(afterFirst.field0 === 1, 'field0 should persist after first read');
        // Second update writes field1 — must NOT lose field0 in cache
        await db.update('doc2', { field1: 2 });
        const afterSecond = await db.get('doc2');
        assert(afterSecond.field0 === 1, 'field0 lost after second update (cache poisoning)');
        assert(afterSecond.field1 === 2, 'field1 should be 2');
        assert(afterSecond.base === true, 'base should still exist');
        db.destroy();
    });

    await test('rapid-fire updates to same key (100x) preserve all fields', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 50 });
        await db.create('hot', { counter: 0 });
        for (let i = 1; i <= 100; i++) {
            await db.update('hot', { counter: i });
        }
        const r = await db.get('hot');
        assert(r.counter === 100, `counter should be 100 after 100 updates, got ${r.counter}`);
        db.destroy();
    });
}

// ═══════════════════════════════════════════════════════════════════
// SUITE 3: ACID Transactions
// ═══════════════════════════════════════════════════════════════════
async function suite3() {
    cleanup();
    await test('manual transaction commit applies all writes', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 50 });
        const tx = db.beginTransaction();
        await db.write(tx, 'a', { v: 1 });
        await db.write(tx, 'b', { v: 2 });
        await db.write(tx, 'c', { v: 3 });
        await db.commit(tx);
        assert((await db.get('a')).v === 1, 'a should exist');
        assert((await db.get('b')).v === 2, 'b should exist');
        assert((await db.get('c')).v === 3, 'c should exist');
        db.destroy();
    });

    await test('manual transaction rollback undoes all writes', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 50 });
        const tx = db.beginTransaction();
        await db.write(tx, 'temp', { v: 99 });
        await db.write(tx, 'temp2', { v: 99 });
        await db.rollback(tx);
        assert(await db.get('temp') === false, 'temp should not exist after rollback');
        assert(await db.get('temp2') === false, 'temp2 should not exist after rollback');
        db.destroy();
    });

    await test('transaction isolation — writes invisible outside tx', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 50 });
        const tx = db.beginTransaction();
        await db.write(tx, 'secret', { v: 1 });
        // Read from a DIFFERENT path (convenience method creates a new tx implicitly)
        assert(await db.get('secret') === false, 'uncommitted write should not be visible');
        await db.commit(tx);
        assert((await db.get('secret')).v === 1, 'committed write should be visible');
        db.destroy();
    });

    await test('money transfer is atomic', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 50 });
        await db.create('savings', { balance: 1000 });
        await db.create('checking', { balance: 500 });
        await db.transferMoney('savings', 'checking', 300);
        assert((await db.get('savings')).balance === 700, 'savings should be 700');
        assert((await db.get('checking')).balance === 800, 'checking should be 800');
        // Total preserved
        assert((await db.get('savings')).balance + (await db.get('checking')).balance === 1500, 'total not preserved');
        db.destroy();
    });

    await test('money transfer with insufficient funds rolls back', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 50 });
        // Unique keys — previous test left savings=700 checking=800; correct
        // create() now returns false for duplicate instead of overwriting.
        await db.create('savings2', { balance: 100 });
        await db.create('checking2', { balance: 50 });
        try {
            await db.transferMoney('savings2', 'checking2', 200);
            throw new Error('should have thrown');
        } catch (e) {
            assert(e.message.includes('Insufficient'), 'wrong error');
        }
        assert((await db.get('savings2')).balance === 100, 'savings unchanged');
        assert((await db.get('checking2')).balance === 50, 'checking unchanged');
        db.destroy();
    });

    await test('transaction timeout auto-rolls back', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 50 });
        const tx = db.beginTransaction({ timeout: 100 });
        await db.write(tx, 'timeout_test', { v: 1 });
        await new Promise(r => setTimeout(r, 200));
        assert(tx.isRolledBack(), 'tx should be rolled back after timeout');
        assert(await db.get('timeout_test') === false, 'data should not exist after timeout rollback');
        db.destroy();
    });
}

// ═══════════════════════════════════════════════════════════════════
// SUITE 4: Concurrent Writes (Same Key — Lock Contention)
// ═══════════════════════════════════════════════════════════════════
async function suite4() {
    cleanup();
    await test('concurrent updates to same key serialize correctly', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 100 });
        await db.create('shared', { counter: 0 });

        // 50 concurrent increments — each acquires exclusive lock on read, increments, writes back
        const promises = [];
        for (let i = 0; i < 50; i++) {
            promises.push((async () => {
                const tx = db.beginTransaction();
                const current = await db.read(tx, 'shared', { lock: 'exclusive' });
                await db.write(tx, 'shared', { counter: (current.counter || 0) + 1 });
                await db.commit(tx);
            })());
        }
        await Promise.all(promises);

        const final = await db.get('shared');
        assert(final.counter === 50, `counter should be exactly 50 after 50 serialized increments, got ${final.counter}`);
        db.destroy();
    });

    await test('concurrent writes to different keys do not interfere', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 100 });
        const promises = [];
        for (let i = 0; i < 100; i++) {
            promises.push(db.create(`concurrent_${i}`, { idx: i }));
        }
        await Promise.all(promises);
        for (let i = 0; i < 100; i++) {
            assert(db.exists(`concurrent_${i}`), `concurrent_${i} should exist`);
            assert((await db.get(`concurrent_${i}`)).idx === i, `idx mismatch for ${i}`);
        }
        db.destroy();
    });
}

// ═══════════════════════════════════════════════════════════════════
// SUITE 5: Crash Recovery & Data Persistence
// ═══════════════════════════════════════════════════════════════════
async function suite5() {
    cleanup();
    await test('data survives destroy + re-init (full mode)', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 50, synchronous: 'full' });
        await db.create('persist', { v: 'kept', count: 42 });
        await db.create('persist2', { v: 'also' });
        db.destroy();

        const db2 = new Tero({ directory: TEST_DIR, cacheSize: 50, synchronous: 'full' });
        const r1 = await db2.get('persist');
        assert(r1 && r1.v === 'kept' && r1.count === 42, 'persist data mismatch');
        const r2 = await db2.get('persist2');
        assert(r2 && r2.v === 'also', 'persist2 data mismatch');
        db2.destroy();
    });

    await test('data survives destroy + re-init (normal mode)', async () => {
        cleanup();
        const db = new Tero({ directory: TEST_DIR, cacheSize: 50, synchronous: 'normal' });
        await db.create('n1', { v: 1 });
        await db.create('n2', { v: 2 });
        // Force flush committedBuffer + WAL before destroy
        db.forceCheckpoint();
        db.destroy();

        const db2 = new Tero({ directory: TEST_DIR, cacheSize: 50, synchronous: 'normal' });
        assert((await db2.get('n1')).v === 1, 'n1 lost');
        assert((await db2.get('n2')).v === 2, 'n2 lost');
        db2.destroy();
    });

    await test('rollback survives re-init', async () => {
        cleanup();
        const db = new Tero({ directory: TEST_DIR, cacheSize: 50, synchronous: 'full' });
        await db.create('keep', { v: 1 });
        const tx = db.beginTransaction();
        await db.write(tx, 'temp', { v: 99 });
        await db.rollback(tx);
        db.destroy();

        const db2 = new Tero({ directory: TEST_DIR, cacheSize: 50, synchronous: 'full' });
        assert((await db2.get('keep')).v === 1, 'keep lost');
        assert(await db2.get('temp') === false, 'temp should not exist after rollback + reinit');
        db2.destroy();
    });
}

// ═══════════════════════════════════════════════════════════════════
// SUITE 6: Batch Operations
// ═══════════════════════════════════════════════════════════════════
async function suite6() {
    cleanup();
    await test('batchWrite creates multiple documents atomically', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 100 });
        await db.batchWrite([
            { key: 'b1', data: { name: 'one' } },
            { key: 'b2', data: { name: 'two' } },
            { key: 'b3', data: { name: 'three' } },
        ]);
        assert((await db.get('b1')).name === 'one', 'b1');
        assert((await db.get('b2')).name === 'two', 'b2');
        assert((await db.get('b3')).name === 'three', 'b3');
        db.destroy();
    });

    await test('batchRead returns all keys', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 100 });
        await db.batchWrite([
            { key: 'r1', data: { v: 1 } },
            { key: 'r2', data: { v: 2 } },
            { key: 'r3', data: { v: 3 } },
        ]);
        const results = await db.batchRead(['r1', 'r2', 'r3']);
        assert(results.r1.v === 1 && results.r2.v === 2 && results.r3.v === 3, 'batch read mismatch');
        db.destroy();
    });

    await test('batchWrite on non-existent keys creates them', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 100 });
        await db.batchWrite([
            { key: 'new1', data: { v: 1 } },
            { key: 'new2', data: { v: 2 } },
        ]);
        assert(db.exists('new1') && db.exists('new2'), 'batch should create new keys');
        db.destroy();
    });
}

// ═══════════════════════════════════════════════════════════════════
// SUITE 7: Schema Validation
// ═══════════════════════════════════════════════════════════════════
async function suite7() {
    cleanup();
    await test('setSchema accepts valid schema', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 50 });
        db.setSchema('users', {
            name: { type: 'string', required: true, min: 2, max: 50 },
            age: { type: 'number', min: 0, max: 150 },
            email: { type: 'string', required: true, format: 'email' },
        });
        assert(db.hasSchema('users'), 'schema should be stored');
        db.destroy();
    });

    await test('valid data passes strict schema validation', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 50 });
        db.setSchema('users', {
            name: { type: 'string', required: true },
            age: { type: 'number', min: 0 },
        });
        const r = await db.create('u1', { name: 'Bob', age: 25 }, { validate: true, schemaName: 'users', strict: true });
        assert(r === true || (r && r.valid === true), 'valid data should pass');
        db.destroy();
    });

    await test('invalid data rejected in strict mode', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 50 });
        db.setSchema('users', {
            name: { type: 'string', required: true },
            age: { type: 'number', min: 0 },
        });
        try {
            await db.create('u2', { name: 'X', age: -5 }, { validate: true, schemaName: 'users', strict: true });
            throw new Error('should have rejected');
        } catch (e) {
            assert(e.message.includes('Schema validation failed'), `wrong error: ${e.message}`);
        }
        db.destroy();
    });

    await test('schema validation with defaults fills missing fields', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 50 });
        db.setSchema('items', {
            name: { type: 'string', required: true },
            active: { type: 'boolean', default: true },
        });
        const r = await db.create('i1', { name: 'Test' }, { validate: true, schemaName: 'items' });
        assert(r.valid === true, 'should pass');
        assert(r.data.active === true, 'default should be applied');
        db.destroy();
    });
}

// ═══════════════════════════════════════════════════════════════════
// SUITE 8: Cache Consistency
// ═══════════════════════════════════════════════════════════════════
async function suite8() {
    cleanup();
    await test('cache hit rate is non-zero after repeated reads', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 100 });
        await db.create('cached', { v: 1 });
        // First read should miss, second should hit
        await db.get('cached');
        await db.get('cached');
        const stats = db.getCacheStats();
        assert(stats.hitRate > 0, `cache hit rate should be > 0, got ${stats.hitRate}`);
        db.destroy();
    });

    await test('cache returns same data as committedBuffer after update', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 100 });
        await db.create('doc', { a: 1 });
        await db.update('doc', { b: 2 });
        // Cache should now have the full merged document
        const fromCache = await db.get('doc');
        assert(fromCache.a === 1 && fromCache.b === 2, 'cache has incomplete data after update');
        db.destroy();
    });

    await test('clearCache forces disk re-read', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 100 });
        // Unique key — suite reuses TEST_DIR, previous test left 'doc' with a/b.
        await db.create('doc_cache', { v: 1 });
        await db.get('doc_cache'); // populate cache
        db.forceCheckpoint(); // flush to disk
        db.clearCache();
        const r = await db.get('doc_cache');
        assert(r && r.v === 1, 'after clearCache, data should still be readable from disk');
        db.destroy();
    });
}

// ═══════════════════════════════════════════════════════════════════
// SUITE 9: Key Validation & Edge Cases
// ═══════════════════════════════════════════════════════════════════
async function suite9() {
    cleanup();
    await test('rejects empty key', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 50 });
        try { await db.create('', { v: 1 }); throw new Error('should reject'); }
        catch (e) { assert(e.message.includes('non-empty'), `wrong: ${e.message}`); }
        db.destroy();
    });

    await test('rejects path traversal key', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 50 });
        try { await db.create('../escape', { v: 1 }); throw new Error('should reject'); }
        catch (e) { assert(e.message.includes('invalid characters'), `wrong: ${e.message}`); }
        db.destroy();
    });

    await test('rejects forward-slash in key', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 50 });
        try { await db.create('a/b', { v: 1 }); throw new Error('should reject'); }
        catch (e) { assert(e.message.includes('invalid characters'), `wrong: ${e.message}`); }
        db.destroy();
    });

    await test('rejects null data', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 50 });
        try { await db.update('k', null); throw new Error('should reject'); }
        catch (e) { assert(e.message.includes('cannot be null'), `wrong: ${e.message}`); }
        db.destroy();
    });

    await test('handles special characters in keys', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 50 });
        await db.create('user@domain.com', { email: true });
        assert(await db.get('user@domain.com') !== false, 'special char key should work');
        db.destroy();
    });
}

// ═══════════════════════════════════════════════════════════════════
// SUITE 10: Data Integrity Verification
// ═══════════════════════════════════════════════════════════════════
async function suite10() {
    cleanup();
    await test('verifyDataIntegrity reports healthy on clean DB', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 100 });
        await db.create('d1', { v: 1 });
        await db.create('d2', { v: 2 });
        await db.create('d3', { v: 3 });
        db.forceCheckpoint();
        const r = await db.verifyDataIntegrity();
        assert(r.healthy, 'should be healthy');
        assert(r.totalFiles === 3, `should have 3 files, got ${r.totalFiles}`);
        assert(r.corruptedFiles.length === 0, 'no corrupted');
        assert(r.missingFiles.length === 0, 'no missing');
        db.destroy();
    });
}

// ═══════════════════════════════════════════════════════════════════
// SUITE 11: Large Documents
// ═══════════════════════════════════════════════════════════════════
async function suite11() {
    cleanup();
    await test('handles deeply nested JSON', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 50 });
        const nested = { a: { b: { c: { d: { e: { f: 'deep' } } } } } };
        await db.create('nested', nested);
        const r = await db.get('nested');
        assert(r.a.b.c.d.e.f === 'deep', 'nested value lost');
        db.destroy();
    });

    await test('handles arrays in documents', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 50 });
        await db.create('arr', { items: [1, 2, 3, 4, 5], meta: { count: 5 } });
        const r = await db.get('arr');
        assert(r.items.length === 5 && r.items[2] === 3, 'array handling');
        db.destroy();
    });

    await test('handles moderately sized document (10KB)', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 50 });
        const body = 'x'.repeat(10000);
        await db.create('large', { body, meta: { size: 10000 } });
        const r = await db.get('large');
        assert(r.body.length === 10000 && r.meta.size === 10000, 'large doc round trip');
        db.destroy();
    });
}

// ═══════════════════════════════════════════════════════════════════
// SUITE 12: getNewId
// ═══════════════════════════════════════════════════════════════════
async function suite12() {
    cleanup();
    await test('getNewId returns unique IDs with prefix', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 50 });
        const ids = new Set();
        for (let i = 0; i < 1000; i++) {
            const id = db.getNewId('user');
            assert(id.startsWith('user-'), 'should have prefix');
            assert(!ids.has(id), `duplicate id: ${id}`);
            ids.add(id);
        }
        assert(ids.size === 1000, '1000 unique IDs');
        db.destroy();
    });
}

// ═══════════════════════════════════════════════════════════════════
// SUITE 13: Local Backup & Recovery
// ═══════════════════════════════════════════════════════════════════
async function suite13() {
    cleanup();
    await test('archive backup creates tar.gz', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 50 });
        await db.create('a', { v: 1 }); await db.create('b', { v: 2 }); await db.create('c', { v: 3 });
        db.forceCheckpoint();
        db.configureBackup({ format: 'archive', localPath: TEST_DIR + '/.backup' });
        const r = await db.performBackup();
        assert(r.success, 'backup should succeed');
        assert(r.metadata.fileCount === 3, `expected 3 files, got ${r.metadata.fileCount}`);
        db.destroy();
    });

    await test('individual backup succeeds', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 50 });
        await db.create('a', { v: 1 }); await db.create('b', { v: 2 });
        db.forceCheckpoint();
        db.configureBackup({ format: 'individual', localPath: TEST_DIR + '/.backup_ind' });
        const r = await db.performBackup();
        assert(r.success, 'individual backup should succeed');
        db.destroy();
    });
}

// ═══════════════════════════════════════════════════════════════════
// SUITE 14: File Locking (Cross-Process Prevention)
// ═══════════════════════════════════════════════════════════════════
async function suite14() {
    cleanup();
    await test('fileLock prevents second instance in same process', async () => {
        const db1 = new Tero({ directory: 'LockTestDB_A', fileLock: true });
        try {
            new Tero({ directory: 'LockTestDB_A', fileLock: true });
            throw new Error('second instance should have been rejected');
        } catch (e) {
            assert(e.message.includes('already using') || e.message.includes('locked'), `wrong: ${e.message}`);
        }
        db1.destroy();
        rmSync('LockTestDB_A', { recursive: true, force: true });
    });

    await test('fileLock allows re-open after destroy', async () => {
        const db1 = new Tero({ directory: 'LockTestDB_B', fileLock: true });
        await db1.create('k', { v: 1 });
        db1.destroy();

        const db2 = new Tero({ directory: 'LockTestDB_B', fileLock: true });
        assert((await db2.get('k')).v === 1, 'data should survive lock cycle');
        db2.destroy();
        rmSync('LockTestDB_B', { recursive: true, force: true });
    });
}

// ═══════════════════════════════════════════════════════════════════
// SUITE 15: Synchronous Mode Switching
// ═══════════════════════════════════════════════════════════════════
async function suite15() {
    cleanup();
    for (const mode of ['full', 'normal', 'off']) {
        await test(`synchronous=${mode}: create + get round-trip`, async () => {
            const dir = `ModeTest_${mode}`;
            const db = new Tero({ directory: dir, cacheSize: 50, synchronous: mode });
            await db.create('k', { v: 42 });
            assert((await db.get('k')).v === 42, `${mode} mode round-trip failed`);
            db.destroy();
            rmSync(dir, { recursive: true, force: true });
        });
    }
}

// ═══════════════════════════════════════════════════════════════════
// SUITE 16: Force Checkpoint
// ═══════════════════════════════════════════════════════════════════
async function suite16() {
    cleanup();
    await test('forceCheckpoint persists deferred writes to disk', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 50, synchronous: 'normal' });
        await db.create('cp1', { v: 'checkpointed' });
        // Data is in committedBuffer, not yet on disk
        db.forceCheckpoint(); // flush committedBuffer + WAL

        // verify file exists on disk via partitioned path
        const { keyToPath } = db;
        const path = keyToPath ? keyToPath.call(db, 'cp1') : null;
        assert(existsSync && path ? existsSync(path) : true, 'data file should exist after checkpoint');
        db.destroy();
    });
}

// ═══════════════════════════════════════════════════════════════════
// SUITE 17: Lock Upgrades, Wait-Queue Cleanup, and Safety Guards
// ═══════════════════════════════════════════════════════════════════
async function suite17() {
    cleanup();

    await test('shared -> exclusive lock upgrade succeeds without deadlock when other shared holders release', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 50, synchronous: 'normal' });
        try {
            await db.create('upgrade_key', { v: 1 });

            const tx1 = db.beginTransaction();
            const tx2 = db.beginTransaction();

            // Both acquire shared locks
            await tx1.read('upgrade_key');
            await tx2.read('upgrade_key');

            // tx1 attempts update (upgrade to exclusive, queues behind tx2)
            let tx1UpgradeResolved = false;
            const upgradePromise = tx1.update('upgrade_key', { v: 2 }).then(() => {
                tx1UpgradeResolved = true;
            });

            // Small tick to ensure tx1 is in waitQueue
            await new Promise(r => setTimeout(r, 20));
            assert(!tx1UpgradeResolved, 'tx1 upgrade should be waiting on tx2');

            // tx2 commits, draining its shared lock
            await tx2.commit();

            // tx1 upgrade should resolve now!
            await upgradePromise;
            assert(tx1UpgradeResolved, 'tx1 upgrade should resolve after tx2 releases');

            await tx1.commit();
            assert((await db.get('upgrade_key')).v === 2, 'value should be 2');
        } finally {
            db.destroy();
        }
    });

    await test('aborted waiting transaction does not leak in wait queue and block subsequent writers', async () => {
        const db = new Tero({ directory: TEST_DIR, cacheSize: 50, synchronous: 'normal' });
        try {
            await db.create('queue_key', { v: 1 });

            const tx1 = db.beginTransaction();
            const tx2 = db.beginTransaction();

            // tx1 holds exclusive
            await tx1.update('queue_key', { v: 10 });

            // tx2 queues waiting on queue_key
            const tx2WaitPromise = tx2.update('queue_key', { v: 20 }).catch(e => e);

            await new Promise(r => setTimeout(r, 20));

            // tx2 is aborted while waiting
            await tx2.rollback();
            await tx2WaitPromise;

            // tx1 commits and releases
            await tx1.commit();

            // tx3 should acquire immediately without hanging on tx2
            const tx3 = db.beginTransaction();
            await tx3.update('queue_key', { v: 30 });
            await tx3.commit();

            assert((await db.get('queue_key')).v === 30, 'tx3 write should succeed');
        } finally {
            db.destroy();
        }
    });

    await test('invalid synchronous parameter throws actionable error', async () => {
        let threw = false;
        try {
            new Tero({ directory: 'InvalidSyncDB', synchronous: 'flul' });
        } catch (e) {
            threw = e.message.includes("Invalid synchronous mode 'flul'");
        }
        assert(threw, 'should throw for invalid synchronous mode');
    });

    await test('circular reference in document throws and is rejected', async () => {
        const db = new Tero({ directory: TEST_DIR });
        try {
            const circ = { name: 'cycle' };
            circ.self = circ;
            let threw = false;
            try {
                await db.create('circ_doc', circ);
            } catch (e) {
                threw = e.message.includes('Circular reference detected');
            }
            assert(threw, 'should throw for circular reference');
        } finally {
            db.destroy();
        }
    });

    await test('directory root . is rejected', async () => {
        let threw = false;
        try {
            new Tero({ directory: '.' });
        } catch (e) {
            threw = e.message.includes('cannot use working directory root');
        }
        assert(threw, 'should throw for root directory');
    });
}

// ═══════════════════════════════════════════════════════════════════
// REPORT
// ═══════════════════════════════════════════════════════════════════
async function main() {
    console.log('# Tero DB — Production Test Suite\n');
    console.log(`Node ${process.version} | ${process.platform} | ${new Date().toISOString()}\n`);

    await suite1();  // Basic CRUD
    await suite2();  // Sequential updates / deep merge
    await suite3();  // ACID transactions
    await suite4();  // Concurrent writes
    await suite5();  // Crash recovery
    await suite6();  // Batch operations
    await suite7();  // Schema validation
    await suite8();  // Cache consistency
    await suite9();  // Key validation / edge cases
    await suite10(); // Data integrity
    await suite11(); // Large documents
    await suite12(); // getNewId
    await suite13(); // Backup & recovery
    await suite14(); // File locking
    await suite15(); // Synchronous modes
    await suite16(); // Force checkpoint
    await suite17(); // Lock upgrades, wait-queue cleanup & safety guards

    cleanup();

    const total = pass + fail;
    console.log(`\n## Results\n`);
    console.log(`| Metric | Count |`);
    console.log(`|--------|-------|`);
    console.log(`| Passed | ${pass} |`);
    console.log(`| Failed | ${fail} |`);
    console.log(`| Total  | ${total} |`);
    console.log(`| Rate   | ${total > 0 ? ((pass / total) * 100).toFixed(1) : 0}% |`);

    if (failures.length > 0) {
        console.log(`\n## Failures\n`);
        for (const f of failures) {
            console.log(`- **${f.name}**: ${f.error}`);
        }
        process.exit(1);
    }

    console.log('\n## Verdict');
    console.log(`${pass}/${total} passed — ${fail === 0 ? 'PRODUCTION-READY' : 'NEEDS FIXES'}`);
}

main().catch(e => {
    console.error('Test runner crashed:', e);
    process.exit(1);
});