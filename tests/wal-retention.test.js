import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, rmSync, statSync } from 'fs';
import { resolve } from 'path';
import { Tero } from '../dist/index.js';
import { WriteAheadLog, DEFAULT_ARCHIVE_KEEP_COUNT } from '../dist/acid-engine.js';

/** Rotated segments in a data directory, oldest first (names sort by start LSN). */
const segments = (dir) => readdirSync(dir).filter(f => f.startsWith('.wal.seg-')).sort();

/** `<end LSN>` of a segment name `.wal.seg-<start>-<end>`. */
const endLsnOf = (name) => parseInt(name.slice(name.lastIndexOf('-') + 1), 10);

const segmentBytes = (dir, name) => statSync(resolve(dir, name)).size;

/**
 * One WRITE entry larger than the 1MB rotation limit plus a forced flush —
 * i.e. exactly one rotation, with a segment whose size we control.
 */
function rotate(wal, bytes = 1024 * 1024) {
  wal.writeLog({
    operation: 'WRITE',
    transactionId: 'tx',
    key: 'k',
    afterImage: { blob: 'x'.repeat(bytes) },
  });
  wal.forceFlush();
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise(r => setTimeout(r, 50));
  }
  return predicate();
}

/** Capture console.warn for the duration of `fn`. */
async function captureWarnings(fn) {
  const original = console.warn;
  const seen = [];
  console.warn = (...args) => { seen.push(args.join(' ')); };
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return seen;
}

