/**
 * Tero DB — Comprehensive Benchmark Suite
 *
 * Outputs a self-contained HTML report (bench-report.html) with:
 *   - Throughput + latency percentile charts (Chart.js via CDN)
 *   - Concurrency scaling, document-size impact, cache pressure
 *   - WAL fsync cost measurement
 *   - Honest failure-mode analytics (where this model breaks)
 *
 * Usage:
 *   node bench/run-bench.js              # run all benchmarks, write bench-report.html
 *   node bench/run-bench.js --quick     # reduced iterations for a fast smoke run
 *   node bench/run-bench.js --out foo.html
 */

import { Tero } from '../dist/index.js';
import { existsSync, rmSync, readdirSync, statSync, writeFileSync } from 'fs';
import { hrtime } from 'process';
import { join } from 'path';

// ─── CLI ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
const QUICK = args.includes('--quick');
const outArg = args.indexOf('--out');
const OUT_FILE = outArg >= 0 ? args[outArg + 1] : 'bench-report.html';

const SCALE = QUICK ? 0.05 : 1;
const N = (n) => Math.max(5, Math.round(n * SCALE));

const sizes = ['tiny', 'small', 'medium', 'large'];
const counts = QUICK ? [100, 300, 600] : [100, 500, 1000, 2000];
const recoveryCounts = QUICK ? [100, 300] : [100, 500, 1000];

// ─── Helpers ──────────────────────────────────────────────────
const nanosToMs = (ns) => Number(ns) / 1e6;
const fmt = (n, d = 2) => Number(n).toFixed(d);
const fmtInt = (n) => Math.round(n).toLocaleString();

function percentile(sorted, p) {
    if (sorted.length === 0) return 0;
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[idx < 0 ? 0 : idx];
}

function calcStats(samples) {
    if (samples.length === 0) return { min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 };
    const sorted = [...samples].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    return {
        min: sorted[0],
        max: sorted[sorted.length - 1],
        mean: sum / sorted.length,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
    };
}

async function bench(fn, opts = {}) {
    const { iterations = 200, warmup = 30 } = opts;
    for (let i = 0; i < warmup; i++) await fn(i);
    if (typeof global?.gc === 'function') global.gc();

    const latencies = [];
    const memBefore = process.memoryUsage();
    for (let i = 0; i < iterations; i++) {
        const start = hrtime.bigint();
        await fn(i);
        latencies.push(nanosToMs(hrtime.bigint() - start));
    }
    const memAfter = process.memoryUsage();
    const s = calcStats(latencies);
    const elapsed = latencies.reduce((a, b) => a + b, 0);
    return {
        ops: iterations,
        totalMs: elapsed,
        opsPerSec: iterations / (elapsed / 1000),
        avgMs: s.mean,
        p50Ms: s.p50,
        p95Ms: s.p95,
        p99Ms: s.p99,
        minMs: s.min,
        maxMs: s.max,
        heapDeltaMB: (memAfter.heapUsed - memBefore.heapUsed) / (1024 * 1024),
        latencies,
    };
}

function makeDoc(size) {
    switch (size) {
        case 'tiny':
            return { k: Math.random().toString(36).slice(2, 6), v: Math.random() };
        case 'small':
            return {
                id: Math.random().toString(36).slice(2),
                name: `item_${Math.random().toString(36).slice(2, 8)}`,
                value: +(Math.random() * 1000).toFixed(2),
                tags: [Math.random().toString(36).slice(2, 6)],
                active: Math.random() > 0.5,
            };
        case 'medium':
            return {
                id: Math.random().toString(36).slice(2),
                name: `prod_${Math.random().toString(36).slice(2, 10)}`,
                desc: 'Lorem ipsum '.repeat(15),
                price: +(Math.random() * 999).toFixed(2),
                inventory: ~~(Math.random() * 500),
                tags: Array.from({ length: 8 }, () => Math.random().toString(36).slice(2, 6)),
                meta: { created: Date.now(), rating: +(Math.random() * 5).toFixed(1) },
            };
        case 'large':
            return {
                id: Math.random().toString(36).slice(2),
                body: 'Lorem ipsum dolor sit amet. '.repeat(60),
                items: Array.from({ length: 50 }, (_, i) => ({
                    idx: i,
                    text: `item_${i}_${Math.random().toString(36).slice(2, 8)}`,
                    val: Math.random() * 10000,
                })),
                nested: Array.from({ length: 3 }, () => ({
                    l2: Array.from({ length: 3 }, () => ({
                        l3: { a: Math.random(), b: Array.from({ length: 10 }, () => Math.random()) },
                    })),
                })),
            };
        default:
            return {};
    }
}

// ─── Benchmark Suite ──────────────────────────────────────────

