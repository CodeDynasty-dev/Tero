// Regression tests for the production fixes in this release:
// replace-writes, bounded crash recovery, dirty tracking, tombstone hygiene,
// commit-path bucket traffic, live-backup checkpoint correctness, S3 timeouts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync, readdirSync } from 'fs';
import { createServer } from 'net';
import { Tero } from '../dist/index.js';
import { DataRecovery } from '../dist/recovery.js';

const fresh = (d) => { rmSync(d, { recursive: true, force: true }); return d; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cloudCfg = { provider: 'aws-s3', bucket: 'b', region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's', pathPrefix: 'p', dbName: 'db' };

/** In-memory S3 good enough for Tero: Put/Get/Head/Delete/List with ETag + metadata, plus call counts. */
function memS3() {
  const store = new Map();
  const calls = {};
  const notFound = () => { const e = new Error('NotFound'); e.name = 'NoSuchKey'; e.$metadata = { httpStatusCode: 404 }; return e; };
  return {
    store, calls,
    async send(cmd) {
      const n = cmd.constructor.name; calls[n] = (calls[n] || 0) + 1;
      const k = cmd.input.Key;
      if (n === 'PutObjectCommand') {
        const b = cmd.input.Body; const buf = Buffer.isBuffer(b) ? b : Buffer.from(b ?? '');
        store.set(k, { buf, meta: cmd.input.Metadata || {}, lm: new Date() }); return {};
      }
      if (n === 'GetObjectCommand') {
        const it = store.get(k); if (!it) throw notFound();
        return { ContentLength: it.buf.length, Body: { transformToByteArray: async () => new Uint8Array(it.buf), transformToString: async () => it.buf.toString('utf8'), async *[Symbol.asyncIterator]() { yield it.buf; } } };
      }
      if (n === 'HeadObjectCommand') { const it = store.get(k); if (!it) throw notFound(); return { LastModified: it.lm, Metadata: it.meta, ContentLength: it.buf.length, ETag: '"x"' }; }
      if (n === 'DeleteObjectCommand') { store.delete(k); return {}; }
      if (n === 'ListObjectsV2Command') {
        const p = cmd.input.Prefix || '';
        return { Contents: [...store.entries()].filter(([key]) => key.startsWith(p)).map(([key, v]) => ({ Key: key, Size: v.buf.length, LastModified: v.lm, ETag: '"x"' })), IsTruncated: false };
      }
      return {};
    },
  };
}

test('set() replaces the document; update() still merges', async () => {
  const dir = fresh('TeroPF_set');
  const db = new Tero({ directory: dir, synchronous: 'full' });
  await db.create('p', { name: 'A', retention_days: 30 });
  const doc = await db.get('p'); delete doc.retention_days;
  await db.update('p', doc);
  assert.equal((await db.get('p')).retention_days, 30, 'merge keeps absent fields (documented)');
  await db.set('p', doc);
  assert.equal('retention_days' in (await db.get('p')), false, 'set() removes absent fields');
  db.destroy();
  const db2 = new Tero({ directory: dir });
  assert.deepEqual(await db2.get('p'), { name: 'A' }, 'replacement survives restart');
  await db2.set('new', { x: 1 });
  assert.deepEqual(await db2.get('new'), { x: 1 }, 'set() creates missing documents');
  const tx = db2.beginTransaction(); await tx.set('p', { only: true }); await tx.commit();
  assert.deepEqual(await db2.get('p'), { only: true }, 'Transaction.set replaces');
  await db2.set('u', [{ id: 1, userId: undefined, n: null }]);
  assert.deepEqual(await db2.get('u'), [{ id: 1, n: null }], 'undefined fields are dropped like JSON, not rejected');
  await db2.batchWrite([{ key: 'p', data: { b: 1 }, replace: true }]);
  assert.deepEqual(await db2.get('p'), { b: 1 }, 'batchWrite replace');
  db2.destroy(); fresh(dir);
});

test('crash recovery replays only after the last durable checkpoint, incl. a tx spanning it', async () => {
  const dir = fresh('TeroPF_ckpt');
  let db = new Tero({ directory: dir, synchronous: 'normal', durableCheckpointIntervalMs: 0 });
  for (let i = 0; i < 200; i++) await db.set(`k${i}`, { v: i });
  const tx = db.beginTransaction();
  await tx.set('span', { v: 'spanning' });        // WRITE before the checkpoint
  db.forceCheckpoint();                             // floor must cover tx's BEGIN
  await tx.commit();                                // COMMIT after the checkpoint
  await db.set('after', { v: 1 });
  db.acidEngine.getWAL().forceFlush();
  // crash: no destroy — just stop the abandoned instance's background timers so
  // they cannot touch the directory after the test removes it.
  clearInterval(db.acidEngine.dataFlushTimer); clearInterval(db.acidEngine.durableCheckpointTimer);
  db.acidEngine.getWAL().stopGroupCommitTimer();
  db = new Tero({ directory: dir, synchronous: 'normal', durableCheckpointIntervalMs: 0, fileLock: false });
  assert.deepEqual(await db.get('span'), { v: 'spanning' }, 'tx that began before the checkpoint is recovered');
  assert.deepEqual(await db.get('after'), { v: 1 });
  assert.deepEqual(await db.get('k199'), { v: 199 });
  db.destroy();
  // Clean shutdown leaves a durable checkpoint: nothing to replay next boot.
  db = new Tero({ directory: dir, fileLock: false });
  assert.equal(db.acidEngine.recoveredCommits, 0, 'clean restart replays no transactions');
  db.destroy(); fresh(dir);
});

test('dirty tracking is off unless live backup is enabled', async () => {
  const dir = fresh('TeroPF_dirty');
  const db = new Tero({ directory: dir });
  for (let i = 0; i < 300; i++) await db.set(`d${i}`, { i });
  assert.equal(db.acidEngine.getDirtyKeyCount(), 0, 'no unbounded document copies without a backup consumer');
  db.destroy(); fresh(dir);
});

test('no local tombstones or bucket calls when cloud mirroring is off', async () => {
  const dir = fresh('TeroPF_tomb');
  const s3 = memS3();
  const db = new Tero({ directory: dir });
  db.configureDataRecovery({ cloudStorage: cloudCfg, localPath: dir, customS3Client: s3, mode: 'off' });
  await db.create('x', { a: 1 }); await db.update('x', { a: 2 }); await db.get('missing-key'); await db.delete('x'); await db.create('x', { a: 3 });
  assert.deepEqual(s3.calls, {}, `request path must not touch the bucket, saw ${JSON.stringify(s3.calls)}`);
  assert.equal(existsSync(`${dir}/.tombstones`) && readdirSync(`${dir}/.tombstones`).length > 0, false, 'no tombstone files');
  assert.equal(db.keyGenerations.size, 0, 'generation map stays empty');
  db.destroy(); fresh(dir);
});

test('lazy mode: plain updates make no bucket calls; delete/re-create still reconcile', async () => {
  const dir = fresh('TeroPF_lazy');
  const s3 = memS3();
  const db = await Tero.create({ directory: dir, synchronous: 'full', hydrateOnStartup: { cloudStorage: cloudCfg, mode: 'lazy', customS3Client: s3 } });
  await db.create('u', { v: 0 });
  for (const k in s3.calls) delete s3.calls[k];
  for (let i = 1; i <= 20; i++) await db.update('u', { v: i });
  assert.deepEqual(s3.calls, {}, `20 updates must not call the bucket, saw ${JSON.stringify(s3.calls)}`);
  await db.delete('u');
  assert.ok([...s3.store.keys()].some((k) => k.endsWith('u.json.deleted')), 'cloud tombstone written');
  assert.equal(existsSync(`${dir}/.tombstones`) ? readdirSync(`${dir}/.tombstones`).length : 0, 0, 'local tombstone collected once the cloud one is durable');
  assert.equal(await db.get('u'), null, 'deleted key is not resurrected');
  await db.create('u', { v: 'again' });
  assert.equal([...s3.store.keys()].some((k) => k.endsWith('u.json.deleted')), false, 're-create removes the cloud tombstone');
  db.destroy(); fresh(dir);
});

test('live backup: checkpoint captured atomically, spanning tx restored, covered WAL pruned, early PITR refused', async () => {
  const dir = fresh('TeroPF_live');
  const s3 = memS3();
  const backup = { format: 'individual', cloudStorage: cloudCfg, customS3Client: s3 };
  const db = new Tero({ directory: dir, synchronous: 'normal', backup });
  db.enableLiveBackup({ consistency: 'interval', intervalMs: 1000, nodeId: 'n1', checkpointIntervalMs: 0 });
  await sleep(50);
  for (let i = 0; i < 50; i++) await db.set(`doc${i}`, { i });
  await sleep(1300);                                // ship
  const tx = db.beginTransaction();
  await tx.set('span', { ok: true });               // WRITE below the checkpoint LSN
  const ck = db.liveCheckpointToBucket();           // capture happens synchronously here
  await tx.commit();                                // committed after the capture
  await ck;
  for (let i = 0; i < 10; i++) await db.set(`late${i}`, { i });
  await sleep(1300);
  await db.liveCheckpointToBucket();                // prunes WAL wholly before its floor
  const walObjs = [...s3.store.keys()].filter((k) => k.includes('/wal/'));
  const latest = JSON.parse(s3.store.get([...s3.store.keys()].find((k) => k.endsWith('checkpoint/latest.json'))).buf.toString());
  assert.ok(typeof latest.replayFromLsn === 'number' && typeof latest.capturedAt === 'number', 'latest.json records replay floor + capture time');
  for (const k of walObjs) {
    const end = parseInt(k.match(/seg-(\d+)-(\d+)/)[2], 10);
    assert.ok(end >= latest.replayFromLsn, `WAL object ${k} ends before the replay floor and should be pruned`);
  }
  db.destroy();
  fresh(dir);
  const restored = await Tero.restoreFromLiveBackup({ directory: dir, cloudStorage: cloudCfg, customS3Client: s3, nodeId: 'n1' });
  assert.deepEqual(await restored.get('span'), { ok: true }, 'tx spanning the checkpoint is restored');
  assert.deepEqual(await restored.get('late9'), { i: 9 });
  assert.deepEqual(await restored.get('doc49'), { i: 49 });
  restored.destroy(); fresh(dir);
  await assert.rejects(
    Tero.restoreFromLiveBackup({ directory: dir, cloudStorage: cloudCfg, customS3Client: s3, nodeId: 'n1', pointInTime: latest.capturedAt - 60_000 }),
    /oldest restorable point/, 'PITR before the checkpoint must be refused, not answered with newer data');
  fresh(dir);
});

test('S3 requests time out instead of hanging forever', async () => {
  const sockets = [];
  const server = createServer((s) => { sockets.push(s); /* accept, never answer */ });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const dr = new DataRecovery({ cloudStorage: { ...cloudCfg, endpoint: `http://127.0.0.1:${port}`, requestTimeoutMs: 300, connectionTimeoutMs: 300 }, localPath: 'unused' });
  const t0 = Date.now();
  await assert.rejects(dr.hasTombstone('k'));
  assert.ok(Date.now() - t0 < 10_000, `took ${Date.now() - t0}ms`);
  sockets.forEach((s) => s.destroy()); server.close();
});

test('live backup survives the full lifecycle: restart, restore, keep writing, restore again', async () => {
  const dir = fresh('TeroPF_cycle');
  const s3 = memS3();
  const backup = { format: 'individual', cloudStorage: cloudCfg, customS3Client: s3 };
  const live = { consistency: 'interval', intervalMs: 1000, nodeId: 'cyc', checkpointIntervalMs: 0 };
  const open = () => { const d = new Tero({ directory: dir, synchronous: 'normal', backup }); d.enableLiveBackup(live); return d; };
  const assertNoOverlap = () => {
    const segs = [...s3.store.keys()].filter((k) => k.includes('/wal/')).map((k) => k.match(/seg-(\d+)-(\d+)/).slice(1).map(Number)).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < segs.length; i++) assert.ok(segs[i][0] > segs[i - 1][1], `overlapping WAL objects in bucket: ${JSON.stringify(segs)}`);
  };

  // Session 1
  let db = open();
  await sleep(50);
  for (let i = 0; i < 30; i++) await db.set(`s1_${i}`, { i });
  await db.liveCheckpointToBucket();           // incremental: s1 docs in base
  await db.set('s1_late', { late: true });     // only in WAL
  await sleep(1300);
  db.destroy();

  // Session 2: plain restart on the same disk (a deploy)
  db = open();
  await sleep(1300);
  await db.set('s2_a', { a: 1 });
  await sleep(1300);
  assertNoOverlap();
  db.acidEngine.destroy?.(); db.backupManager?.destroy?.(); // crash: no clean close
  fresh(dir);

  // Restore 1 → session 3 keeps writing
  await (await Tero.restoreFromLiveBackup({ directory: dir, cloudStorage: cloudCfg, customS3Client: s3, nodeId: 'cyc' })).destroy();
  db = open();
  assert.deepEqual(await db.get('s1_late'), { late: true }, 'WAL-only doc restored');
  assert.deepEqual(await db.get('s2_a'), { a: 1 });
  await sleep(200);
  await db.set('s3_x', { x: 1 });
  await db.update('s1_0', { changed: true });
  await sleep(1300);
  await db.liveCheckpointToBucket();
  await sleep(1300);
  assertNoOverlap();
  db.destroy();
  fresh(dir);

  // Restore 2: everything from all three sessions
  const r = await Tero.restoreFromLiveBackup({ directory: dir, cloudStorage: cloudCfg, customS3Client: s3, nodeId: 'cyc' });
  assert.deepEqual(await r.get('s1_29'), { i: 29 });
  assert.deepEqual(await r.get('s1_late'), { late: true }, 'doc that only ever lived in pre-restore WAL survives a second restore');
  assert.deepEqual(await r.get('s2_a'), { a: 1 });
  assert.deepEqual(await r.get('s3_x'), { x: 1 });
  assert.deepEqual(await r.get('s1_0'), { i: 0, changed: true });
  r.destroy(); fresh(dir);
});

