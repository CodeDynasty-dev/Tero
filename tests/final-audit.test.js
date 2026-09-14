// FINAL CORRECTNESS AUDIT - adversarial tests for the launch invariants.
// Deterministic fault injection (chmod + mock S3) rather than sleeps.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, chmodSync } from 'fs';
import { createHash } from 'crypto';
import { resolve, join } from 'path';
import { Tero } from '../dist/index.js';

const sha = (k) => createHash('sha256').update(k).digest('hex');
const tombPath = (dir, key) => join(dir, '.tombstones', `${sha(key)}.deleted`);

function mockS3(overrides = {}) {
  const calls = { put: 0, del: 0, head: 0, get: 0, list: 0 };
  const mode = {
    putTombstoneFail: false, putDocumentFail: false, deleteFail: false,
    getFail: false, headDelayMs: 0, getDelayMs: 0,
  };
  Object.assign(mode, overrides);
  const store = new Map();
  return {
    mode, calls, store,
    async send(command) {
      const name = command.constructor.name;
      const key = command.input.Key;
      if (name === 'PutObjectCommand') {
        calls.put++;
        const fail = key.endsWith('.deleted') ? mode.putTombstoneFail : mode.putDocumentFail;
        if (fail) { const e = new Error('put fail'); e.name = 'InternalError'; throw e; }
        store.set(key, { metadata: command.input.Metadata || {}, lastModified: new Date() });
        return {};
      }
      if (name === 'DeleteObjectCommand') {
        calls.del++;
        if (mode.deleteFail) { const e = new Error('del fail'); e.name = 'InternalError'; throw e; }
        store.delete(key); return {};
      }
      if (name === 'HeadObjectCommand') {
        calls.head++;
        const item = store.get(key);
        if (mode.headDelayMs) await new Promise((r) => setTimeout(r, mode.headDelayMs));
        if (!item) { const e = new Error('NotFound'); e.name = 'NotFound'; e.$metadata = { httpStatusCode: 404 }; throw e; }
        return { LastModified: item.lastModified, Metadata: item.metadata, ContentLength: 0 };
      }
      if (name === 'GetObjectCommand') {
        calls.get++;
        if (mode.getDelayMs) await new Promise((r) => setTimeout(r, mode.getDelayMs));
        if (mode.getFail || !store.has(key)) { const e = new Error('NoSuchKey'); e.name = 'NoSuchKey'; throw e; }
        const doc = store.get(key).doc || {};
        return { Body: { async transformToString() { return JSON.stringify(doc); } } };
      }
      if (name === 'ListObjectsV2Command') { calls.list++; return { Contents: [], IsTruncated: false }; }
      return {};
    },
  };
}

async function dbWithCloud(dir, s3) {
  return Tero.create({
    directory: dir, synchronous: 'full',
    hydrateOnStartup: {
      cloudStorage: { bucket: 'b', region: 'r', accessKeyId: 'k', secretAccessKey: 's', pathPrefix: 'p', dbName: 'db' },
      mode: 'lazy', customS3Client: s3,
    },
  });
}