async function runBenchmarks() {
    console.log('Tero DB — Benchmark Suite');
    console.log(`Node ${process.version} | ${process.platform} ${process.arch} | QUICK=${QUICK}\n`);

    const env = {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        date: new Date().toISOString(),
        quick: QUICK,
    };

    const TEST_DIR = 'BenchDB';
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    const db = new Tero({ directory: TEST_DIR, cacheSize: 500 });

    const suites = {};
    const totalStart = hrtime.bigint();

    // ── Suite 1: Write Throughput ─────────────────────────────
    console.log('[1/8] Write throughput...');
    suites.write = {};

    suites.write.single_create = await bench(async (i) => {
        await db.create(`w_single_${i}`, makeDoc('tiny'));
    }, { iterations: N(500), warmup: 20 });

    suites.write.batch_create = await bench(async (i) => {
        const ops = [];
        for (let j = 0; j < 100; j++) ops.push({ key: `w_batch_${i}_${j}`, data: makeDoc('tiny') });
        await db.batchWrite(ops);
    }, { iterations: N(10), warmup: 2 });

    suites.write.update = await bench(async (i) => {
        await db.update(`w_single_${i % 200}`, makeDoc('small'));
    }, { iterations: N(300), warmup: 20 });

    // ── Suite 2: Read Throughput ──────────────────────────────
    console.log('[2/8] Read throughput...');
    suites.read = {};

    // Seed keys using batchWrite for speed
    {
        const batch = [];
        for (let i = 0; i < N(500); i++) batch.push({ key: `w_single_${i}`, data: makeDoc('tiny') });
        for (let b = 0; b < batch.length; b += 100) await db.batchWrite(batch.slice(b, b + 100));
    }
    const readKeys = Array.from({ length: N(500) }, (_, i) => `w_single_${i}`);

    // Warm the cache with one key
    const hotKey = readKeys[0];
    await db.get(hotKey);
    suites.read.hot = await bench(async () => {
        await db.get(hotKey);
    }, { iterations: N(300), warmup: 30 });

    suites.read.cold_random = await bench(async (i) => {
        await db.get(readKeys[Math.floor(Math.random() * readKeys.length)]);
    }, { iterations: N(300), warmup: 30 });

    suites.read.batch = await bench(async (i) => {
        const keys = [];
        for (let j = 0; j < 100; j++) keys.push(readKeys[(i * 100 + j) % readKeys.length]);
        await db.batchRead(keys);
    }, { iterations: N(5), warmup: 2 });

    suites.read.exists = await bench(async (i) => {
        db.exists(readKeys[i % readKeys.length]);
    }, { iterations: N(500), warmup: 30 });

    // ── Suite 3: Transaction Throughput ────────────────────────
    console.log('[3/8] Transaction throughput...');
    suites.transaction = {};

    // Batch seed tx_ keys 0-99
    {
        const batch = [];
        for (let i = 0; i < 100; i++) if (!db.exists(`tx_${i}`)) batch.push({ key: `tx_${i}`, data: makeDoc('small') });
        for (let b = 0; b < batch.length; b += 100) await db.batchWrite(batch.slice(b, b + 100));
    }

    suites.transaction.single_write_commit = await bench(async (i) => {
        const tx = db.beginTransaction();
        await tx.update(`tx_${i % 100}`, makeDoc('small'));
        await db.commitTransaction(tx.getId());
    }, { iterations: N(200), warmup: 20 });

    suites.transaction.multi_write_commit = await bench(async (i) => {
        const tx = db.beginTransaction();
        await tx.update(`tx_${i % 50}`, makeDoc('small'));
        await tx.update(`tx_${(i + 50) % 100}`, makeDoc('small'));
        await db.commitTransaction(tx.getId());
    }, { iterations: N(150), warmup: 10 });

    suites.transaction.rollback = await bench(async (i) => {
        const tx = db.beginTransaction();
        await tx.update(`tx_${i % 100}`, makeDoc('small'));
        await db.rollbackTransaction(tx.getId());
    }, { iterations: N(200), warmup: 20 });

    // ── Suite 4: Document Size Impact ────────────────────────
    console.log('[4/8] Document size impact...');
    suites.docSize = {};
    for (const size of sizes) {
        const key = `docsize_${size}`;
        if (!db.exists(key)) await db.create(key, makeDoc(size));
        for (let i = 0; i < 10; i++) await db.get(key);
        suites.docSize[`read_${size}`] = await bench(async () => {
            await db.get(key);
        }, { iterations: N(200), warmup: 20 });
        suites.docSize[`write_${size}`] = await bench(async () => {
            await db.update(key, makeDoc(size));
        }, { iterations: N(100), warmup: 10 });
    }

    // ── Suite 5: Concurrency Scaling ─────────────────────────
    console.log('[5/8] Concurrency scaling...');
    suites.concurrency = [];
    const CONCUR_KEYS = 100;
    {
        const batch = [];
        for (let j = 0; j < CONCUR_KEYS; j++) batch.push({ key: `c_${j}`, data: makeDoc('tiny') });
        await db.batchWrite(batch);
    }
    const TOTAL_CONCUR_OPS = N(400);
    for (const c of [1, 5, 10, 25, 50]) {
        const opsPerWorker = Math.max(1, Math.floor(TOTAL_CONCUR_OPS / c));
        const start = hrtime.bigint();
        const workers = Array.from({ length: c }, async () => {
            for (let i = 0; i < opsPerWorker; i++) {
                const k = `c_${Math.floor(Math.random() * CONCUR_KEYS)}`;
                if (Math.random() > 0.5) await db.get(k);
                else await db.update(k, makeDoc('tiny'));
            }
        });
        await Promise.all(workers);
        const ms = nanosToMs(hrtime.bigint() - start);
        suites.concurrency.push({
            concurrency: c,
            ops: c * opsPerWorker,
            totalMs: ms,
            opsPerSec: (c * opsPerWorker) / (ms / 1000),
        });
    }

    // ── Suite 6: Cache Pressure ───────────────────────────────
    console.log('[6/8] Cache pressure...');
    suites.cache = {};
    const CACHE_KEYS = 1000;
    // Batch seed cache keys for speed
    for (let b = 0; b < CACHE_KEYS; b += 100) {
        const batch = [];
        for (let j = b; j < Math.min(b + 100, CACHE_KEYS); j++) {
            batch.push({ key: `ch_${j}`, data: makeDoc('small') });
        }
        await db.batchWrite(batch);
    }
    suites.cache.random_beyond_size = await bench(async () => {
        await db.get(`ch_${Math.floor(Math.random() * CACHE_KEYS)}`);
    }, { iterations: N(500), warmup: 30 });
    suites.cache.stats = db.getCacheStats();

    // ── Suite 7: Failure Mode — File Count Scaling ───────────
    console.log('[7/8] Failure mode: file count scaling...');
    suites.fileCount = {};

    // Ensure we have enough files — use batchWrite for fast seeding
    let maxCreated = 0;
    for (const target of counts) {
        if (maxCreated < target) {
            const batch = [];
            for (let i = maxCreated; i < target; i++) {
                batch.push({ key: `fcount_${i}`, data: makeDoc('tiny') });
            }
            // batchWrite in chunks of 100 to avoid huge single transactions
            for (let b = 0; b < batch.length; b += 100) {
                await db.batchWrite(batch.slice(b, b + 100));
            }
            maxCreated = target;
        }

        // Measure: list directory + stat all files
        const start = hrtime.bigint();
        const files = readdirSync(TEST_DIR).filter(f => f.endsWith('.json'));
        for (const f of files) statSync(join(TEST_DIR, f));
        const ms = nanosToMs(hrtime.bigint() - start);

        suites.fileCount[target] = {
            fileCount: files.length,
            scanMs: ms,
            perFileMs: ms / files.length,
        };
    }

    // ── Suite 8: Crash Recovery Time ──────────────────────────
    console.log('[8/8] Crash recovery time...');
    suites.recovery = {};

    for (const count of recoveryCounts) {
        const recoveryDir = `RecoveryBench_${count}`;
        if (existsSync(recoveryDir)) rmSync(recoveryDir, { recursive: true, force: true });
        const rdb = new Tero({ directory: recoveryDir, cacheSize: 100 });
        // Batch seed for speed
        for (let b = 0; b < count; b += 100) {
            const batch = [];
            for (let i = b; i < Math.min(b + 100, count); i++) {
                batch.push({ key: `r_${i}`, data: makeDoc('tiny') });
            }
            await rdb.batchWrite(batch);
        }
        rdb.destroy();

        // Now measure cold-start time (constructor runs crash recovery)
        const start = hrtime.bigint();
        const freshDb = new Tero({ directory: recoveryDir, cacheSize: 100 });
        const ms = nanosToMs(hrtime.bigint() - start);

        suites.recovery[count] = { docCount: count, recoveryMs: ms };
        freshDb.destroy();
        if (existsSync(recoveryDir)) rmSync(recoveryDir, { recursive: true, force: true });
    }

    const totalMs = nanosToMs(hrtime.bigint() - totalStart);
    console.log(`\nBenchmark complete: ${(totalMs / 1000).toFixed(1)}s\n`);

    // Gather system stats
    const finalMem = process.memoryUsage();
    const walSize = existsSync(join(TEST_DIR, '.wal'))
        ? statSync(join(TEST_DIR, '.wal')).size : 0;
    const walArchives = readdirSync(TEST_DIR).filter(f => f.startsWith('.wal.')).length;
    const dataFileCount = readdirSync(TEST_DIR).filter(f => f.endsWith('.json')).length;

    const systemStats = {
        totalMs,
        heapMB: finalMem.heapUsed / (1024 * 1024),
        rssMB: finalMem.rss / (1024 * 1024),
        walSizeMB: walSize / (1024 * 1024),
        walArchives,
        dataFileCount,
    };

    // Cleanup
    db.destroy();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });

    return { suites, env, systemStats };
}