test('unconfigured WAL retains far more than the old 3-segment cache', () => {
  const dir = resolve('./test_wal_keep_default');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const wal = new WriteAheadLog(dir, 'full');
  try {
    assert.equal(DEFAULT_ARCHIVE_KEEP_COUNT, 20, 'the documented default is 20 segments');

    // 8 rotations: the old hardcoded 3 would have left 3 files behind.
    for (let i = 0; i < 8; i++) rotate(wal);

    assert.equal(segments(dir).length, 8, 'below the keep count nothing is pruned');
  } finally {
    wal.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('archiveKeepCount is enforced when configured', () => {
  for (const keepCount of [1, 4]) {
    const dir = resolve(`./test_wal_keep_${keepCount}`);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const wal = new WriteAheadLog(dir, 'full', 10, { archiveKeepCount: keepCount });
    try {
      for (let i = 0; i < keepCount + 4; i++) rotate(wal);
      assert.equal(segments(dir).length, keepCount, `keepCount=${keepCount} must be the retention floor`);
    } finally {
      wal.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('protector defers pruning while segments are still unshipped', () => {
  const dir = resolve('./test_wal_protect_db');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  // keepCount=2 is the old "3 segment" shape, small enough that the old code
  // would have destroyed history long before the shipper's next tick.
  const wal = new WriteAheadLog(dir, 'full', 10, { archiveKeepCount: 2 });
  let shippedLsn = -1; // live backup enabled, nothing uploaded yet
  wal.setArchiveProtector(endLsn => endLsn > shippedLsn);

  try {
    for (let i = 0; i < 5; i++) rotate(wal);
    assert.equal(segments(dir).length, 5, 'unshipped WAL must survive rotation');

    // The shipper catches up (everything so far is durably in the bucket), so
    // the next rotation prunes back down to the keep count.
    shippedLsn = Number.MAX_SAFE_INTEGER;
    rotate(wal);
    assert.equal(segments(dir).length, 2, 'shipped surplus is pruned as before');
  } finally {
    wal.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('protection is per-segment: shipped history prunes, the unshipped tail survives', () => {
  const dir = resolve('./test_wal_protect_partial_db');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const wal = new WriteAheadLog(dir, 'full', 10, { archiveKeepCount: 1 });
  let shippedLsn = -1;
  wal.setArchiveProtector(endLsn => endLsn > shippedLsn);

  try {
    for (let i = 0; i < 4; i++) rotate(wal);
    const firstBatch = segments(dir);
    assert.equal(firstBatch.length, 4);

    // A shipper that stalled mid-way through the third segment: everything up
    // to the second segment is in the bucket, the rest is not.
    shippedLsn = endLsnOf(firstBatch[1]);

    rotate(wal); // fifth segment + a cleanup pass
    const after = segments(dir);
    const names = after.join(', ');

    assert.equal(after.length, 3, `expected keepCount + 2 protected, got ${after.length}: ${names}`);
    assert.equal(after.includes(firstBatch[0]), false, 'a fully shipped segment past the keep count is pruned');
    assert.equal(after.includes(firstBatch[1]), false, 'shipped up to its last LSN, so pruned');
    assert.equal(after.includes(firstBatch[2]), true, 'unshipped segment must be kept');
    assert.equal(after.includes(firstBatch[3]), true, 'unshipped segment must be kept');
  } finally {
    wal.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the protect byte budget bounds disk growth during a sustained outage', async () => {
  const dir = resolve('./test_wal_protect_budget_db');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  // Budget=0 is the degenerate case: every unshipped segment is over budget, so
  // retention degrades to prune-oldest rather than letting the WAL fill the disk.
  const wal = new WriteAheadLog(dir, 'full', 10, { archiveKeepCount: 1, archiveProtectMaxBytes: 0 });
  wal.setArchiveProtector(() => true); // bucket never accepts anything again

  const warnings = await captureWarnings(async () => {
    for (let i = 0; i < 5; i++) rotate(wal);
  });

  try {
    assert.equal(segments(dir).length, 1, 'the keep count stays the floor while unshipped');
    assert.equal(warnings.length, 1, 'the valve warns exactly once (rate limited)');
    assert.match(warnings[0], /protection budget exhausted/);
  } finally {
    wal.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a generous protect budget retains every unshipped segment', () => {
  const dir = resolve('./test_wal_protect_generous_db');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const wal = new WriteAheadLog(dir, 'full', 10, { archiveKeepCount: 1, archiveProtectMaxBytes: 8 * 1024 * 1024 });
  wal.setArchiveProtector(() => true);

  try {
    for (let i = 0; i < 5; i++) rotate(wal);
    const kept = segments(dir);
    const bytes = kept.reduce((acc, n) => acc + segmentBytes(dir, n), 0);
    assert.equal(kept.length, 5, 'all unshipped segments fit in the budget, so all are kept');
    assert.ok(bytes <= 8 * 1024 * 1024, `retained ${bytes} bytes must stay within the budget`);
  } finally {
    wal.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('live backup keeps WAL that the bucket has not accepted (S3 outage)', async () => {
  const dir = resolve('./test_wal_live_outage_db');
  rmSync(dir, { recursive: true, force: true });

  // Every single S3 call fails: the shipper can never advance its shipped LSN.
  const attemptedKeys = [];
  const failingS3 = {
    send: async (command) => {
      attemptedKeys.push(command?.input?.Key ?? 'unknown');
      throw new Error('S3 unreachable (simulated outage)');
    },
  };

  const db = new Tero({
    directory: dir,
    synchronous: 'normal',
    cacheSize: 50,
    archiveKeepCount: 2, // old-retention shape: only 2 segments would normally survive
    backup: {
      format: 'individual',
      cloudStorage: { bucket: 'retention-test', region: 'us-east-1' },
      customS3Client: failingS3,
    },
    liveBackup: { consistency: 'per-second', intervalMs: 1000, nodeId: 'retention-test' },
  });

  try {
    // Four ~1MB documents => at least four rotations, none of them shippable.
    for (let i = 0; i < 4; i++) {
      await db.create(`big:${i}`, { blob: 'x'.repeat(1024 * 1024) });
      db.acidEngine.getWAL().forceFlush();
    }

    assert.ok(
      await waitFor(() => segments(dir).length >= 3, 5000),
      `expected >=3 retained segments, saw ${segments(dir).length}`,
    );
    assert.ok(
      segments(dir).length > 2,
      'live backup must hold back pruning of unshipped segments during an outage',
    );

    // The outage is visible, not silent.
    assert.ok(
      await waitFor(() => {
        const status = db.getLiveBackupStatus();
        return status.state === 'degraded' || status.errorCount > 0;
      }, 5000),
      `live backup status must surface the outage, got ${JSON.stringify(db.getLiveBackupStatus())}`,
    );
    assert.ok(attemptedKeys.length > 0, 'the shipper must actually have tried to upload');

    // Disabling live backup detaches the protector, so retention resumes.
    db.disableLiveBackup();
    await db.create('big:after', { blob: 'x'.repeat(1024 * 1024) });
    db.acidEngine.getWAL().forceFlush();
    assert.ok(
      await waitFor(() => segments(dir).length <= 2, 5000),
      `retention must resume once live backup is off, saw ${segments(dir).length}`,
    );

    // And the documents themselves are intact.
    assert.deepEqual(await db.get('big:0'), { blob: 'x'.repeat(1024 * 1024) });
  } finally {
    try { db.destroy(); } catch { /* already destroyed */ }
    rmSync(dir, { recursive: true, force: true });
  }
});


test('truncateLog force-wipes archives even while the protector says unshipped', () => {
  const dir = resolve('./test_wal_truncate_db');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const wal = new WriteAheadLog(dir, 'full', 10, { archiveKeepCount: 1 });
  wal.setArchiveProtector(() => true);
  try {
    for (let i = 0; i < 4; i++) rotate(wal);
    assert.equal(segments(dir).length, 4);

    wal.truncateLog();
    assert.equal(segments(dir).length, 0, 'an explicit truncate discards archived history');
  } finally {
    wal.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid archiveKeepCount falls back to the default instead of disabling retention', () => {
  for (const bad of [0, -5, Number.NaN]) {
    const dir = resolve('./test_wal_keep_invalid');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const wal = new WriteAheadLog(dir, 'full', 10, { archiveKeepCount: bad });
    try {
      for (let i = 0; i < 4; i++) rotate(wal);
      assert.equal(segments(dir).length, 4, `archiveKeepCount=${bad} must fall back, not prune everything`);
    } finally {
      wal.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
