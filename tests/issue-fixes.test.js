import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, readFileSync } from 'fs';
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