test('AUDIT[1] commit succeeds even when post-commit tombstone cleanup fails', async () => {
  const dir = resolve('./audit1_db'); rmSync(dir, { recursive: true, force: true });
  const db = new Tero({ directory: dir, synchronous: 'full' });
  try {
    await db.create('K', { v: 1 });
    await db.delete('K');                       // write local tombstone
    chmodSync(join(dir, '.tombstones'), 0o555); // block unlink
    let created = false;
    try { created = await db.create('K', { v: 2 }); } catch { created = false; }
    assert.equal(created, true, 'recreate commit must NOT fail because tombstone cleanup fails');
    assert.deepEqual(await db.get('K'), { v: 2 });
    chmodSync(join(dir, '.tombstones'), 0o755);
  } finally {
    try { chmodSync(join(dir, '.tombstones'), 0o755); } catch {}
    await db.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('AUDIT[2] recreate clears pending cloud tombstone and removes cloud tombstone', async () => {
  const dir = resolve('./audit2_db'); rmSync(dir, { recursive: true, force: true });
  const s3 = mockS3({ putTombstoneFail: true });
  const db = await dbWithCloud(dir, s3);
  try {
    await db.create('K', { v: 1 });
    await db.delete('K');                       // putTombstone fails -> queued
    assert.equal(db.isCloudReconciliationPending(), true);
    await db.create('K', { v: 2 });
    await db.retryCloudReconciliation();
    assert.equal(db.isCloudReconciliationPending(), false, 'recreate must clear pending cloud tombstone');
    assert.equal(existsSync(tombPath(dir, 'K')), false, 'local tombstone gone after recreate');
  } finally {
    await db.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('AUDIT[3] local tombstone retry removes tombstone even after a commit-buffer flush', async () => {
  const dir = resolve('./audit3_db'); rmSync(dir, { recursive: true, force: true });
  const db = new Tero({ directory: dir, synchronous: 'full' });
  try {
    await db.create('K', { v: 1 });
    await db.delete('K');
    chmodSync(join(dir, '.tombstones'), 0o555);
    await db.create('K', { v: 2 });            // unlink fails -> queued local removal
    chmodSync(join(dir, '.tombstones'), 0o755);
    await db.forceCheckpoint();                // flush K out of committedBuffer onto disk
    await db.retryCloudReconciliation();
    assert.equal(existsSync(tombPath(dir, 'K')), false, 'local tombstone removed after flush + retry');
  } finally {
    try { chmodSync(join(dir, '.tombstones'), 0o755); } catch {}
    await db.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('AUDIT[4] pending cloud tombstone creation survives restart then drains', async () => {
  const dir = resolve('./audit4_db'); rmSync(dir, { recursive: true, force: true });
  const s3 = mockS3({ putTombstoneFail: true });
  let db = await dbWithCloud(dir, s3);
  try {
    await db.create('K', { v: 1 });
    await db.delete('K');
    assert.equal(s3.calls.put >= 1, true);
    await db.close();
    s3.mode.putTombstoneFail = false;
    db = await dbWithCloud(dir, s3);
    assert.equal(db.isCloudReconciliationPending(), true, 'pending cloud tombstone restored');
    await db.retryCloudReconciliation();
    assert.equal(db.isCloudReconciliationPending(), false, 'pending cloud tombstone drains');
    assert.equal(s3.store.has('p/db/K.json.deleted'), true, 'cloud tombstone published');
  } finally {
    await db.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('AUDIT[5] pending cloud tombstone deletion survives restart then drains', async () => {
  const dir = resolve('./audit5_db'); rmSync(dir, { recursive: true, force: true });
  const s3 = mockS3({});
  // Cloud already has a durable tombstone for a deleted key.
  s3.store.set('p/db/K.json.deleted', { metadata: { 'tombstone-version': '5' }, lastModified: new Date() });
  let db = await dbWithCloud(dir, s3);
  try {
    s3.mode.deleteFail = true;
    await db.create('K', { v: 1 });  // hasTombstone true -> allow recreate; deleteTombstone fails -> queued
    assert.equal(db.isCloudReconciliationPending(), true, 'failed cloud tombstone delete queued');
    await db.close();
    s3.mode.deleteFail = false;
    db = await dbWithCloud(dir, s3);
    assert.equal(db.isCloudReconciliationPending(), true, 'pending cloud tombstone deletion restored');
    await db.retryCloudReconciliation();
    assert.equal(db.isCloudReconciliationPending(), false, 'cloud tombstone deletion drains');
    assert.equal(s3.store.has('p/db/K.json.deleted'), false, 'cloud tombstone deleted');
  } finally {
    await db.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('AUDIT[7] failed transaction create releases the exclusive lock', async () => {
  const dir = resolve('./audit7_db'); rmSync(dir, { recursive: true, force: true });
  const db = new Tero({ directory: dir });
  try {
    await db.create('k', {});
    const tx = db.beginTransaction();
    await assert.rejects(() => tx.create('k', {}));   // duplicate create throws
    const tx2 = db.beginTransaction();
    await tx2.update('k', { x: 1 });                  // would block if lock leaked
    await db.commit(tx2);
    assert.deepEqual(await db.get('k'), { x: 1 });
    await db.commit(tx);
  } finally {
    await db.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('AUDIT[10] uncommitted tx with multiple writes/deletes is fully undone on restart', async () => {
  const dir = resolve('./audit10_db'); rmSync(dir, { recursive: true, force: true });
  const db = new Tero({ directory: dir, synchronous: 'full' });
  await db.create('A', { v: 0 });
  const tx = db.beginTransaction();
  await tx.update('A', { v: 1 });
  await tx.update('A', { v: 2 });
  await tx.create('B', { b: 1 });
  await tx.delete('B');
  await tx.delete('A');
  db.destroy();                               // crash without commit
  const db2 = new Tero({ directory: dir, synchronous: 'full' });
  try {
    assert.deepEqual(await db2.get('A'), { v: 0 }, 'uncommitted tx writes/deletes rolled back');
    assert.equal(await db2.get('B'), null, 'uncommitted tx creates/deletes rolled back');
  } finally {
    await db2.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('AUDIT[10b] committed txs on same key: last COMMIT wins across restart', async () => {
  const dir = resolve('./audit10b_db'); rmSync(dir, { recursive: true, force: true });
  let db = new Tero({ directory: dir, synchronous: 'full' });
  await db.create('A', { n: 0 });
  const t1 = db.beginTransaction(); await t1.update('A', { n: 1 }); await db.commit(t1);
  const t2 = db.beginTransaction(); await t2.update('A', { n: 2 }); await db.commit(t2);
  db.destroy();
  db = new Tero({ directory: dir, synchronous: 'full' });
  try {
    assert.deepEqual(await db.get('A'), { n: 2 }, 'last committed write wins');
  } finally {
    await db.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('AUDIT[6] concurrent reconciliation of two different keys', async () => {
  const dir = resolve('./audit6_db'); rmSync(dir, { recursive: true, force: true });
  const s3 = mockS3({ putTombstoneFail: true });
  const db = await dbWithCloud(dir, s3);
  try {
    for (const k of ['A1', 'B1']) await db.create(k, {});
    await Promise.all(['A1', 'B1'].map((k) => db.delete(k)));
    const queued = new Set(db.getCloudReconciliationPendingKeys());
    assert.equal(queued.has('A1'), true);
    assert.equal(queued.has('B1'), true);
  } finally {
    await db.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('AUDIT[9] hydrated value does not override a later local delete/update (LOCAL > CACHE > HYDRATION)', async () => {
  const dir = resolve('./audit9_db'); rmSync(dir, { recursive: true, force: true });
  const s3 = mockS3({});
  s3.store.set('p/db/K.json', { metadata: { 'version-lsn': '50' }, lastModified: new Date(), doc: { cloud: 1 } });
  const db = await dbWithCloud(dir, s3);
  try {
    // Fresh hydration brings the cloud value into local cache + disk.
    assert.deepEqual(await db.get('K'), { cloud: 1 }, 'first read hydrates cloud doc');
    // A newer local write must win over the cached/hydrated value.
    await db.update('K', { cloud: 1, local: true });
    assert.deepEqual(await db.get('K'), { cloud: 1, local: true }, 'local update wins over cache');
    // And a delete must be respecicted (no resurrection from hydration/cache).
    await db.delete('K');
    assert.equal(await db.get('K'), null, 'deleted key must not resurrect from cache/hydration');
  } finally {
    await db.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('AUDIT[11] deleted key does not resurrect and recreated key survives across restart', async () => {
  const dir = resolve('./audit11_db'); rmSync(dir, { recursive: true, force: true });
  let db = new Tero({ directory: dir, synchronous: 'full' });
  await db.create('DEL', { v: 1 });
  await db.delete('DEL');
  await db.create('REC', { v: 1 });
  await db.delete('REC');
  await db.create('REC', { v: 2 });            // recreate after delete
  db.destroy();                                // crash/restart
  db = new Tero({ directory: dir, synchronous: 'full' });
  try {
    assert.equal(await db.get('DEL'), null, 'deleted key must not resurrect after restart');
    assert.deepEqual(await db.get('REC'), { v: 2 }, 'recreated key must survive restart');
  } finally {
    await db.close(); rmSync(dir, { recursive: true, force: true });
  }
});

test('AUDIT[12] committed tx is recovered from WAL after crash before explicit checkpoint', async () => {
  const dir = resolve('./audit12_db'); rmSync(dir, { recursive: true, force: true });
  let db = new Tero({ directory: dir, synchronous: 'full' });
  await db.create('A', { v: 42 });           // committed + WAL fsynced
  db.destroy();                                // no forceCheckpoint -> data only in WAL/committedBuffer
  db = new Tero({ directory: dir, synchronous: 'full' });
  try {
    assert.deepEqual(await db.get('A'), { v: 42 }, 'committed write must be replayed from WAL');
  } finally {
    await db.close(); rmSync(dir, { recursive: true, force: true });
  }
});
