import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { resolve, join } from 'path';
import { Tero } from '../dist/index.js';
import { ACIDStorageEngine, partitionedPath } from '../dist/acid-engine.js';
import { DataRecovery } from '../dist/recovery.js';
import { BackupManager } from '../dist/backup.js';

test('Issue 5: Compact JSON persistence on disk', async () => {
  const testDir = resolve('./test_issue5_compact_db');
  rmSync(testDir, { recursive: true, force: true });
  const db = new Tero({ directory: testDir, synchronous: 'full' });

  try {
    await db.create('doc1', { name: 'Bob', nested: { a: 1, b: 2 } });
    await db.forceCheckpoint();

    const filePath = partitionedPath(testDir, 'doc1');
    assert.equal(existsSync(filePath), true);
    const content = readFileSync(filePath, 'utf8');

    // Verify it is NOT pretty-printed with newlines
    assert.equal(content.includes('\n  '), false, 'persisted JSON should be compact without multi-line indentation');
    assert.equal(content, JSON.stringify({ name: 'Bob', nested: { a: 1, b: 2 } }));
  } finally {
    db.destroy();
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('Issues 10 & 11: Immediate deadlock detection on shared-to-exclusive upgrades and cycle detection', async () => {
  const testDir = resolve('./test_issue10_deadlock_db');
  rmSync(testDir, { recursive: true, force: true });
  const db = new Tero({ directory: testDir });

  try {
    await db.create('item', { count: 0 });

    const tx1 = db.beginTransaction();
    const tx2 = db.beginTransaction();

    // Both acquire shared lock on 'item'
    await tx1.get('item', { lock: 'shared' });
    await tx2.get('item', { lock: 'shared' });

    // Now both try to upgrade to exclusive.
    // With wait-for graph / upgrade deadlock detection, tx2 detects deadlock immediately!
    const start = Date.now();
    let deadlockCaught = false;

    const p1 = tx1.update('item', { count: 1 });
    try {
      await tx2.update('item', { count: 2 });
    } catch (e) {
      if (e.message.includes('Deadlock detected')) {
        deadlockCaught = true;
        // Application rolls back the deadlocked transaction, releasing its shared lock
        await db.rollbackTransaction(tx2);
      }
    }

    // Now that tx2 released its shared lock, p1 completes without waiting 30s
    await p1;
    await db.commitTransaction(tx1);
    const duration = Date.now() - start;

    assert.equal(deadlockCaught, true, 'Immediate deadlock must be detected on mutual lock upgrade');
    assert.ok(duration < 2000, `Deadlock abort and unblocking took ${duration}ms instead of 30s`);
  } finally {
    db.destroy();
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('Issues 2 & 8: Cloud delete propagation and incremental upload diffing in backup', async () => {
  const testDir = resolve('./test_issue2_backup_db');
  rmSync(testDir, { recursive: true, force: true });
  const db = new Tero({ directory: testDir });

  const s3Store = new Map();
  const deletedFromS3 = [];
  let putCount = 0;

  const mockS3 = {
    async send(command) {
      const name = command.constructor.name;
      if (name === 'ListObjectsV2Command') {
        const contents = Array.from(s3Store.entries()).map(([k, v]) => ({
          Key: k,
          Size: v.size,
          LastModified: v.mtime
        }));
        return { Contents: contents, IsTruncated: false };
      }
      if (name === 'PutObjectCommand') {
        putCount++;
        s3Store.set(command.input.Key, {
          size: command.input.Body.length,
          mtime: new Date()
        });
        return {};
      }
      if (name === 'DeleteObjectCommand') {
        deletedFromS3.push(command.input.Key);
        s3Store.delete(command.input.Key);
        return {};
      }
      return {};
    }
  };

  try {
    await db.create('doc_a', { a: 1 });
    await db.create('doc_b', { b: 2 });
    await db.forceCheckpoint();

    const bm = new BackupManager(testDir, {
      format: 'individual',
      cloudStorage: {
        bucket: 'test-bucket',
        region: 'us-east-1',
        accessKeyId: 'k',
        secretAccessKey: 's',
        pathPrefix: 'backups',
        dbName: 'testdb'
      }
    });
    bm.s3Client = mockS3;

    // First backup: uploads doc_a and doc_b
    const res1 = await bm.backupToBucket();
    assert.equal(res1.success, true);
    assert.equal(res1.uploadedDataFiles, 2);
    const putsAfterFirst = putCount;

    // Second backup without changes: should diff and skip uploading identical files (Issue 8)
    const res2 = await bm.backupToBucket();
    assert.equal(res2.success, true);
    assert.equal(res2.uploadedDataFiles, 0, 'Unchanged files should not be re-uploaded');

    // Now delete doc_b locally
    await db.delete('doc_b');
    await db.forceCheckpoint();

    // Third backup: doc_b was deleted locally, should propagate delete to S3 (Issue 2)
    const res3 = await bm.backupToBucket();
    assert.equal(res3.success, true);
    assert.ok(deletedFromS3.some(k => k.includes('doc_b')), 'Deleted local document must be deleted from cloud bucket');
  } finally {
    db.destroy();
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('Issues 3 & 7: Metadata exclusion and O(N) single-pass getRecoveryInfo', async () => {
  const testDir = resolve('./test_issue3_recovery_db');
  rmSync(testDir, { recursive: true, force: true });

  const mockS3 = {
    async send(command) {
      const name = command.constructor.name;
      if (name === 'ListObjectsV2Command') {
        return {
          Contents: [
            { Key: 'backups/testdb/doc_valid.json', Size: 20, LastModified: new Date() },
            { Key: 'backups/testdb/backup-metadata.json', Size: 100, LastModified: new Date() },
            { Key: 'backups/testdb/audit-metadata.json', Size: 100, LastModified: new Date() },
            { Key: 'backups/testdb/MANIFEST.json', Size: 50, LastModified: new Date() },
            { Key: 'backups/testdb/.DS_Store.json', Size: 10, LastModified: new Date() }
          ],
          IsTruncated: false
        };
      }
      return {};
    }
  };

  const recovery = new DataRecovery({
    localPath: testDir,
    cloudStorage: {
      bucket: 'test-bucket',
      region: 'us-east-1',
      accessKeyId: 'k',
      secretAccessKey: 's',
      pathPrefix: 'backups',
      dbName: 'testdb'
    },
    customS3Client: mockS3
  });

  // Issue 3: listAvailableFiles must filter out metadata and dotfiles
  const files = await recovery.listAvailableFiles();
  assert.deepEqual(files, ['doc_valid'], 'Metadata and hidden files must not be treated as documents');

  // Issue 7: getRecoveryInfo single-pass
  const info = await recovery.getRecoveryInfo();
  assert.equal(info.cloudFiles, 1);
  assert.equal(info.localFiles, 0);
  assert.deepEqual(info.missingLocally, ['doc_valid']);
});

test('Issue 4: Commit boundary and WAL logging', async () => {
  const testDir = resolve('./test_issue4_commit_boundary_db');
  rmSync(testDir, { recursive: true, force: true });
  const engine = new ACIDStorageEngine(testDir);

  try {
    const txId = engine.beginTransaction();
    engine.write(txId, 'k1', { val: 'first' });
    await engine.commitTransaction(txId);

    // After commitTransaction, status is committed
    assert.equal(engine.getTransactionStatus(txId), 'committed');

    // Cannot rollback an already committed transaction
    let threw = false;
    try {
      await engine.rollbackTransaction(txId);
    } catch (e) {
      threw = true;
    }
    assert.equal(threw, true, 'rolling back committed transaction must fail');
  } finally {
    engine.destroy();
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('Live Checkpoint: Burst > checkpointBatchSize writes without false tombstones', async () => {
  const testDir = resolve('./test_live_checkpoint_burst_db');
  rmSync(testDir, { recursive: true, force: true });
  const db = new Tero({ directory: testDir, checkpointBatchSize: 100 });

  const s3Store = new Map();
  const mockS3 = {
    async send(command) {
      const name = command.constructor.name;
      if (name === 'ListObjectsV2Command') {
        const prefix = command.input.Prefix || '';
        const contents = Array.from(s3Store.entries())
          .filter(([k]) => k.startsWith(prefix))
          .map(([k, v]) => ({
            Key: k,
            Size: v.size,
            LastModified: v.mtime,
            ETag: v.eTag,
          }));
        return { Contents: contents, IsTruncated: false };
      }
      if (name === 'PutObjectCommand') {
        const body = command.input.Body || Buffer.alloc(0);
        const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
        const md5 = createHash('md5').update(buf).digest('hex');
        s3Store.set(command.input.Key, {
          size: buf.length,
          mtime: new Date(),
          eTag: `"${md5}"`,
          data: buf,
        });
        return {};
      }
      if (name === 'GetObjectCommand') {
        const item = s3Store.get(command.input.Key);
        if (!item) {
          const err = new Error('NoSuchKey');
          err.name = 'NoSuchKey';
          throw err;
        }
        return {
          Body: {
            transformToString: async () => item.data.toString('utf8'),
            async *[Symbol.asyncIterator]() {
              yield item.data;
            }
          }
        };
      }
      if (name === 'DeleteObjectCommand') {
        s3Store.delete(command.input.Key);
        return {};
      }
      return {};
    }
  };

  try {
    db.configureBackup({
      cloudStorage: {
        bucket: 'test-bucket',
        region: 'us-east-1',
        accessKeyId: 'k',
        secretAccessKey: 's',
        pathPrefix: 'backups',
        dbName: 'burstdb',
      }
    });
    db.backupManager.s3Client = mockS3;
    db.enableLiveBackup({ consistency: 'per-second', intervalMs: 500 });

    // Initial full checkpoint
    await db.liveCheckpointToBucket();

    // Now burst 250 writes (well exceeding checkpointBatchSize=100)
    for (let i = 0; i < 250; i++) {
      await db.create(`burst_doc_${i}`, { idx: i, timestamp: Date.now() });
    }

    // Immediately trigger live checkpoint without manual forceCheckpoint
    const ckpt = await db.liveCheckpointToBucket();

    // Verify ZERO false tombstones were uploaded and all 250 documents are dirtyUploaded
    assert.equal(ckpt.tombstonedDocs, 0, 'No active dirty documents should be falsely tombstoned');
    assert.equal(ckpt.uploadedDocs, 250, 'All 250 dirty documents must be uploaded');

    // Confirm no .deleted objects exist for any burst_doc in S3 store
    const tombstones = Array.from(s3Store.keys()).filter(k => k.includes('burst_doc') && k.endsWith('.deleted'));
    assert.equal(tombstones.length, 0, 'No .deleted files should exist in S3 store');
  } finally {
    db.destroy();
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('Lazy Hydration: Remote cold files are NOT pruned during backupToBucket', async () => {
  const testDir = resolve('./test_lazy_hydration_backup_db');
  rmSync(testDir, { recursive: true, force: true });

  const s3Store = new Map();
  const deletedFromS3 = [];

  // Seed 5 documents in cloud storage
  for (let i = 1; i <= 5; i++) {
    const payload = Buffer.from(JSON.stringify({ id: i, name: `User ${i}` }));
    const md5 = createHash('md5').update(payload).digest('hex');
    s3Store.set(`backups/lazytest/doc_${i}.json`, {
      size: payload.length,
      mtime: new Date(),
      eTag: `"${md5}"`,
      data: payload,
    });
  }

  const mockS3 = {
    async send(command) {
      const name = command.constructor.name;
      if (name === 'ListObjectsV2Command') {
        const prefix = command.input.Prefix || '';
        const contents = Array.from(s3Store.entries())
          .filter(([k]) => k.startsWith(prefix))
          .map(([k, v]) => ({
            Key: k,
            Size: v.size,
            LastModified: v.mtime,
            ETag: v.eTag,
          }));
        return { Contents: contents, IsTruncated: false };
      }
      if (name === 'GetObjectCommand') {
        const item = s3Store.get(command.input.Key);
        if (!item) {
          const err = new Error('NoSuchKey');
          err.name = 'NoSuchKey';
          throw err;
        }
        return {
          Body: {
            transformToString: async () => item.data.toString('utf8'),
            async *[Symbol.asyncIterator]() {
              yield item.data;
            }
          }
        };
      }
      if (name === 'PutObjectCommand') {
        const body = command.input.Body || Buffer.alloc(0);
        const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
        const md5 = createHash('md5').update(buf).digest('hex');
        s3Store.set(command.input.Key, {
          size: buf.length,
          mtime: new Date(),
          eTag: `"${md5}"`,
          data: buf,
        });
        return {};
      }
      if (name === 'DeleteObjectCommand') {
        deletedFromS3.push(command.input.Key);
        s3Store.delete(command.input.Key);
        return {};
      }
      return {};
    }
  };

  const db = await Tero.create({
    directory: testDir,
    hydrateOnStartup: {
      cloudStorage: {
        bucket: 'test-bucket',
        region: 'us-east-1',
        accessKeyId: 'k',
        secretAccessKey: 's',
        pathPrefix: 'backups',
        dbName: 'lazytest',
      },
      mode: 'lazy',
      customS3Client: mockS3,
    }
  });

  try {
    // Read only doc_1 (leaves doc_2..doc_5 cold in cloud, absent locally)
    const doc1 = await db.get('doc_1');
    assert.equal(doc1.id, 1);

    // Configure backup (should automatically set pruneDeleted: false in lazy mode)
    db.configureBackup({
      cloudStorage: {
        bucket: 'test-bucket',
        region: 'us-east-1',
        accessKeyId: 'k',
        secretAccessKey: 's',
        pathPrefix: 'backups',
        dbName: 'lazytest',
      }
    });
    db.backupManager.s3Client = mockS3;

    // Run backup
    const backupRes = await db.backupToBucket();
    assert.equal(backupRes.success, true);

    // Verify cold documents 2..5 were NOT deleted from S3
    for (let i = 2; i <= 5; i++) {
      assert.ok(s3Store.has(`backups/lazytest/doc_${i}.json`), `doc_${i} must not be deleted from cloud in lazy mode`);
    }
    assert.equal(deletedFromS3.length, 0, 'No remote deletes should occur when pruneDeleted is false');

    // Runtime delete: deleting doc_1 must propagate delete to cloud
    await db.delete('doc_1');
    assert.ok(deletedFromS3.includes('backups/lazytest/doc_1.json'), 'Runtime delete in lazy mode must propagate to cloud');
    assert.equal(s3Store.has('backups/lazytest/doc_1.json'), false, 'doc_1 must be deleted from S3 store');
  } finally {
    await db.close();
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('Prefix Collision: Classic backup does not sweep live backup nodes', async () => {
  const testDir = resolve('./test_prefix_isolation_db');
  rmSync(testDir, { recursive: true, force: true });
  const db = new Tero({ directory: testDir });

  const s3Store = new Map();
  const deletedFromS3 = [];

  // Seed live backup checkpoint file and an old document
  s3Store.set('backups/testdb/nodes/node-1/checkpoint/latest.json', {
    size: 50,
    mtime: new Date(),
    eTag: '"abc"',
    data: Buffer.from('{"baseTs":"2026-01-01"}'),
  });
  s3Store.set('backups/testdb/wal/wal-001.json', {
    size: 50,
    mtime: new Date(),
    eTag: '"def"',
    data: Buffer.from('{"lsn":1}'),
  });

  const mockS3 = {
    async send(command) {
      const name = command.constructor.name;
      if (name === 'ListObjectsV2Command') {
        const prefix = command.input.Prefix || '';
        const contents = Array.from(s3Store.entries())
          .filter(([k]) => k.startsWith(prefix))
          .map(([k, v]) => ({
            Key: k,
            Size: v.size,
            LastModified: v.mtime,
            ETag: v.eTag,
          }));
        return { Contents: contents, IsTruncated: false };
      }
      if (name === 'PutObjectCommand') {
        s3Store.set(command.input.Key, {
          size: command.input.Body?.length || 0,
          mtime: new Date(),
          eTag: '"xyz"',
          data: command.input.Body,
        });
        return {};
      }
      if (name === 'DeleteObjectCommand') {
        deletedFromS3.push(command.input.Key);
        s3Store.delete(command.input.Key);
        return {};
      }
      return {};
    }
  };

  try {
    await db.create('my_doc', { hello: 'world' });
    await db.forceCheckpoint();

    const bm = new BackupManager(testDir, {
      format: 'individual',
      pruneDeleted: true,
      cloudStorage: {
        bucket: 'test-bucket',
        region: 'us-east-1',
        accessKeyId: 'k',
        secretAccessKey: 's',
        pathPrefix: 'backups',
        dbName: 'testdb',
      }
    });
    bm.s3Client = mockS3;

    await bm.backupToBucket();

    // Verify live backup files were NOT swept by deleteObject
    assert.ok(s3Store.has('backups/testdb/nodes/node-1/checkpoint/latest.json'), 'Live checkpoint file must be preserved');
    assert.ok(s3Store.has('backups/testdb/wal/wal-001.json'), 'WAL segment must be preserved');
    assert.equal(deletedFromS3.some(k => k.includes('nodes') || k.includes('wal')), false, 'No nodes/wal paths should be deleted');
  } finally {
    db.destroy();
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('Content Diffing: Same-length edits trigger re-upload via ETag check', async () => {
  const testDir = resolve('./test_etag_diff_db');
  rmSync(testDir, { recursive: true, force: true });
  const db = new Tero({ directory: testDir });

  const s3Store = new Map();
  let putCount = 0;

  const mockS3 = {
    async send(command) {
      const name = command.constructor.name;
      if (name === 'ListObjectsV2Command') {
        const prefix = command.input.Prefix || '';
        const contents = Array.from(s3Store.entries())
          .filter(([k]) => k.startsWith(prefix))
          .map(([k, v]) => ({
            Key: k,
            Size: v.size,
            LastModified: v.mtime,
            ETag: v.eTag,
          }));
        return { Contents: contents, IsTruncated: false };
      }
      if (name === 'PutObjectCommand') {
        putCount++;
        const buf = Buffer.from(command.input.Body);
        const md5 = createHash('md5').update(buf).digest('hex');
        s3Store.set(command.input.Key, {
          size: buf.length,
          mtime: new Date(),
          eTag: `"${md5}"`,
          data: buf,
        });
        return {};
      }
      return {};
    }
  };

  try {
    await db.create('user_doc', { age: 30 }); // e.g. {"age":30}
    await db.forceCheckpoint();

    const bm = new BackupManager(testDir, {
      format: 'individual',
      cloudStorage: {
        bucket: 'test-bucket',
        region: 'us-east-1',
        accessKeyId: 'k',
        secretAccessKey: 's',
        pathPrefix: 'backups',
        dbName: 'diffdb',
      }
    });
    bm.s3Client = mockS3;

    // First backup: 1 uploaded
    const r1 = await bm.backupToBucket();
    assert.equal(r1.uploadedDataFiles, 1);

    // Second backup without modification: 0 uploaded (identical ETag)
    const r2 = await bm.backupToBucket();
    assert.equal(r2.uploadedDataFiles, 0);

    // Update with exact SAME byte length: { age: 31 }
    await db.update('user_doc', { age: 31 });
    await db.forceCheckpoint();

    // Third backup: must re-upload because MD5 differs even though byte size is identical
    const r3 = await bm.backupToBucket();
    assert.equal(r3.uploadedDataFiles, 1, 'Document with same byte length but modified content must be re-uploaded');
  } finally {
    db.destroy();
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('Mixed Usage: listAvailableFiles sees all documents unconstrained by MANIFEST.json', async () => {
  const s3Store = new Map();

  // Manifest lists only old_doc
  const manifestData = Buffer.from(JSON.stringify({ dataFiles: ['old_doc.json'] }));
  s3Store.set('backups/testdb/MANIFEST.json', {
    size: manifestData.length,
    mtime: new Date(),
    eTag: '"m"',
    data: manifestData,
  });

  // But bucket contains both old_doc and new_doc
  s3Store.set('backups/testdb/old_doc.json', { size: 10, mtime: new Date(), eTag: '"1"' });
  s3Store.set('backups/testdb/new_doc.json', { size: 10, mtime: new Date(), eTag: '"2"' });

  const mockS3 = {
    async send(command) {
      const name = command.constructor.name;
      if (name === 'ListObjectsV2Command') {
        const prefix = command.input.Prefix || '';
        const contents = Array.from(s3Store.entries())
          .filter(([k]) => k.startsWith(prefix))
          .map(([k, v]) => ({
            Key: k,
            Size: v.size,
            LastModified: v.mtime,
            ETag: v.eTag,
          }));
        return { Contents: contents, IsTruncated: false };
      }
      return {};
    }
  };

  const recovery = new DataRecovery({
    cloudStorage: {
      bucket: 'test-bucket',
      region: 'us-east-1',
      accessKeyId: 'k',
      secretAccessKey: 's',
      pathPrefix: 'backups',
      dbName: 'testdb',
    },
    localPath: '/tmp/unused',
    customS3Client: mockS3,
  });

  const files = await recovery.listAvailableFiles();
  assert.ok(files.includes('old_doc'), 'Must include old_doc');
  assert.ok(files.includes('new_doc'), 'Must include new_doc even though not in MANIFEST.json');
});

