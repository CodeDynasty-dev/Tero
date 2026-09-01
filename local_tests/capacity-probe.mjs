// Capacity probe v2: fine-grained milestones, live progress, no external subprocesses.
// synchronous='off' isolates file-count effects (durability off; per-file tmp+rename writes still happen via the 50ms flush timer, which runs in ALL modes — acid-engine.ts:823).
import { Tero } from '/Users/friday/Desktop/opensource/Tero/dist/index.js';
import { rmSync, readdirSync } from 'fs';

const DIR = '/tmp/tero-capacity-probe2';
const TARGET = 50_000;
const STEP = 5_000;
const MILESTONES = new Set();
for (let m = STEP; m <= TARGET; m += STEP) MILESTONES.add(m);

function countFiles(dir) {
  let n = 0;
  for (const a of readdirSync(dir, { withFileTypes: true })) {
    if (!a.isDirectory()) continue;
    for (const b of readdirSync(dir + '/' + a.name, { withFileTypes: true })) {
      if (!b.isDirectory()) continue;
      n += readdirSync(dir + '/' + a.name + '/' + b.name).length;
    }
  }
  return n;
}

rmSync(DIR, { recursive: true, force: true });
const db = new Tero({ directory: DIR, cacheSize: 1000, synchronous: 'off' });

let batchStart = process.hrtime.bigint();
const log = (obj) => console.log(JSON.stringify(obj));

for (let i = 1; i <= TARGET; i++) {
  await db.create(`doc-${String(i).padStart(8, '0')}`, { v: i, s: 'x'.repeat(80), t: Date.now() });
  if (MILESTONES.has(i)) {
    const now = process.hrtime.bigint();
    const dtSec = Number(now - batchStart) / 1e9;
    batchStart = now;
    log({
      files: i,
      createOpsPerSec: Math.round(STEP / dtSec),
      rssMB: Math.round(process.memoryUsage().rss / 1e6),
      actualFiles: countFiles(DIR),
    });
  }
}

// Full-partition scan (verifyDataIntegrity) at 50k files
const scanStart = process.hrtime.bigint();
const integrity = await db.verifyDataIntegrity();
const scanMs = Number(process.hrtime.bigint() - scanStart) / 1e6;
log({ scanAt50k: { totalFiles: integrity.totalFiles, scanMs: +scanMs.toFixed(0) } });

// Random cold-ish reads at 50k files (cache=1000 → ~98% miss to disk)
const keys = [];
for (let i = 0; i < 5_000; i++) keys.push(`doc-${String(Math.floor(Math.random() * TARGET) + 1).padStart(8, '0')}`);
const readStart = process.hrtime.bigint();
for (const k of keys) await db.get(k);
const readSec = Number(process.hrtime.bigint() - readStart) / 1e9;
log({ randomReadOpsPerSec_at50k: Math.round(5_000 / readSec), cacheHitRate: +db.getCacheStats().hitRate.toFixed(3) });

// exists() on absent keys — pure existsSync through partition path
const absentStart = process.hrtime.bigint();
for (let i = 0; i < 10_000; i++) db.exists(`absent-${i}`);
const absentSec = Number(process.hrtime.bigint() - absentStart) / 1e9;
log({ existsAbsentOpsPerSec_at50k: Math.round(10_000 / absentSec) });

// batchWrite (100 docs/tx — the amortized path) on top of existing 50k files
const bwStart = process.hrtime.bigint();
const ops = [];
for (let i = 0; i < 100; i++) ops.push({ key: `bw-${Date.now()}-${i}`, data: { v: i, s: 'y'.repeat(80) } });
for (let round = 0; round < 20; round++) {
  for (const op of ops) op.key = `bw-${round}-${op.key.split('-').pop()}`;
  await db.batchWrite(ops.map(o => ({ key: o.key + '-' + round, data: o.data })));
}
const bwSec = Number(process.hrtime.bigint() - bwStart) / 1e9;
log({ batchWriteDocsPerSec_at50k: Math.round(2000 / bwSec) });

await db.close();
rmSync(DIR, { recursive: true, force: true });
log({ done: true });

