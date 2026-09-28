import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, writeFileSync, mkdirSync, readdirSync, symlinkSync } from 'fs';
import { resolve, join } from 'path';
import { Tero } from '../dist/index.js';
import { partitionedPath, sweepStaleTempFiles } from '../dist/acid-engine.js';

const OLD_TS = Date.now() - 10 * 60 * 1000; // 10 minutes ago
const FRESH_TS = Date.now();

/** A temp file name exactly as acid-engine.ts / index.ts produce it. */
const tmpName = (target, pid, ts) => `${target}.tmp.${pid}.${ts}.abc123def456`;

/** Walk a directory tree, returning every file path found. */
function allFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else out.push(p);
    }
  }
  return out;
}

test('boot sweep removes orphaned temp files in partition dirs', async () => {
  const dir = resolve('./test_sweep_partition_db');
  rmSync(dir, { recursive: true, force: true });
  const db = new Tero({ directory: dir, synchronous: 'full' });
  try {
    await db.create('real', { a: 1 });
    await db.forceCheckpoint();

    const leaf = partitionedPath(dir, 'real');
    const leafDir = leaf.slice(0, leaf.length - 'real.json'.length);
    const stale = join(leafDir, tmpName('ghost.json', 999999, OLD_TS));
    writeFileSync(stale, 'partial');

    // destroy() releases the .lock, so the next boot can acquire it cleanly.
    db.destroy();

    const { removed } = sweepStaleTempFiles(dir);
    assert.equal(removed, 1, 'the orphaned temp file must be reaped');
    assert.equal(existsSync(stale), false, 'stale temp file must be gone');
    assert.equal(existsSync(leaf), true, 'the real data file must survive the sweep');
  } finally {
    try { db.destroy(); } catch { /* already destroyed */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('boot sweep never touches real data, WAL, tombstones, or queue files', async () => {
  const dir = resolve('./test_sweep_preserve_db');
  rmSync(dir, { recursive: true, force: true });
  const db = new Tero({ directory: dir, synchronous: 'full' });
  try {
    await db.create('alpha', { a: 1 });
    // A legal Tero key that literally contains '.tmp.' — the data file is
    // 'weird.tmp.key.json' and must NOT be treated as a temp file.
    await db.create('weird.tmp.key', { b: 2 });
    await db.create('report.tmp.thing', { c: 3 });
    await db.forceCheckpoint();

    // Tombstone + pending-queue + backup dir + WAL segment all live in the dir.
    const tombDir = join(dir, '.tombstones');
    mkdirSync(tombDir, { recursive: true });
    writeFileSync(join(tombDir, 'abc123.deleted'), '{}');
    writeFileSync(join(dir, '.cloud_pending.json'), '[]');
    writeFileSync(join(dir, '.wal.seg-000000000001-000000000005'), 'x');
    mkdirSync(join(dir, '.backup'), { recursive: true });
    writeFileSync(join(dir, '.backup', 'alpha.json'), '{"a":1}');

    const before = allFiles(dir).sort();

    // Nothing here is a temp file, so removed must be 0 and the tree unchanged.
    const { scanned, removed } = sweepStaleTempFiles(dir);
    assert.equal(removed, 0, 'sweep must not remove any legitimate file');
    assert.deepEqual(allFiles(dir).sort(), before, 'sweep must leave the directory byte-identical');

    // And a normal write/read cycle still works afterwards.
    await db.create('gamma', { d: 4 });
    const g = await db.get('gamma');
    assert.deepEqual(g, { d: 4 });
    assert.deepEqual(await db.get('weird.tmp.key'), { b: 2 });
  } finally {
    db.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('boot sweep spares this process and fresh temp files', () => {
  const dir = resolve('./test_sweep_pid_db');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    const mine = join(dir, tmpName('inflight.json', process.pid, FRESH_TS));
    const otherFresh = join(dir, tmpName('inflight2.json', process.pid + 1, FRESH_TS));
    // backup.ts's shape carries no timestamp and must be left alone forever.
    const untimestamped = join(dir, `restored.json.tmp.${process.pid + 2}.k3h9xz`);
    // recovery.ts's mirrored form has no '.tmp.' marker.
    const mirrored = join(dir, `hydrated.json.${FRESH_TS}.k3h9xz.tmp`);
    for (const f of [mine, otherFresh, untimestamped, mirrored]) writeFileSync(f, 'x');

    const { removed } = sweepStaleTempFiles(dir);

    assert.equal(removed, 0, 'nothing here is provably orphaned');
    for (const f of [mine, otherFresh, untimestamped, mirrored]) {
      assert.equal(existsSync(f), true, `${f} must be preserved`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('boot sweep is wired into the Tero constructor', async () => {
  const dir = resolve('./test_sweep_boot_db');
  rmSync(dir, { recursive: true, force: true });

  // Seed a stale temp file inside a real partition leaf, then boot Tero.
  const db1 = new Tero({ directory: dir, synchronous: 'full' });
  await db1.create('seed', { v: 1 });
  await db1.forceCheckpoint();
  const leaf = partitionedPath(dir, 'seed');
  const leafDir = leaf.slice(0, leaf.length - 'seed.json'.length);
  const stale = join(leafDir, tmpName('seed.json', 999998, OLD_TS));
  writeFileSync(stale, 'partial');
  db1.destroy();

  // Booting must reap it with no explicit sweep call.
  const db2 = new Tero({ directory: dir, synchronous: 'full' });
  try {
    assert.equal(existsSync(stale), false, 'constructor must reap the orphaned temp file');
    assert.deepEqual(await db2.get('seed'), { v: 1 }, 'the document itself is untouched');
  } finally {
    db2.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('boot sweep removes a stale top-level pending-queue temp file', async () => {
  const dir = resolve('./test_sweep_queue_db');
  rmSync(dir, { recursive: true, force: true });
  const db = new Tero({ directory: dir, synchronous: 'full' });
  try {
    // index.ts:1550 writes these as
    // '.cloud_pending.json.tmp.<pid>.<ts>.<hex>' in the top-level dir.
    const stale = join(dir, `.cloud_pending.json.tmp.${process.pid + 5}.${OLD_TS}.aabbccddeeff`);
    writeFileSync(stale, '[["k",1]]');

    const { removed } = sweepStaleTempFiles(dir);

    assert.equal(removed, 1, 'stale top-level queue temp file must be reaped');
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(join(dir, '.cloud_pending.json')), false,
      'only the temp file is reaped, the queue itself is untouched');
  } finally {
    db.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('boot sweep does not follow symlinks out of the data directory', () => {
  const dir = resolve('./test_sweep_symlink_db');
  const outside = resolve('./test_sweep_symlink_outside');
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  mkdirSync(outside, { recursive: true });
  try {
    const victim = join(outside, 'precious.txt');
    writeFileSync(victim, 'do not delete me');

    // A symlink whose NAME looks exactly like an orphaned temp file.
    symlinkSync(victim, join(dir, tmpName('link.json', 999997, OLD_TS)));

    const { removed } = sweepStaleTempFiles(dir);
    assert.equal(removed, 0, 'a symlink must never be unlinked by the sweep');
    assert.equal(existsSync(victim), true, 'the symlink target outside the dir must survive');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('boot sweep descends exactly two partition levels and skips dot-dirs', () => {
  const dir = resolve('./test_sweep_depth_db');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    // depth 1: not a real data location, but inside the walk
    const l0 = join(dir, 'aa');
    // depth 2: the real data-file location
    const l1 = join(l0, 'bb');
    // depth 3: beyond the partition layout — must NOT be swept
    const tooDeep = join(l1, 'cc');
    // a dot-dir at depth 0 holding a data file plus a temp file
    const dot = join(dir, '.backup');
    for (const d of [l0, l1, tooDeep, dot]) mkdirSync(d, { recursive: true });

    const shallow = join(l1, tmpName('k.json', 999996, OLD_TS));
    const deep = join(tooDeep, tmpName('k.json', 999995, OLD_TS));
    const inDot = join(dot, tmpName('k.json', 999994, OLD_TS));
    const dotData = join(dot, 'keep.json');
    for (const f of [shallow, deep, inDot]) writeFileSync(f, 'x');
    writeFileSync(dotData, '{"keep":true}');

    const { removed } = sweepStaleTempFiles(dir);

    assert.equal(removed, 1, 'only the depth-2 partition file is swept');
    assert.equal(existsSync(shallow), false, 'depth 2 is swept');
    assert.equal(existsSync(deep), true, 'depth 3 is beyond the partition layout and is spared');
    assert.equal(existsSync(inDot), true, 'dot-directories are never descended into');
    assert.equal(existsSync(dotData), true, 'real data in .backup is never touched');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('boot sweep tolerates unreadable directories and never throws', () => {
  const dir = resolve('./test_sweep_resilience_db');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    // A path that does not exist must be a no-op, not a crash.
    assert.deepEqual(sweepStaleTempFiles(join(dir, 'nope', 'missing')), { scanned: 0, removed: 0 });
    // A file where a directory is expected must also be a no-op.
    const notADir = join(dir, 'regular-file');
    writeFileSync(notADir, 'x');
    assert.doesNotThrow(() => sweepStaleTempFiles(notADir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
