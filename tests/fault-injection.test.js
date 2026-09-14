import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync, readFileSync, appendFileSync } from 'fs';
import { resolve, join } from 'path';
import { Tero } from '../dist/index.js';
import { partitionedPath } from '../dist/acid-engine.js';

test('WAL Fault Injection: Truncated torn write at EOF is recovered cleanly without crash', async () => {
  const testDir = resolve('./test_wal_torn_write_db');
  rmSync(testDir, { recursive: true, force: true });
  let db = new Tero({ directory: testDir, synchronous: 'full' });

  try {
    // Write 30 valid transactions
    for (let i = 0; i < 30; i++) {
      await db.create(`doc_${i}`, { idx: i, data: `val_${i}` });
    }
    await db.forceCheckpoint();
    db.destroy();

    // Now inject a torn write: half of a JSON record appended at the end of .wal
    const walPath = join(testDir, '.wal');
    assert.ok(existsSync(walPath), '.wal file must exist');
    appendFileSync(walPath, '{"operation":"WRITE","transactionId":"tx_crashed","data":{"half":"trun');

    // Boot a fresh Tero instance on the same directory
    db = new Tero({ directory: testDir, synchronous: 'full' });

    // Verify all 30 pre-crash documents are intact and healthy
    for (let i = 0; i < 30; i++) {
      const doc = await db.get(`doc_${i}`);
      assert.ok(doc !== null, `Document doc_${i} must survive torn write`);
      assert.equal(doc.idx, i);
      assert.equal(doc.data, `val_${i}`);
    }

    // Verify new writes succeed and advance LSN properly
    await db.create('doc_post_crash', { status: 'alive' });
    const postDoc = await db.get('doc_post_crash');
    assert.deepEqual(postDoc, { status: 'alive' });
  } finally {
    db.destroy();
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('WAL Fault Injection: Bit-flip checksum corruption is rejected without corrupting database', async () => {
  const testDir = resolve('./test_wal_bit_flip_db');
  rmSync(testDir, { recursive: true, force: true });
  let db = new Tero({ directory: testDir, synchronous: 'full' });

  try {
    await db.create('good_doc_1', { valid: true });
    await db.create('good_doc_2', { valid: true });
    db.destroy();

    const walPath = join(testDir, '.wal');
    // Inject a line with a forged/corrupted checksum
    const badLine = JSON.stringify({
      operation: 'WRITE',
      transactionId: 'tx_corrupt',
      key: 'corrupt_doc',
      data: { evil: true },
      lsn: 999,
      timestamp: Date.now(),
      checksum: 'deadbeef12345678' // Invalid checksum
    }) + '\n';
    appendFileSync(walPath, badLine);

    // Boot new instance — must fail-stop with RecoveryCorruptionError
    assert.throws(
      () => {
        new Tero({ directory: testDir, synchronous: 'full' });
      },
      (err) => {
        assert.equal(err.code, 'RECOVERY_CORRUPTION');
        return true;
      },
      'WAL corruption must throw RecoveryCorruptionError'
    );
  } finally {
    try { db.destroy(); } catch {}
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('Data Integrity: verifyDataIntegrity identifies corrupted document and isolates it', async () => {
  const testDir = resolve('./test_data_corruption_db');
  rmSync(testDir, { recursive: true, force: true });
  const db = new Tero({ directory: testDir });

  try {
    // Write 5 documents
    for (let i = 1; i <= 5; i++) {
      await db.create(`item_${i}`, { index: i });
    }
    await db.forceCheckpoint();

    // Directly corrupt item_3 on disk with invalid JSON bytes
    const item3Path = partitionedPath(testDir, 'item_3');
    assert.ok(existsSync(item3Path), 'item_3 file must exist');
    writeFileSync(item3Path, '{ "index": 3, "corrupted_half: [INVALID_JSON');

    // Run data integrity verification
    const report = await db.verifyDataIntegrity();
    assert.equal(report.healthy, false, 'Database must be reported as unhealthy');
    assert.ok(report.corruptedFiles.includes('item_3'), 'item_3 must be flagged as corrupted');

    // All other 4 documents must still be readable and uncorrupted
    for (let i of [1, 2, 4, 5]) {
      const doc = await db.get(`item_${i}`);
      assert.equal(doc.index, i);
    }
  } finally {
    db.destroy();
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('Transaction Atomicity: Rollback leaves 0 partial writes on disk or in cache', async () => {
  const testDir = resolve('./test_rollback_atomicity_db');
  rmSync(testDir, { recursive: true, force: true });
  const db = new Tero({ directory: testDir });

  try {
    await db.create('existing_doc', { original: true });

    const tx = db.beginTransaction();
    await tx.create('temp_1', { step: 1 });
    await tx.create('temp_2', { step: 2 });
    await tx.create('temp_3', { step: 3 });
    await tx.update('existing_doc', { original: false, modified: true });

    // Abort transaction
    await tx.rollback();

    // Verify existing_doc is unmodified
    const existing = await db.get('existing_doc');
    assert.equal(existing.original, true);
    assert.equal(existing.modified, undefined);

    // Verify temp_1, temp_2, temp_3 do NOT exist
    assert.equal(await db.get('temp_1'), null);
    assert.equal(await db.get('temp_2'), null);
    assert.equal(await db.get('temp_3'), null);

    assert.equal(db.exists('temp_1'), false);
    assert.equal(db.exists('temp_2'), false);
    assert.equal(db.exists('temp_3'), false);

    // Verify files were not written to disk
    assert.equal(existsSync(partitionedPath(testDir, 'temp_1')), false);
    assert.equal(existsSync(partitionedPath(testDir, 'temp_2')), false);
    assert.equal(existsSync(partitionedPath(testDir, 'temp_3')), false);
  } finally {
    db.destroy();
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('Crash Recovery: Stale .lock from dead process is automatically reclaimed', async () => {
  const testDir = resolve('./test_stale_lock_db');
  rmSync(testDir, { recursive: true, force: true });

  // Simulate a previous crashed process leaving a .lock with a dead PID (e.g. 999999)
  const { mkdirSync } = await import('fs');
  mkdirSync(testDir, { recursive: true });
  const lockFile = join(testDir, '.lock');
  writeFileSync(lockFile, '999999\n' + new Date().toISOString());

  // A fresh Tero instance should detect the PID is dead, reclaim the lock, and boot successfully
  const db = new Tero({ directory: testDir });

  try {
    await db.create('test_key', { alive: true });
    const val = await db.get('test_key');
    assert.equal(val.alive, true);
  } finally {
    db.destroy();
    rmSync(testDir, { recursive: true, force: true });
  }
});