// ─── HTML Report Generator ────────────────────────────────────

function generateHTML(data) {
    const { suites, env, systemStats } = data;

    // Extract data for charts
    const writeChartData = [
        { label: 'Single create (1 tx)', ops: suites.write.single_create.opsPerSec, p50: suites.write.single_create.p50Ms, p95: suites.write.single_create.p95Ms, p99: suites.write.single_create.p99Ms },
        { label: 'Batch create (100/tx)', ops: suites.write.batch_create.opsPerSec, p50: suites.write.batch_create.p50Ms, p95: suites.write.batch_create.p95Ms, p99: suites.write.batch_create.p99Ms },
        { label: 'Update', ops: suites.write.update.opsPerSec, p50: suites.write.update.p50Ms, p95: suites.write.update.p95Ms, p99: suites.write.update.p99Ms },
    ];

    const readChartData = [
        { label: 'Hot key (cached)', ops: suites.read.hot.opsPerSec, p50: suites.read.hot.p50Ms, p95: suites.read.hot.p95Ms, p99: suites.read.hot.p99Ms },
        { label: 'Cold random', ops: suites.read.cold_random.opsPerSec, p50: suites.read.cold_random.p50Ms, p95: suites.read.cold_random.p95Ms, p99: suites.read.cold_random.p99Ms },
        { label: 'Batch read (100)', ops: suites.read.batch.opsPerSec, p50: suites.read.batch.p50Ms, p95: suites.read.batch.p95Ms, p99: suites.read.batch.p99Ms },
        { label: 'exists() sync', ops: suites.read.exists.opsPerSec, p50: suites.read.exists.p50Ms, p95: suites.read.exists.p95Ms, p99: suites.read.exists.p99Ms },
    ];

    const txChartData = [
        { label: 'Single write + commit', ops: suites.transaction.single_write_commit.opsPerSec, p50: suites.transaction.single_write_commit.p50Ms, p95: suites.transaction.single_write_commit.p95Ms, p99: suites.transaction.single_write_commit.p99Ms },
        { label: 'Multi write + commit', ops: suites.transaction.multi_write_commit.opsPerSec, p50: suites.transaction.multi_write_commit.p50Ms, p95: suites.transaction.multi_write_commit.p95Ms, p99: suites.transaction.multi_write_commit.p99Ms },
        { label: 'Write + rollback', ops: suites.transaction.rollback.opsPerSec, p50: suites.transaction.rollback.p50Ms, p95: suites.transaction.rollback.p95Ms, p99: suites.transaction.rollback.p99Ms },
    ];

    const docSizeReadData = sizes.map(s => ({
        label: s,
        ops: suites.docSize[`read_${s}`].opsPerSec,
    }));
    const docSizeWriteData = sizes.map(s => ({
        label: s,
        ops: suites.docSize[`write_${s}`].opsPerSec,
    }));

    const concurrencyData = suites.concurrency.map(c => ({
        label: `c=${c.concurrency}`,
        ops: c.opsPerSec,
        concurrency: c.concurrency,
    }));

    const fileCountData = counts.map(c => ({
        label: `${c} files`,
        scanMs: suites.fileCount[c].scanMs,
        perFileMs: suites.fileCount[c].perFileMs,
    }));

    const recoveryData = recoveryCounts.map(c => ({
        label: `${c} docs`,
        ms: suites.recovery[c].recoveryMs,
    }));

    // Failure mode analysis values
    const fsyncCeiling = suites.transaction.single_write_commit.opsPerSec;
    const batchAmortization = (suites.write.batch_create.opsPerSec * 100) / Math.max(1, suites.write.single_create.opsPerSec);
    const hotVsColdRatio = suites.read.hot.opsPerSec / Math.max(1, suites.read.cold_random.opsPerSec);
    const rollbackVsCommit = suites.transaction.rollback.opsPerSec / Math.max(1, suites.transaction.single_write_commit.opsPerSec);
    const fileCountScale = suites.fileCount[counts[counts.length - 1]].scanMs / Math.max(1, suites.fileCount[counts[0]].scanMs);

    // Determining verdict
    const verdicts = [];
    if (fsyncCeiling < 50) verdicts.push('fsync-per-commit caps single-thread write throughput below 50 ops/s — fine for edge workloads, unsuitable for high-ingestion pipelines.');
    if (hotVsColdRatio < 1.5) verdicts.push('Cross-transaction cache misses negate the LRU cache on convenience methods; hot keys barely outperform cold reads.');
    if (fileCountScale > 5) verdicts.push('Directory scan cost scales super-linearly with file count; verifyDataIntegrity and backup will become bottlenecks beyond ~10k documents per node.');
    if (suites.concurrency[4].opsPerSec < suites.concurrency[0].opsPerSec * 1.5) verdicts.push('Sync I/O serializes through the event loop; raising concurrency does not meaningfully raise throughput.');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Tero DB — Benchmark Report</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>
<style>
  :root {
    --bg: #0d1117; --fg: #e6edf3; --card: #161b22; --border: #30363d;
    --accent: #58a6ff; --green: #3fb950; --red: #f85149; --yellow: #d29922;
    --muted: #8b949e;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; background: var(--bg); color: var(--fg); line-height: 1.6; padding: 2rem; max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 2rem; margin-bottom: 0.5rem; }
  h2 { font-size: 1.4rem; margin: 2.5rem 0 1rem; border-bottom: 1px solid var(--border); padding-bottom: 0.5rem; }
  h3 { font-size: 1.1rem; margin: 1.5rem 0 0.75rem; color: var(--accent); }
  .meta { color: var(--muted); font-size: 0.85rem; margin-bottom: 2rem; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 1.5rem; margin-bottom: 1.5rem; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
  @media (max-width: 768px) { .grid { grid-template-columns: 1fr; } }
  table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
  th, td { text-align: left; padding: 0.6rem 0.8rem; border-bottom: 1px solid var(--border); }
  th { color: var(--muted); font-weight: 600; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .stat { display: inline-block; background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 0.8rem 1.2rem; margin: 0.3rem; }
  .stat .val { font-size: 1.5rem; font-weight: 700; color: var(--accent); }
  .stat .lbl { font-size: 0.75rem; color: var(--muted); }
  .verdict { border-left: 3px solid var(--yellow); padding: 0.5rem 1rem; margin: 0.5rem 0; background: rgba(210,153,34,0.08); border-radius: 0 4px 4px 0; }
  .pass { border-left-color: var(--green); background: rgba(63,185,80,0.08); }
  .fail { border-left-color: var(--red); background: rgba(248,81,73,0.08); }
  canvas { max-height: 350px; }
  .chart-wrap { position: relative; height: 350px; }
  code { background: rgba(88,166,255,0.12); padding: 0.15rem 0.4rem; border-radius: 3px; font-size: 0.85rem; }
  .footer { margin-top: 3rem; padding-top: 1.5rem; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.8rem; }
</style>
</head>
<body>

<h1>Tero DB — Benchmark Report</h1>
<div class="meta">
  Generated ${env.date} &middot; Node ${env.node} &middot; ${env.platform}/${env.arch}
  ${env.quick ? '&middot; <strong style="color:var(--yellow)">QUICK MODE (reduced iterations)</strong>' : ''}
</div>

<h2>Executive Summary</h2>
<div class="card">
  <p>Tero is an embedded ACID JSON database for single-node edge workloads. This benchmark measures its throughput, latency, and scaling limits across 8 scenarios, with deliberate focus on <strong>where the model breaks</strong> — because the honest ceiling is more useful to a platform team than a curated win.</p>
  <br>
  <p><strong>Position:</strong> Tero trades raw throughput for real durability (fsync-on-commit) and cloud-agnostic bucket economics. It is designed forkey/value workloads inside edge/worker runtimes where a managed DB is too expensive or too lock-in. It is <em>not</em> a high-ingestion pipeline, analytics engine, or cluster replacement.</p>
  <br>
  <div>
    <div class="stat"><div class="lbl">Peak write throughput</div><div class="val">${fmtInt(fsyncCeiling)}</div></div>
    <div class="stat"><div class="lbl">Batch amortization</div><div class="val">${fmt(batchAmortization, 0)}x</div></div>
    <div class="stat"><div class="lbl">Hot/cold read ratio</div><div class="val">${fmt(hotVsColdRatio, 1)}x</div></div>
    <div class="stat"><div class="lbl">Concurrency gain (c=1→50)</div><div class="val">${fmt(suites.concurrency[4].opsPerSec / Math.max(1, suites.concurrency[0].opsPerSec), 1)}x</div></div>
  </div>
</div>

<h2>Methodology</h2>
<div class="card">
  <ul>
    <li>Each operation is individually timed with <code>hrtime.bigint()</code> (nanosecond precision).</li>
    <li>Warmup iterations are excluded; GC is forced before measurement where available.</li>
    <li>Latency percentiles (p50, p95, p99) are computed from the full sorted latency array.</li>
    <li>Concurrency tests use a worker-pool pattern with fixed in-flight op count.</li>
    <li>File-count scaling measures <code>readdirSync + statSync</code> (the path <code>verifyDataIntegrity()</code> and backup take).</li>
    <li>Recovery time measures the Tero constructor (which runs WAL crash recovery) against a freshly seeded directory.</li>
    <li>All runs are on the local filesystem; cloud/S3 paths are not measured here.</li>
  </ul>
</div>

<h2>1. Write Throughput</h2>
<div class="grid">
  <div class="card">
    <h3>Operations per second</h3>
    <div class="chart-wrap"><canvas id="chart-write"></canvas></div>
  </div>
  <div class="card">
    <table>
      <tr><th>Operation</th><th class="num">ops/s</th><th class="num">p50</th><th class="num">p95</th><th class="num">p99</th></tr>
      ${writeChartData.map(r => `<tr><td>${r.label}</td><td class="num">${fmtInt(r.ops)}</td><td class="num">${fmt(r.p50, 2)}ms</td><td class="num">${fmt(r.p95, 2)}ms</td><td class="num">${fmt(r.p99, 2)}ms</td></tr>`).join('')}
    </table>
  </div>
</div>

<h2>2. Read Throughput</h2>
<div class="grid">
  <div class="card">
    <h3>Operations per second</h3>
    <div class="chart-wrap"><canvas id="chart-read"></canvas></div>
  </div>
  <div class="card">
    <table>
      <tr><th>Operation</th><th class="num">ops/s</th><th class="num">p50</th><th class="num">p95</th><th class="num">p99</th></tr>
      ${readChartData.map(r => `<tr><td>${r.label}</td><td class="num">${fmtInt(r.ops)}</td><td class="num">${fmt(r.p50, 2)}ms</td><td class="num">${fmt(r.p95, 2)}ms</td><td class="num">${fmt(r.p99, 2)}ms</td></tr>`).join('')}
    </table>
  </div>
</div>

<h2>3. Transaction Throughput</h2>
<div class="grid">
  <div class="card">
    <h3>Operations per second</h3>
    <div class="chart-wrap"><canvas id="chart-tx"></canvas></div>
  </div>
  <div class="card">
    <table>
      <tr><th>Transaction</th><th class="num">ops/s</th><th class="num">p50</th><th class="num">p95</th><th class="num">p99</th></tr>
      <tr><td>Single write + commit</td><td class="num">${fmtInt(suites.transaction.single_write_commit.opsPerSec)}</td><td class="num">${fmt(suites.transaction.single_write_commit.p50Ms, 2)}ms</td><td class="num">${fmt(suites.transaction.single_write_commit.p95Ms, 2)}ms</td><td class="num">${fmt(suites.transaction.single_write_commit.p99Ms, 2)}ms</td></tr>
      <tr><td>Multi write + commit</td><td class="num">${fmtInt(suites.transaction.multi_write_commit.opsPerSec)}</td><td class="num">${fmt(suites.transaction.multi_write_commit.p50Ms, 2)}ms</td><td class="num">${fmt(suites.transaction.multi_write_commit.p95Ms, 2)}ms</td><td class="num">${fmt(suites.transaction.multi_write_commit.p99Ms, 2)}ms</td></tr>
      <tr><td>Write + rollback</td><td class="num">${fmtInt(suites.transaction.rollback.opsPerSec)}</td><td class="num">${fmt(suites.transaction.rollback.p50Ms, 2)}ms</td><td class="num">${fmt(suites.transaction.rollback.p95Ms, 2)}ms</td><td class="num">${fmt(suites.transaction.rollback.p99Ms, 2)}ms</td></tr>
    </table>
  </div>
</div>

<h2>4. Document Size Impact</h2>
<div class="grid">
  <div class="card">
    <h3>Read throughput by doc size</h3>
    <div class="chart-wrap"><canvas id="chart-docsize-read"></canvas></div>
  </div>
  <div class="card">
    <h3>Write throughput by doc size</h3>
    <div class="chart-wrap"><canvas id="chart-docsize-write"></canvas></div>
  </div>
</div>

<h2>5. Concurrency Scaling</h2>
<div class="card">
  <h3>Throughput vs concurrency level</h3>
  <div class="chart-wrap"><canvas id="chart-concurrency"></canvas></div>
  <p style="margin-top:1rem;color:var(--muted);font-size:0.85rem">
    Synchronous file I/O serializes through Node's event loop. Raising concurrency does not raise throughput proportionally — workers queue behind the same I/O thread. This is the fundamental scaling property of the sync-I/O model.
  </p>
</div>

<h2>6. Cache Performance</h2>
<div class="card">
  <div class="stat"><div class="lbl">Cache size</div><div class="val">${suites.cache.stats.size}</div></div>
  <div class="stat"><div class="lbl">Max cache</div><div class="val">${suites.cache.stats.maxSize}</div></div>
  <div class="stat"><div class="lbl">Hit rate</div><div class="val">${fmt(suites.cache.stats.hitRate, 1)}%</div></div>
  <div class="stat"><div class="lbl">Random read ops/s</div><div class="val">${fmtInt(suites.cache.random_beyond_size.opsPerSec)}</div></div>
</div>

<h2>7. Failure Mode Analysis — File Count Scaling</h2>
<div class="grid">
  <div class="card">
    <h3>Directory scan time vs file count</h3>
    <div class="chart-wrap"><canvas id="chart-filecount"></canvas></div>
  </div>
  <div class="card">
    <h3>Per-file scan cost</h3>
    <div class="chart-wrap"><canvas id="chart-filecount-perfile"></canvas></div>
  </div>
</div>
<div class="card">
  <table>
    <tr><th>Files</th><th class="num">Scan time</th><th class="num">Per file</th><th class="num">Scaling factor</th></tr>
    ${counts.map((c, i) => {
        const prev = i > 0 ? suites.fileCount[counts[i - 1]].scanMs : suites.fileCount[c].scanMs;
        return `<tr><td>${c}</td><td class="num">${fmt(suites.fileCount[c].scanMs, 1)}ms</td><td class="num">${fmt(suites.fileCount[c].perFileMs, 3)}ms</td><td class="num">${fmt(suites.fileCount[c].scanMs / Math.max(0.001, prev), 2)}x</td></tr>`;
    }).join('')}
  </table>
  <p style="margin-top:1rem;color:var(--muted);font-size:0.85rem">
    One-file-per-document is the foundationallimitation. <code>readdirSync</code> + <code>statSync</code> (used by <code>verifyDataIntegrity</code>, backup enumeration, and recovery) scales at best linearly and often super-linearly with file count as the directory inode grows. This caps the practical per-node document count around <strong>10⁴–10⁵</strong>; beyond that, directory operations become a measurable bottleneck.
  </p>
</div>

<h2>8. Crash Recovery Time</h2>
<div class="grid">
  <div class="card">
    <h3>Cold-start time (WAL replay) vs document count</h3>
    <div class="chart-wrap"><canvas id="chart-recovery"></canvas></div>
  </div>
  <div class="card">
    <table>
      <tr><th>Documents</th><th class="num">Recovery time</th><th class="num">Per doc</th></tr>
      ${recoveryCounts.map(c => `<tr><td>${c}</td><td class="num">${fmt(suites.recovery[c].recoveryMs, 1)}ms</td><td class="num">${fmt(suites.recovery[c].recoveryMs / c, 3)}ms</td></tr>`).join('')}
    </table>
    <p style="margin-top:1rem;color:var(--muted);font-size:0.85rem">
      Recovery time grows with the number of committed transactions in the WAL. The WAL is bounded by rotation (1 MB / 500 commits), but between rotations a crash requires replaying all pending entries. This is fast for edge workloads but would not be fast for a million-document cold start.
    </p>
  </div>
</div>

<h2>Verdicts — Where This Model Fails</h2>
<div class="card">
  ${verdicts.length === 0 ? '<div class="verdict pass">No critical failure thresholds crossed in this run.</div>' : verdicts.map(v => `<div class="verdict fail">${v}</div>`).join('')}

  <h3 style="margin-top:1.5rem">Architectural limits (not measured, but inherent):</h3>
  <div class="verdict">
    <strong>No query layer.</strong> Key-only access. No secondary indexes, range scans, or filters. Any query beyond <code>get(key)</code> is a full scan. Tero is not a replacement for a document DB with a query planner.
  </div>
  <div class="verdict">
    <strong>Single-node ceiling.</strong> No replication, no sharding, no clustering. Horizontal scale requires the caller to shard across multiple Tero instances, each with its own bucket and directory. There is no cluster coordinator.
  </div>
  <div class="verdict">
    <strong>Synchronous I/O blocks the event loop.</strong> Every read/write is a blocking fs call. While one operation is in flight, no other JS can run. This is acceptable for edge workers with bounded concurrency but caps throughput at one disk I/O's latency.
  </div>
  <div class="verdict">
    <strong>WAL before/after images amplify writes.</strong> Every write stores the full before-image AND after-image in the WAL. A 1 MB document update costs ~2 MB of WAL. This is fine for small JSON docs but pathological for large blobs.
  </div>
</div>

<h2>Context — Throughput Comparison</h2>
<div class="card">
  <table>
    <tr><th>System</th><th>Approx write ops/s</th><th>Durability model</th><th>Notes</th></tr>
    <tr><td><strong>Tero (this run)</strong></td><td class="num">${fmtInt(fsyncCeiling)}</td><td>fsync per commit</td><td>Real ACID; edge-embedded</td></tr>
    <tr><td>SQLite (WAL mode, fsync)</td><td class="num">~1,000–5,000</td><td>fsync per commit</td><td>C via FFI; packed file; decades of optimization</td></tr>
    <tr><td>Redis (single-thread, in-memory)</td><td class="num">~100,000</td><td>appendonly file (fsync configurable)</td><td>In-memory; no disk read path</td></tr>
    <tr><td>MongoDB (WiredTiger, default)</td><td class="num">~10,000–50,000</td><td>journal fsync every 100ms</td><td>Group commit; background flush; packed storage</td></tr>
    <tr><td>DynamoDB (managed)</td><td class="num">~100,000+</td><td>distributed replication</td><td>Cluster; not embedded; per-request pricing</td></tr>
  </table>
  <p style="margin-top:1rem;color:var(--muted);font-size:0.85rem">
    Tero's throughput is bounded by fsync latency, which is bounded by the disk. The numbers above are not a bug — they are the cost of real durability on a single node without group commit or background flushing. The trade-off is intentional: Tero targets edge/worker runtimes where managed DBs are too expensive and where durability-on-cheap-object-storage is the value proposition.
  </p>
</div>

<h2>System Stats</h2>
<div class="card">
  <div class="stat"><div class="lbl">Total benchmark time</div><div class="val">${fmt(systemStats.totalMs / 1000, 1)}s</div></div>
  <div class="stat"><div class="lbl">Heap used</div><div class="val">${fmt(systemStats.heapMB, 1)}MB</div></div>
  <div class="stat"><div class="lbl">RSS</div><div class="val">${fmt(systemStats.rssMB, 1)}MB</div></div>
  <div class="stat"><div class="lbl">WAL size</div><div class="val">${fmt(systemStats.walSizeMB, 2)}MB</div></div>
  <div class="stat"><div class="lbl">WAL archives</div><div class="val">${systemStats.walArchives}</div></div>
  <div class="stat"><div class="lbl">Data files</div><div class="val">${systemStats.dataFileCount}</div></div>
</div>

<div class="footer">
  Generated by <code>bench/run-bench.js</code> &middot; Tero DB &middot; ${env.date}
</div>

<script>
const DATA = {
  write: ${JSON.stringify(writeChartData)},
  read: ${JSON.stringify(readChartData)},
  tx: ${JSON.stringify(txChartData)},
  docSizeRead: ${JSON.stringify(docSizeReadData)},
  docSizeWrite: ${JSON.stringify(docSizeWriteData)},
  concurrency: ${JSON.stringify(concurrencyData)},
  fileCount: ${JSON.stringify(fileCountData)},
  recovery: ${JSON.stringify(recoveryData)},
};

const colors = ['#58a6ff', '#3fb950', '#d29922', '#f85149', '#a371f7', '#ff7b72'];
const baseOpts = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { display: false } },
  scales: {
    y: { beginAtZero: true, ticks: { color: '#8b949e' }, grid: { color: '#30363d' } },
    x: { ticks: { color: '#8b949e' }, grid: { display: false } }
  }
};

function barChart(id, data, label) {
  const ctx = document.getElementById(id);
  if (!ctx) return;
  new Chart(ctx, {
    type: 'bar',
    data: {
      labels: data.map(d => d.label),
      datasets: [{
        label,
        data: data.map(d => d.ops),
        backgroundColor: colors.slice(0, data.length),
        borderRadius: 4,
      }]
    },
    options: { ...baseOpts, plugins: { legend: { display: false }, tooltip: { callbacks: { afterLabel: (c) => 'p50: ' + data[c.dataIndex].p50.toFixed(2) + 'ms' } } } }
  });
}

function lineChart(id, data, valueKey, label, color) {
  const ctx = document.getElementById(id);
  if (!ctx) return;
  new Chart(ctx, {
    type: 'line',
    data: {
      labels: data.map(d => d.label),
      datasets: [{
        label,
        data: data.map(d => d[valueKey]),
        borderColor: color || colors[0],
        backgroundColor: (color || colors[0]) + '22',
        fill: true,
        tension: 0.3,
        pointRadius: 4,
      }]
    },
    options: baseOpts
  });
}

barChart('chart-write', DATA.write, 'ops/s');
barChart('chart-read', DATA.read, 'ops/s');
barChart('chart-tx', DATA.tx, 'ops/s');
barChart('chart-docsize-read', DATA.docSizeRead, 'ops/s');
barChart('chart-docsize-write', DATA.docSizeWrite, 'ops/s');
lineChart('chart-concurrency', DATA.concurrency, 'ops', 'ops/s', '#58a6ff');
lineChart('chart-filecount', DATA.fileCount, 'scanMs', 'scan time (ms)', '#f85149');
lineChart('chart-filecount-perfile', DATA.fileCount, 'perFileMs', 'per-file (ms)', '#d29922');
lineChart('chart-recovery', DATA.recovery, 'ms', 'recovery time (ms)', '#3fb950');
</script>

</body>
</html>`;

    return html;
}

// ─── Main ─────────────────────────────────────────────────────

async function main() {
    const data = await runBenchmarks();
    const html = generateHTML(data);
    writeFileSync(OUT_FILE, html);
    console.log(`Report written to ${OUT_FILE}`);
    console.log(`Open in browser: file://${join(process.cwd(), OUT_FILE)}`);
}

main().catch((err) => {
    console.error('Benchmark failed:', err);
    process.exit(1);
});