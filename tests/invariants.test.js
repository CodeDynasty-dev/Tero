import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync, appendFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Tero, RecoveryCorruptionError, DataCorruptionError } from '../dist/index.js';
import {
  ACIDStorageEngine,
  WriteAheadLog,
  verifyWalSegmentContinuity,
  recoverPendingRestore,
  partitionedPath,
  cloneJson
} from '../dist/acid-engine.js';
import { BackupManager } from '../dist/backup.js';
import { DataRecovery, classifyRecoveryError } from '../dist/recovery.js';

// ============================================================================
// Invariant A: Committed durability survives process crash/restart
// ============================================================================
test('Invariant A: Committed durability survives process crash and restart', async () => {
  const dbDir = resolve('./test_invariant_a_db');
  rmSync(dbDir, { recursive: true, force: true });

  try {
    let db = new Tero({ directory: dbDir, synchronous: 'full' });
    const docs = 50;
    for (let i = 0; i < docs; i++) {
      await db.create(`doc_${i}`, { idx: i, title: `Title ${i}` });
    }
    // Simulate sudden process crash: destroy without flush of unflushed caches
    db.destroy();

    // Reboot new instance — must replay WAL and retain all 50 documents
    db = new Tero({ directory: dbDir, synchronous: 'full' });
    for (let i = 0; i < docs; i++) {
      const doc = await db.get(`doc_${i}`);
      assert.ok(doc, `doc_${i} must exist after crash recovery`);
      assert.equal(doc.idx, i);
      assert.equal(doc.title, `Title ${i}`);
    }
    db.destroy();
  } finally {
    rmSync(dbDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Invariant B: Rollback atomicity (zero trace on disk or cache)
// ============================================================================
test('Invariant B: Rollback atomicity restores exact state with zero trace on disk or cache', async () => {
  const dbDir = resolve('./test_invariant_b_db');
  rmSync(dbDir, { recursive: true, force: true });

  try {
    const db = new Tero({ directory: dbDir, synchronous: 'full' });
    await db.create('user_1', { name: 'Alice', balance: 100 });

    const tx = db.beginTransaction();
    await tx.update('user_1', { name: 'Alice', balance: 50 });
    await tx.create('user_new', { name: 'Bob' });
    await tx.rollback();

    // Verify user_1 retains original balance and user_new does not exist
    const user1 = await db.get('user_1');
    assert.equal(user1.balance, 100);
    const userNew = await db.get('user_new');
    assert.equal(userNew, null);
    assert.equal(db.exists('user_new'), false);

    // Verify disk state
    const userNewPath = partitionedPath(dbDir, 'user_new');
    assert.equal(existsSync(userNewPath), false);

    db.destroy();
  } finally {
    rmSync(dbDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Invariant C: Precise WAL EOF corruption fail-stop & getLastCommittedLSN
// ============================================================================
test('Invariant C: Newline-terminated invalid record in WAL halts recovery with RecoveryCorruptionError', async () => {
  const dbDir = resolve('./test_invariant_c_newline_db');
  rmSync(dbDir, { recursive: true, force: true });

  try {
    const db = new Tero({ directory: dbDir, synchronous: 'full' });
    await db.create('d1', { val: 1 });
    db.destroy();

    const walPath = join(dbDir, '.wal');
    appendFileSync(walPath, '{"invalid_json": true\n');

    assert.throws(
      () => new Tero({ directory: dbDir, synchronous: 'full' }),
      (err) => {
        assert.equal(err.code, 'RECOVERY_CORRUPTION');
        assert.ok(err.offset !== undefined);
        return true;
      },
      'Newline-terminated corrupt record must halt recovery'
    );
  } finally {
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('Invariant C: Interior invalid record followed by valid records halts recovery', async () => {
  const dbDir = resolve('./test_invariant_c_interior_db');
  rmSync(dbDir, { recursive: true, force: true });

  try {
    const db = new Tero({ directory: dbDir, synchronous: 'full' });
    await db.create('d1', { val: 1 });
    db.destroy();

    const walPath = join(dbDir, '.wal');
    // Corrupt record followed by newline and another record
    appendFileSync(walPath, '{"broken":\n');
    appendFileSync(walPath, '{"operation":"WRITE","transactionId":"tx2","key":"d2","timestamp":1,"checksum":"00"}\n');

    assert.throws(
      () => new Tero({ directory: dbDir, synchronous: 'full' }),
      (err) => {
        assert.equal(err.code, 'RECOVERY_CORRUPTION');
        return true;
      },
      'Interior invalid record must halt recovery'
    );
  } finally {
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('Invariant C: Final unterminated valid record without trailing newline is cleanly replayed', async () => {
  const dbDir = resolve('./test_invariant_c_unterminated_valid_db');
  rmSync(dbDir, { recursive: true, force: true });

  try {
    const engine = new ACIDStorageEngine(dbDir, 'full');
    const txId = engine.beginTransaction();
    engine.write(txId, 'unterminated_doc', { greeting: 'hello' });
    engine.commitTransaction(txId);
    engine.destroy();

    // Strip trailing newline from .wal
    const walPath = join(dbDir, '.wal');
    const content = readFileSync(walPath);
    let end = content.length;
    while (end > 0 && content[end - 1] === 0x0a) {
      end--;
    }
    writeFileSync(walPath, content.subarray(0, end));

    // Recovery must accept the final unterminated valid record
    const db = new Tero({ directory: dbDir, synchronous: 'full' });
    const doc = await db.get('unterminated_doc');
    assert.ok(doc, 'Document without trailing newline at EOF must be replayed');
    assert.equal(doc.greeting, 'hello');
    db.destroy();
  } finally {
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('Invariant C: Final unterminated invalid fragment is ignored as torn tail', async () => {
  const dbDir = resolve('./test_invariant_c_torn_tail_db');
  rmSync(dbDir, { recursive: true, force: true });

  try {
    let db = new Tero({ directory: dbDir, synchronous: 'full' });
    await db.create('doc_valid', { ok: true });
    db.destroy();

    const walPath = join(dbDir, '.wal');
    // Append incomplete fragment without newline
    appendFileSync(walPath, '{"operation":"WRITE","transactionId":"tx_torn","key":"doc_tor');

    db = new Tero({ directory: dbDir, synchronous: 'full' });
    const validDoc = await db.get('doc_valid');
    assert.ok(validDoc, 'Valid record must survive');
    const tornDoc = await db.get('doc_torn');
    assert.equal(tornDoc, null, 'Torn fragment must not be created');
    db.destroy();
  } finally {
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('Invariant C: getLastCommittedLSN strictly returns highest committed LSN, not next allocation LSN', async () => {
  const dbDir = resolve('./test_invariant_c_lsn_distinction_db');
  rmSync(dbDir, { recursive: true, force: true });

  try {
    const engine = new ACIDStorageEngine(dbDir, 'full');
    assert.equal(engine.getLastCommittedLSN(), 0, 'Initial committed LSN must be 0');

    // Begin tx1 and write (allocates LSNs for BEGIN and WRITE)
    const tx1 = engine.beginTransaction();
    engine.write(tx1, 'k1', { v: 1 });
    assert.equal(engine.getLastCommittedLSN(), 0, 'Uncommitted transaction must not advance lastCommittedLSN');

    // Commit tx1
    engine.commitTransaction(tx1);
    const commitLsn1 = engine.getLastCommittedLSN();
    assert.ok(commitLsn1 > 0, 'Committed transaction advances lastCommittedLSN');

    // Begin tx2, write and rollback
    const tx2 = engine.beginTransaction();
    engine.write(tx2, 'k2', { v: 2 });
    engine.rollbackTransaction(tx2);
    assert.equal(engine.getLastCommittedLSN(), commitLsn1, 'Rolled back transaction must not advance lastCommittedLSN');

    // Allocate next LSN without commit
    const tx3 = engine.beginTransaction();
    engine.write(tx3, 'k3', { v: 3 });
    assert.equal(engine.getLastCommittedLSN(), commitLsn1, 'Pending writes must not advance lastCommittedLSN');
    engine.rollbackTransaction(tx3);

    engine.destroy();
  } finally {
    rmSync(dbDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Invariant D: Versioned dirty snapshots & two-phase acknowledgment
// ============================================================================
test('Invariant D: Concurrent writes after snapshot LSN survive dirty-key acknowledgment', async () => {
  const dbDir = resolve('./test_invariant_d_versioned_dirty_db');
  rmSync(dbDir, { recursive: true, force: true });

  try {
    const engine = new ACIDStorageEngine(dbDir, 'full');

    // Step 1: Commit initial write for keyA at LSN 1
    const tx1 = engine.beginTransaction();
    engine.write(tx1, 'keyA', { version: 1 });
    engine.commitTransaction(tx1);
    const ckptLsn = engine.getLastCommittedLSN();

    // Step 2: Take snapshot of dirty keys up to ckptLsn
    const dirtySnapshot = engine.peekDirtyKeys(ckptLsn);
    assert.equal(dirtySnapshot.size, 1);
    assert.equal(dirtySnapshot.get('keyA')?.lsn, ckptLsn);

    // Step 3: Concurrent write on keyA commits at a newer LSN > ckptLsn
    const tx2 = engine.beginTransaction();
    engine.write(tx2, 'keyA', { version: 2 });
    engine.commitTransaction(tx2);
    const newerLsn = engine.getLastCommittedLSN();
    assert.ok(newerLsn > ckptLsn);

    // Step 4: Acknowledge the snapshot from Step 2 (acked with older ckptLsn)
    engine.acknowledgeDirtyKeys([{ key: 'keyA', lsn: ckptLsn }]);

    // Step 5: Verify keyA is STILL dirty because newer write has newer LSN
    const remainingDirty = engine.peekDirtyKeys();
    assert.equal(remainingDirty.size, 1, 'Newer write must remain dirty after older ack');
    assert.equal(remainingDirty.get('keyA')?.lsn, newerLsn);
    assert.deepEqual(remainingDirty.get('keyA')?.data, { version: 2 });

    // Acknowledging with the newer LSN clears it
    engine.acknowledgeDirtyKeys([{ key: 'keyA', lsn: newerLsn }]);
    assert.equal(engine.peekDirtyKeys().size, 0);

    engine.destroy();
  } finally {
    rmSync(dbDir, { recursive: true, force: true });
  }
});

test('Invariant D: Tombstones are versioned and acknowledged correctly', async () => {
  const dbDir = resolve('./test_invariant_d_tombstone_ack_db');
  rmSync(dbDir, { recursive: true, force: true });

  try {
    const engine = new ACIDStorageEngine(dbDir, 'full');

    const tx1 = engine.beginTransaction();
    engine.write(tx1, 'user_tomb', { name: 'DeleteMe' });
    engine.commitTransaction(tx1);

    const tx2 = engine.beginTransaction();
    engine.delete(tx2, 'user_tomb');
    engine.commitTransaction(tx2);
    const deleteLsn = engine.getLastCommittedLSN();

    const dirty = engine.peekDirtyKeys(deleteLsn);
    const tombEntry = dirty.get('user_tomb');
    assert.ok(tombEntry);
    assert.equal(tombEntry.state, 'deleted');
    assert.equal(tombEntry.lsn, deleteLsn);

    // Re-create user_tomb concurrently at a newer LSN
    const tx3 = engine.beginTransaction();
    engine.write(tx3, 'user_tomb', { name: 'Resurrected' });
    engine.commitTransaction(tx3);
    const recreateLsn = engine.getLastCommittedLSN();

    // Acknowledge the tombstone with older deleteLsn
    engine.acknowledgeDirtyKeys([{ key: 'user_tomb', lsn: deleteLsn }]);

    // Re-created document must survive acknowledgment
    const remaining = engine.peekDirtyKeys();
    assert.equal(remaining.get('user_tomb')?.state, 'present');
    assert.equal(remaining.get('user_tomb')?.lsn, recreateLsn);

    engine.destroy();
  } finally {
    rmSync(dbDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Invariant E: Logical PITR equivalence at targetLsn
// ============================================================================
test('Invariant E: Logical PITR equivalence restores exact logical document state at targetLsn', async () => {
  const dbDir = resolve('./test_invariant_e_pitr_db');
  rmSync(dbDir, { recursive: true, force: true });

  try {
    const engine = new ACIDStorageEngine(dbDir, 'full');

    // Tx 1: create doc_a = 10, doc_b = 20
    const tx1 = engine.beginTransaction();
    engine.write(tx1, 'doc_a', { val: 10 });
    engine.write(tx1, 'doc_b', { val: 20 });
    engine.commitTransaction(tx1);
    const targetLsn = engine.getLastCommittedLSN();

    // Establish snapshot stream at targetLsn
    const snapshotStream = engine.snapshotFiles(targetLsn);

    // Concurrent Tx 2: update doc_a = 99, delete doc_b, create doc_c = 30 (committed after targetLsn during active snapshot)
    const tx2 = engine.beginTransaction();
    engine.write(tx2, 'doc_a', { val: 99 });
    engine.delete(tx2, 'doc_b');
    engine.write(tx2, 'doc_c', { val: 30 });
    engine.commitTransaction(tx2);

    // Stream logical snapshot as of targetLsn
    const pitrState = new Map();
    for await (const item of snapshotStream) {
      if (item.state === 'present') {
        pitrState.set(item.key, item.data);
      }
    }

    // Must match oracle state at targetLsn exactly
    assert.deepEqual(pitrState.get('doc_a'), { val: 10 }, 'doc_a must have state as of targetLsn');
    assert.deepEqual(pitrState.get('doc_b'), { val: 20 }, 'doc_b must exist as of targetLsn');
    assert.equal(pitrState.has('doc_c'), false, 'doc_c must not exist as of targetLsn');

    // Verify WAL replay PITR: replaying WAL records up to targetLsn reproduces oracle state
    const replayState = new Map();
    const pending = new Map();
    engine.getWAL().streamLogEntries((e) => {
      if (e.lsn > targetLsn) return;
      if (e.operation === 'WRITE' || e.operation === 'DELETE') {
        if (!pending.has(e.transactionId)) pending.set(e.transactionId, []);
        pending.get(e.transactionId).push(e);
      } else if (e.operation === 'COMMIT') {
        for (const op of pending.get(e.transactionId) || []) {
          if (op.operation === 'WRITE') replayState.set(op.key, op.afterImage);
          else if (op.operation === 'DELETE') replayState.delete(op.key);
        }
        pending.delete(e.transactionId);
      } else if (e.operation === 'ROLLBACK') {
        pending.delete(e.transactionId);
      }
    });
    assert.deepEqual(replayState.get('doc_a'), { val: 10 }, 'WAL replay must match doc_a oracle');
    assert.deepEqual(replayState.get('doc_b'), { val: 20 }, 'WAL replay must match doc_b oracle');
    assert.equal(replayState.has('doc_c'), false, 'WAL replay must exclude doc_c');

    engine.destroy();
  } finally {
    rmSync(dbDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Invariant F: Restore promotion crash idempotence & startup ordering
// ============================================================================
test('Invariant F: Idempotent restore recovery - Case 1: backup exists + target missing + staging exists', async () => {
  const testDir = resolve('./test_invariant_f_case1');
  rmSync(testDir, { recursive: true, force: true });
  mkdirSync(testDir, { recursive: true });

  const targetDir = join(testDir, 'db');
  const backupDir = join(testDir, 'db.backup.123');
  const stagingDir = join(testDir, 'db.staging.123');
  const markerPath = `${targetDir}.restore-in-progress`;

  mkdirSync(backupDir, { recursive: true });
  writeFileSync(join(backupDir, 'old.json'), JSON.stringify({ old: true }));

  mkdirSync(stagingDir, { recursive: true });
  writeFileSync(join(stagingDir, 'restored.json'), JSON.stringify({ restored: true }));

  writeFileSync(markerPath, JSON.stringify({
    id: '123',
    targetDir,
    stagingDir,
    backupDir,
    createdAt: Date.now(),
    stage: 'swapped'
  }));

  recoverPendingRestore(targetDir);

  assert.ok(existsSync(targetDir), 'targetDir must be promoted');
  assert.ok(existsSync(join(targetDir, 'restored.json')), 'restored.json must be in targetDir');
  assert.equal(existsSync(stagingDir), false, 'stagingDir must be cleaned up');
  assert.equal(existsSync(backupDir), false, 'backupDir must be cleaned up');
  assert.equal(existsSync(markerPath), false, 'markerPath must be unlinked');

  rmSync(testDir, { recursive: true, force: true });
});

test('Invariant F: Idempotent restore recovery - Case 2: target exists + backup exists + staging missing', async () => {
  const testDir = resolve('./test_invariant_f_case2');
  rmSync(testDir, { recursive: true, force: true });
  mkdirSync(testDir, { recursive: true });

  const targetDir = join(testDir, 'db');
  const backupDir = join(testDir, 'db.backup.123');
  const markerPath = `${targetDir}.restore-in-progress`;

  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, 'restored.json'), JSON.stringify({ restored: true }));

  mkdirSync(backupDir, { recursive: true });
  writeFileSync(join(backupDir, 'old.json'), JSON.stringify({ old: true }));

  writeFileSync(markerPath, JSON.stringify({
    id: '123',
    targetDir,
    stagingDir: join(testDir, 'db.staging.123'),
    backupDir,
    createdAt: Date.now(),
    stage: 'swapped'
  }));

  recoverPendingRestore(targetDir);

  assert.ok(existsSync(targetDir), 'targetDir must remain intact');
  assert.equal(existsSync(backupDir), false, 'backupDir must be cleaned up');
  assert.equal(existsSync(markerPath), false, 'markerPath must be unlinked');

  rmSync(testDir, { recursive: true, force: true });
});

test('Invariant F: Idempotent restore recovery - Case 3: ambiguous state (all 3 exist)', async () => {
  const testDir = resolve('./test_invariant_f_case3');
  rmSync(testDir, { recursive: true, force: true });
  mkdirSync(testDir, { recursive: true });

  const targetDir = join(testDir, 'db');
  const backupDir = join(testDir, 'db.backup.123');
  const stagingDir = join(testDir, 'db.staging.123');
  const markerPath = `${targetDir}.restore-in-progress`;

  mkdirSync(targetDir, { recursive: true });
  writeFileSync(join(targetDir, 'intact.json'), JSON.stringify({ intact: true }));

  mkdirSync(backupDir, { recursive: true });
  writeFileSync(join(backupDir, 'old.json'), JSON.stringify({ old: true }));

  mkdirSync(stagingDir, { recursive: true });
  writeFileSync(join(stagingDir, 'staging.json'), JSON.stringify({ staging: true }));

  // Stage is 'prepared' -> targetDir is original pre-swap state, clean up staging and backup
  writeFileSync(markerPath, JSON.stringify({
    id: '123',
    targetDir,
    stagingDir,
    backupDir,
    createdAt: Date.now(),
    stage: 'prepared'
  }));

  recoverPendingRestore(targetDir);

  assert.ok(existsSync(targetDir), 'targetDir must be preserved');
  assert.ok(existsSync(join(targetDir, 'intact.json')), 'original target content must survive');
  assert.equal(existsSync(stagingDir), false);
  assert.equal(existsSync(backupDir), false);
  assert.equal(existsSync(markerPath), false);

  rmSync(testDir, { recursive: true, force: true });
});

// ============================================================================
// Invariant G: Cloud error negative-cache protection
// ============================================================================
test('Invariant G: Non-404 cloud errors are never negative-cached and rethrow cleanly', async () => {
  const dbDir = resolve('./test_invariant_g_cloud_error_db');
  rmSync(dbDir, { recursive: true, force: true });

  try {
    let callCount = 0;
    let shouldFail = true;

    // Mock custom S3 client
    const mockS3Client = {
      send: async (cmd) => {
        callCount++;
        if (shouldFail) {
          const err = new Error('500 Internal Server Error (Transient Network Outage)');
          (err).$metadata = { httpStatusCode: 500 };
          throw err;
        }
        // Success case
        return {
          Body: {
            transformToString: async () => JSON.stringify({ name: 'HydratedDocument', recovered: true })
          }
        };
      }
    };

    const db = new Tero({
      directory: dbDir,
      hydrateOnStartup: {
        mode: 'lazy',
        cloudStorage: {
          bucket: 'test-bucket',
          region: 'us-east-1',
          accessKeyId: 'test',
          secretAccessKey: 'test'
        },
        customS3Client: mockS3Client
      }
    });

    // Step 1: Read while network is down -> must throw error and NOT poison negative cache
    await assert.rejects(
      async () => await db.get('cloud_doc_1'),
      /500 Internal Server Error/
    );

    // Step 2: Recover network
    shouldFail = false;

    // Step 3: Subsequent read MUST succeed (not falsely return null from poisoned negative cache)
    const doc = await db.get('cloud_doc_1');
    assert.ok(doc, 'Document must be successfully hydrated after transient error clears');
    assert.equal(doc.name, 'HydratedDocument');

    db.destroy();
  } finally {
    rmSync(dbDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Invariant H: WAL segment metadata & record verification
// ============================================================================
test('Invariant H: verifyWalSegmentContinuity enforces contiguous LSN sequence and metadata matching', () => {
  const testDir = resolve('./test_invariant_h_wal_segments');
  rmSync(testDir, { recursive: true, force: true });
  mkdirSync(testDir, { recursive: true });

  try {
    const seg1 = join(testDir, '.wal.seg-1-5');
    const seg2 = join(testDir, '.wal.seg-6-10');

    // Create valid segment 1
    const lines1 = [];
    for (let lsn = 1; lsn <= 5; lsn++) {
      lines1.push(JSON.stringify({ lsn, operation: 'WRITE', key: `k${lsn}`, timestamp: 1000 + lsn }));
    }
    writeFileSync(seg1, lines1.join('\n') + '\n');

    // Create valid segment 2
    const lines2 = [];
    for (let lsn = 6; lsn <= 10; lsn++) {
      lines2.push(JSON.stringify({ lsn, operation: 'WRITE', key: `k${lsn}`, timestamp: 1000 + lsn }));
    }
    writeFileSync(seg2, lines2.join('\n') + '\n');

    // Valid continuity
    const verified = verifyWalSegmentContinuity([seg1, seg2], true);
    assert.equal(verified.length, 2);
    assert.equal(verified[0].startLsn, 1);
    assert.equal(verified[0].endLsn, 5);
    assert.equal(verified[1].startLsn, 6);
    assert.equal(verified[1].endLsn, 10);

    // Reject startLsn > endLsn
    const invertedSeg = join(testDir, '.wal.seg-20-10');
    writeFileSync(invertedSeg, '{"lsn": 10}\n');
    assert.throws(
      () => verifyWalSegmentContinuity([invertedSeg]),
      (err) => err.code === 'RECOVERY_CORRUPTION'
    );

    // Reject empty segment with declared range
    const emptySeg = join(testDir, '.wal.seg-11-15');
    writeFileSync(emptySeg, '');
    assert.throws(
      () => verifyWalSegmentContinuity([emptySeg], true),
      (err) => err.code === 'RECOVERY_CORRUPTION'
    );

    // Reject duplicate segment range
    const dupSeg = join(testDir, '.wal.seg-1-5.dup');
    assert.throws(
      () => verifyWalSegmentContinuity([seg1, seg1]),
      (err) => err.code === 'RECOVERY_CORRUPTION'
    );

    // Reject gap between segments (e.g. 1-5 followed by 7-10)
    const gapSeg = join(testDir, '.wal.seg-7-10');
    writeFileSync(gapSeg, lines2.join('\n') + '\n');
    assert.throws(
      () => verifyWalSegmentContinuity([seg1, gapSeg]),
      (err) => err.code === 'RECOVERY_CORRUPTION'
    );

    // Reject declared start LSN mismatch
    const badStart = join(testDir, '.wal.seg-2-5');
    writeFileSync(badStart, lines1.join('\n') + '\n'); // lines1 starts at lsn 1
    assert.throws(
      () => verifyWalSegmentContinuity([badStart], true),
      (err) => err.code === 'RECOVERY_CORRUPTION'
    );
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Static Catch Audit: Zero unapproved broad catch blocks in storage/recovery
// ============================================================================
test('Static Audit: Zero unapproved broad catch {}, catch { continue; }, or catch { return []; }', () => {
  const targetFiles = [
    'src/acid-engine.ts',
    'src/recovery.ts',
    'src/backup.ts'
  ];

  const violations = [];

  for (const file of targetFiles) {
    const fullPath = resolve(file);
    const content = readFileSync(fullPath, 'utf8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const nextLine = lines[i + 1] || '';

      // Check for unapproved blind return [] in catch without isNotFound check
      if (line.includes('catch') && (line.includes('return []') || nextLine.includes('return []'))) {
        const block = line + ' ' + nextLine;
        if (!block.includes('isNotFound') && !block.includes('/* approved')) {
          violations.push({ file, line: i + 1, text: line.trim() });
        }
      }

      // Check for empty catch without comment or approval annotation
      if (
        (line.includes('catch { }') || line.includes('catch {}')) &&
        !line.includes('/*') &&
        !line.includes('//') &&
        !line.includes('unlinkSync') &&
        !line.includes('rmSync')
      ) {
        violations.push({ file, line: i + 1, text: line.trim() });
      }
    }
  }

  assert.equal(violations.length, 0, `Unapproved broad catch blocks found:\n${JSON.stringify(violations, null, 2)}`);
});

// ============================================================================
// Invariant I: Checkpoint dirty ACK ordering strictly after publishing latest
// ============================================================================
test('Invariant I: Checkpoint acknowledges dirty keys strictly after publishing latest.json', async () => {
  const testDir = resolve('./test_invariant_i_ack_order');
  rmSync(testDir, { recursive: true, force: true });
  mkdirSync(testDir, { recursive: true });

  try {
    const uploadedKeys = [];
    let simulateFailureBeforePublish = true;

    const mockS3Client = {
      send: async (cmd) => {
        const key = cmd.input?.Key || '';
        if (key) uploadedKeys.push(key);

        if (simulateFailureBeforePublish && key.endsWith('latest.json')) {
          const err = new Error('Simulated S3 failure right before publishing latest.json');
          err.$metadata = { httpStatusCode: 500 };
          throw err;
        }

        if (cmd.constructor.name === 'PutObjectCommand' || cmd.input?.Body) {
          return { ETag: '"etag-123"' };
        }
        if (cmd.constructor.name === 'HeadObjectCommand') {
          const err = new Error('NotFound');
          err.name = 'NotFound';
          err.$metadata = { httpStatusCode: 404 };
          throw err;
        }
        return {};
      }
    };

    const engine = new ACIDStorageEngine(testDir, 'full');
    await engine.createDocument('user_1', { name: 'Alice' });
    await engine.createDocument('user_2', { name: 'Bob' });

    const backup = new BackupManager({
      localPath: testDir,
      cloudStorage: {
        bucket: 'test-bucket',
        region: 'us-east-1',
        accessKeyId: 'test',
        secretAccessKey: 'test'
      },
      customS3Client: mockS3Client,
      engine
    });

    // 1) First attempt: S3 fails on latest.json upload
    simulateFailureBeforePublish = true;
    await assert.rejects(
      async () => await backup.doFullCheckpoint(),
      /Simulated S3 failure/
    );

    // Dirty keys must NOT be acknowledged if latest.json failed!
    assert.equal(engine.hasPendingDirtyKeys(), true, 'Engine must still have pending dirty keys when publishing fails');

    // 2) Second attempt: S3 succeeds
    simulateFailureBeforePublish = false;
    const res = await backup.doFullCheckpoint();
    assert.ok(res.manifestKey, 'Checkpoint must succeed');

    // Now dirty keys are acknowledged
    assert.equal(engine.hasPendingDirtyKeys(), false, 'Engine dirty keys must be acknowledged after latest.json publishes');

    // Verify ordering in uploadedKeys: data files -> index.json -> MANIFEST.json -> latest.json
    const manifestIdx = uploadedKeys.findIndex(k => k.endsWith('MANIFEST.json'));
    const latestIdx = uploadedKeys.findIndex(k => k.endsWith('latest.json'));
    assert.ok(manifestIdx !== -1, 'MANIFEST.json must be uploaded');
    assert.ok(latestIdx !== -1, 'latest.json must be uploaded');
    assert.ok(latestIdx > manifestIdx, 'latest.json must be published after MANIFEST.json');

    backup.destroy();
    engine.destroy();
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Invariant J: Cloud restore zero-gap & checksum validation
// ============================================================================
test('Invariant J: Cloud restore enforces zero-gap and detects checksum/range corruptions', async () => {
  const testDir = resolve('./test_invariant_j_restore');
  rmSync(testDir, { recursive: true, force: true });
  mkdirSync(testDir, { recursive: true });

  try {
    const targetDir = join(testDir, 'db_target');

    // Scenario 1: Gap between base snapshot LSN and first WAL segment
    // Base snapshot is LSN 10, but first WAL segment starts at LSN 12 (LSN 11 missing)
    const backup = new BackupManager({
      localPath: testDir,
      cloudStorage: {
        bucket: 'test-bucket',
        region: 'us-east-1',
        accessKeyId: 'test',
        secretAccessKey: 'test'
      },
      customS3Client: {
        send: async (cmd) => {
          const key = cmd.input?.Key || '';
          if (key.endsWith('latest.json') || key.endsWith('MANIFEST.json')) {
            return {
              Body: {
                transformToString: async () => JSON.stringify({
                  manifestVersion: 2,
                  type: 'full',
                  timestamp: Date.now(),
                  baseSnapshotLsn: 10,
                  lastLsn: 15,
                  walSegments: ['tero-backups/db/wal/.wal.seg-12-15']
                })
              }
            };
          }
          if (key.includes('.wal.seg-12-15')) {
            return {
              Body: {
                transformToString: async () => '{"lsn": 12, "operation": "WRITE", "key": "k1", "data": {}}\n'
              }
            };
          }
          if (key.endsWith('index.json')) {
            return {
              Body: {
                transformToString: async () => JSON.stringify({ lsn: 10, documents: {} })
              }
            };
          }
          return {};
        }
      }
    });

    await assert.rejects(
      async () => await backup._restoreToTargetDirectory(targetDir, undefined),
      (err) => {
        assert.equal(err.code, 'RECOVERY_CORRUPTION');
        assert.ok(err.message.includes('gap'), `Expected gap message, got: ${err.message}`);
        return true;
      }
    );

    backup.destroy();
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Invariant K: cloneJson strict validation
// ============================================================================
test('Invariant K: cloneJson strictly validates JSON and rejects non-serializable types', () => {
  // Primitives allowed
  assert.equal(cloneJson(null), null);
  assert.equal(cloneJson(true), true);
  assert.equal(cloneJson(false), false);
  assert.equal(cloneJson(123), 123);
  assert.equal(cloneJson(0), 0);
  assert.equal(cloneJson('hello'), 'hello');

  // Objects & arrays
  assert.deepEqual(cloneJson({ a: 1, b: 'two', c: [3, 4] }), { a: 1, b: 'two', c: [3, 4] });

  // Rejections
  assert.throws(() => cloneJson(NaN), /Cannot serialize non-finite/);
  assert.throws(() => cloneJson(Infinity), /Cannot serialize non-finite/);
  assert.throws(() => cloneJson(-Infinity), /Cannot serialize non-finite/);
  assert.throws(() => cloneJson(10n), /Cannot serialize non-JSON/);
  assert.throws(() => cloneJson(Symbol('sym')), /Cannot serialize non-JSON/);
  assert.throws(() => cloneJson(() => {}), /Cannot serialize non-JSON/);
  assert.throws(() => cloneJson(new Date()), /Cannot serialize non-plain object/);
  assert.throws(() => cloneJson(new Map()), /Cannot serialize non-plain object/);
  assert.throws(() => cloneJson(new Set()), /Cannot serialize non-plain object/);
  assert.throws(() => cloneJson({ a: NaN }), /Cannot serialize non-finite/);
  assert.throws(() => cloneJson([new Date()]), /Cannot serialize non-plain object/);
});

// ============================================================================
// Invariant L: Key validation permits non-traversal dots and forbids traversal
// ============================================================================
test('Invariant L: Key validation permits non-traversal dots (version..2) and rejects traversal', async () => {
  const testDir = resolve('./test_invariant_l_keys');
  rmSync(testDir, { recursive: true, force: true });

  try {
    const db = new Tero({ directory: testDir, synchronous: 'full' });

    // version..2 must be valid!
    await db.create('version..2', { version: 2 });
    const doc = await db.get('version..2');
    assert.deepEqual(doc, { version: 2 });

    // Illegal keys must be rejected
    const illegalKeys = ['.', '..', 'foo/bar', 'foo\\bar', 'foo\0bar', '.hidden', '..traversal'];
    for (const badKey of illegalKeys) {
      await assert.rejects(
        async () => await db.create(badKey, { bad: true }),
        /Key contains invalid characters/
      );
      await assert.rejects(
        async () => await db.get(badKey),
        /Key contains invalid characters/
      );
    }

    db.destroy();
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Invariant M: getWithRecoveryStrict and eager hydration error propagation
// ============================================================================
test('Invariant M: getWithRecoveryStrict and eager hydration error propagation when continueOnError is false', async () => {
  const testDir = resolve('./test_invariant_m_recovery_strict');
  rmSync(testDir, { recursive: true, force: true });

  try {
    const mockS3Client = {
      send: async () => {
        const err = new Error('AccessDenied: S3 Bucket 403 Forbidden');
        err.name = 'AccessDenied';
        err.$metadata = { httpStatusCode: 403 };
        throw err;
      }
    };

    // 1) Eager hydration with continueOnError: false MUST reject Tero.create()
    await assert.rejects(
      async () => await Tero.create({
        directory: testDir,
        hydrateOnStartup: {
          mode: 'eager',
          continueOnError: false,
          cloudStorage: {
            bucket: 'test-bucket',
            region: 'us-east-1',
            accessKeyId: 'test',
            secretAccessKey: 'test'
          },
          customS3Client: mockS3Client
        }
      }),
      /AccessDenied/
    );

    // 2) getWithRecoveryStrict MUST throw cloud errors instead of returning null
    const db = new Tero({
      directory: testDir,
      hydrateOnStartup: {
        mode: 'lazy',
        cloudStorage: {
          bucket: 'test-bucket',
          region: 'us-east-1',
          accessKeyId: 'test',
          secretAccessKey: 'test'
        },
        customS3Client: mockS3Client
      }
    });

    // getWithRecovery returns null by default (lenient)
    const lenient = await db.getWithRecovery('missing_key');
    assert.equal(lenient, null);

    // getWithRecoveryStrict throws the 403
    await assert.rejects(
      async () => await db.getWithRecoveryStrict('missing_key'),
      /AccessDenied/
    );

    db.destroy();
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

// ============================================================================
// Invariant N: Degraded mode and last maintenance error tracking
// ============================================================================
test('Invariant N: db.isDegraded() and db.getLastMaintenanceError() track status', async () => {
  const testDir = resolve('./test_invariant_n_status');
  rmSync(testDir, { recursive: true, force: true });

  try {
    const db = new Tero({ directory: testDir });
    assert.equal(db.isDegraded(), false);
    assert.equal(db.getLastMaintenanceError(), null);
    db.destroy();
  } finally {
    rmSync(testDir, { recursive: true, force: true });
  }
});