test('raw WAL shipping: document text that looks like an lsn field cannot confuse it', async () => {
  const dir = fresh('TeroPF_raw');
  const s3 = memS3();
  const backup = { format: 'individual', cloudStorage: cloudCfg, customS3Client: s3 };
  const db = new Tero({ directory: dir, synchronous: 'normal', backup });
  db.enableLiveBackup({ consistency: 'interval', intervalMs: 1000, nodeId: 'raw', checkpointIntervalMs: 0 });
  await sleep(50);
  const tricky = { note: '"lsn":999999,"timestamp":1', nested: { lsn: 5 } };
  for (let i = 0; i < 20; i++) await db.set(`t${i}`, { ...tricky, i });
  await sleep(1300);
  db.destroy();
  fresh(dir);
  const r = await Tero.restoreFromLiveBackup({ directory: dir, cloudStorage: cloudCfg, customS3Client: s3, nodeId: 'raw' });
  for (let i = 0; i < 20; i++) assert.deepEqual(await r.get(`t${i}`), { ...tricky, i });
  r.destroy(); fresh(dir);
});

test('async durable checkpoint: data survives a crash right after it, and later writes replay', async () => {
  const dir = fresh('TeroPF_async');
  let db = new Tero({ directory: dir, synchronous: 'normal', durableCheckpointIntervalMs: 0 });
  for (let i = 0; i < 300; i++) await db.set(`a${i}`, { i });
  await db.acidEngine.forceCheckpointAsync();
  assert.ok(db.acidEngine.getDurableCheckpoint(), 'durable checkpoint recorded');
  await db.set('after', { ok: true });
  db.acidEngine.getWAL().forceFlush();
  clearInterval(db.acidEngine.dataFlushTimer); db.acidEngine.getWAL().stopGroupCommitTimer();
  db = new Tero({ directory: dir, synchronous: 'normal', durableCheckpointIntervalMs: 0, fileLock: false });
  assert.equal(db.acidEngine.recoveredCommits, 1, 'only the post-checkpoint commit is replayed');
  assert.deepEqual(await db.get('a299'), { i: 299 });
  assert.deepEqual(await db.get('after'), { ok: true });
  db.destroy(); fresh(dir);
});
