// Capacity probe: measure real behavior vs file count using the built dist.
// Isolates file-count effects with synchronous='off' (durability off, file-per-doc writes still happen).
import { Tero } from '/Users/friday/Desktop/opensource/Tero/dist/index.js';
import { execSync } from 'child_process';
import { rmSync } from 'fs';

const DIR = '/tmp/tero-capacity-probe-' + Date.now();
const TARGET = 200_000;
const MILESTONES = new Set([25_000, 50_000, 100_000, 150_000, 200_000]);

rmSync(DIR, { recursive: true, force: true });
const db = new Tero({ directory: DIR, cacheSize: 1000, synchronous: 'off' });

const rows = [];
let batchStart = process.hrtime.bigint();
let duPrev = 0;

for (let i = 1; i <= TARGET; i++) {
  await db.create(`doc-${String(i).padStart(8, '0')}`, { v: i, s: 'x'.repeat(80), t: Date.now() });
  if (MILESTONES.has(i)) {
    const now = process.hrtime.bigint();
    const dtSec = Number(now - batchStart) / 1e9;
    batchStart = now;
    const duKb = parseInt(execSync(`du -sk ${DIR}`).toString().split('\t')[0], 10);
    const deltaDisk = (duKb - duPrev) / 1024 / 25; // MB per 1k files this batch
    duPrev = duKb;
    const scanStart = process.hrtime.bigint();
    const integrity = await db.verifyDataIntegrity();
    const scanMs = Number(process.hrtime.bigint() - scanStart) / 1e6;
    rows.push({
      files: i,
      createOpsPerSec: Math.round(25_000 / dtSec),
      rssMB: Math.round(process.memoryUsage().rss / 1e6),
      diskMB: duKb / 1024,
      diskPer1kFilesMB: +deltaDisk.toFixed(2),
      scanMs: +scanMs.toFixed(0),
      integrityFiles: integrity.totalFiles,
    });
    console.log(JSON.stringify(rows[rows.length - 1]));
  }
}

// Cold-read throughput at 200k files: random keys, mostly disk path (cache=1000 of 200k)
const keys = [];
for (let i = 0; i < 10_000; i++) keys.push(`doc-${String(Math.floor(Math.random() * TARGET) + 1).padStart(8, '0')}`);
const readStart = process.hrtime.bigint();
for (const k of keys) await db.get(k);
const readSec = Number(process.hrtime.bigint() - readStart) / 1e9;

// exists() on absent keys (forces existsSync slow path through partition dirs)
const absentStart = process.hrtime.bigint();
for (let i = 0; i < 10_000; i++) db.exists(`absent-${i}`);
const absentSec = Number(process.hrtime.bigint() - absentStart) / 1e9;

console.log(JSON.stringify({
  randomReadOpsPerSec_at200k: Math.round(10_000 / readSec),
  existsAbsentOpsPerSec_at200k: Math.round(10_000 / absentSec),
  cacheHitRate: db.getCacheStats().hitRate,
}));

await db.close();
rmSync(DIR, { recursive: true, force: true });
console.log('cleaned up');
