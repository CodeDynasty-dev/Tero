// Regression tests for the pre-launch audit findings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync, cpSync } from 'node:fs';
import { resolve } from 'node:path';
import { Tero } from '../dist/index.js';
import { ACIDStorageEngine } from '../dist/acid-engine.js';
import { BackupManager } from '../dist/backup.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fresh = (name) => { const d = resolve(name); rmSync(d, { recursive: true, force: true }); rmSync(`${d}.restore-in-progress`, { force: true }); return d; };
const cloud = { provider: 'aws-s3', bucket: 'b', region: 'us-east-1', accessKeyId: 'x', secretAccessKey: 'y', pathPrefix: 'p', dbName: 'db' };
function memS3() {
  const store = new Map();
  return { store, async send(cmd) {
    const n = cmd.constructor.name, i = cmd.input;
    if (n === 'PutObjectCommand') { store.set(i.Key, { body: Buffer.isBuffer(i.Body) ? i.Body : Buffer.from(i.Body), at: new Date() }); return {}; }
    if (n === 'GetObjectCommand') { const o = store.get(i.Key); if (!o) { const e = new Error('NoSuchKey'); e.name = 'NoSuchKey'; throw e; } return { Body: (async function* () { yield o.body; })() }; }
    if (n === 'ListObjectsV2Command') return { Contents: [...store.entries()].filter(([k]) => k.startsWith(i.Prefix || '')).map(([k, v]) => ({ Key: k, Size: v.body.length, LastModified: v.at })), IsTruncated: false };
    if (n === 'DeleteObjectCommand') { store.delete(i.Key); return {}; }
    throw new Error('mock: unsupported ' + n);
  } };
}
const walRanges = (s3) => [...s3.store.keys()].filter((k) => k.includes('/wal/')).map((k) => k.match(/seg-(\d+)-(\d+)/).slice(1).map(Number)).sort((a, b) => a[0] - b[0]);

test('lock: a leftover .lock naming our own pid (container restart after a crash) does not block boot', async () => {
  const dir = fresh('TeroLA_lock');
  let db = new Tero({ directory: dir, synchronous: 'normal' });
  await db.set('k', { a: 1 });
  await db.close();
  writeFileSync(`${dir}/.lock`, String(process.pid)); // what a SIGKILLed holder with the same pid leaves behind
  db = new Tero({ directory: dir, synchronous: 'normal' });
  assert.deepEqual(await db.get('k'), { a: 1 });
  assert.throws(() => new Tero({ directory: dir, synchronous: 'normal' }), /already using/, 'a second live instance in the same process is still refused');
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

test('checkpoint: a commit that lands while an async durable checkpoint is in flight is replayed after a crash', async () => {
  const dir = fresh('TeroLA_ckpt'), crash = fresh('TeroLA_ckpt_crash');
  const e = new ACIDStorageEngine(dir, 'normal', 10, 3_600_000, 1000, undefined, 0);
  const put = (k, v) => { const t = e.beginTransaction(); e.write(t, k, v, undefined, true); e.commitTransaction(t); };
  put('a', { v: 1 });
  const ck = e.forceCheckpointAsync();
  put('b', { v: 2 });
  await ck;
  e.getWAL().forceFlush();
  cpSync(dir, crash, { recursive: true }); // disk state if the process died here
  const r = new ACIDStorageEngine(crash, 'normal', 10, 50, 1000, undefined, 0);
  const t = r.beginTransaction();
  assert.deepEqual(r.read(t, 'a'), { v: 1 });
  assert.deepEqual(r.read(t, 'b'), { v: 2 }, 'commit made during the checkpoint must survive');
  r.commitTransaction(t);
  r.destroy(); e.destroy();
  rmSync(dir, { recursive: true, force: true }); rmSync(crash, { recursive: true, force: true });
});

test('live backup: several WAL rotations between two ship ticks leave no hole, and the bucket restores', async () => {
  const dir = fresh('TeroLA_ship'), out = fresh('TeroLA_ship_restored');
  const s3 = memS3();
  const db = new Tero({ directory: dir, synchronous: 'normal', archiveKeepCount: 10,
    backup: { format: 'individual', cloudStorage: cloud, customS3Client: s3 },
    liveBackup: { consistency: 'interval', intervalMs: 2000, checkpointIntervalMs: 0, nodeId: 'n1' } });
  await sleep(300); // initial full checkpoint
  const big = { blob: 'x'.repeat(150_000) };
  for (let i = 0; i < 40; i++) { big.i = i; await db.set(`doc${i % 8}`, big); await sleep(15); } // ~6MB of WAL = several 1MB rotations inside one 2s tick
  await sleep(4500);
  const segs = walRanges(s3);
  assert.ok(segs.length >= 3, `expected several shipped segments, got ${segs.length}`);
  for (let i = 1; i < segs.length; i++) assert.ok(segs[i][0] <= segs[i - 1][1] + 1, `hole in shipped WAL: ${JSON.stringify(segs)}`);
  const mgr = new BackupManager(out, { format: 'individual', cloudStorage: cloud, customS3Client: s3 });
  await mgr.restoreLiveToDirectory(out, { nodeId: 'n1' });
  mgr.destroy();
  await db.close();
  const restored = new Tero({ directory: out, synchronous: 'normal' });
  assert.equal((await restored.get('doc7')).i, 39);
  await restored.close();
  rmSync(dir, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true });
});

test('restore: allowWalGap restores up to a hole instead of refusing; default still refuses', async () => {
  const dir = fresh('TeroLA_gap'), out = fresh('TeroLA_gap_restored');
  const s3 = memS3();
  const db = new Tero({ directory: dir, synchronous: 'normal',
    backup: { format: 'individual', cloudStorage: cloud, customS3Client: s3 },
    liveBackup: { consistency: 'interval', intervalMs: 500, checkpointIntervalMs: 0, nodeId: 'n1' } });
  await sleep(300);
  for (const k of ['a', 'b', 'c']) { await db.set(k, { k }); await sleep(700); }
  await db.close();
  const keys = [...s3.store.keys()].filter((k) => k.includes('/wal/')).sort();
  assert.ok(keys.length >= 3);
  s3.store.delete(keys[1]); // punch a hole
  const mgr = new BackupManager(out, { format: 'individual', cloudStorage: cloud, customS3Client: s3 });
  await assert.rejects(mgr.restoreLiveToDirectory(out, { nodeId: 'n1' }), /gap/i);
  const res = await mgr.restoreLiveToDirectory(out, { nodeId: 'n1', allowWalGap: true });
  assert.equal(typeof res.walGapAtLsn, 'number');
  mgr.destroy();
  const restored = new Tero({ directory: out, synchronous: 'normal' });
  assert.deepEqual(await restored.get('a'), { k: 'a' });
  await restored.set('after', { ok: true }); // numbering continues above everything in the bucket
  await restored.close();
  rmSync(dir, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true });
});
