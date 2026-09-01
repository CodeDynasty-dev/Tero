# Roadmap 5 — Segment Storage Engine: eliminating the file-count ceiling

**Status:** Draft · **Created:** 2026-08-31 · **Scope:** `src/acid-engine.ts` (data-file materialization), `src/index.ts` (config + existence path), `src/recovery.ts` (hydration), `src/backup.ts` (snapshot units)
**Depends on:** `partitionedPath()` (2026-08) · `roadmap4.md` (WAL shipping) · measured baseline in `local_tests/capacity-probe.mjs` (this document's numbers are real, not projected)

---

## 0. TL;DR

Tero's durability layer is already correct and already log-structured: the WAL is the durable copy and data files are a checkpointed cache ("SQLite WAL-mode architecture", `src/acid-engine.ts:777-782`). But the checkpoint cache is materialized as **one file per document** (`partitionedPath`, `src/acid-engine.ts:679`), which prices every operation in per-file syscalls. Measured on this codebase (2026-08-31, `capacity-probe.mjs`, durability `off`, 150-byte docs, Apple APFS):

| Symptom | Measured |
|---|---|
| Ingest burst (buffered in RAM) | **21,126 docs/s** |
| The flush that drains the buffer | **~750–1,300 files/s** — 20× slower than ingest |
| Consequence | Event loop blocks for entire minutes (one 5k batch measured at **11 ops/s** including a ~455s stall); backlog can never catch up |
| Disk floor | **4.4 KB per 150-byte doc (~30× amplification)** — 11,513 files = 50.6 MB |
| Crash recovery | Full-DB rewrite: 5k docs 6.9s, 10k 7.6s, 50k 25.5s (bench) → **1M docs ≈ 13–22 minutes**, event-loop blocked |
| Backup | O(docs) objects — the exact cost trap `roadmap4.md` removed for shipping, still present for first-enable and compaction uploads |

This roadmap replaces file-per-document with **append-only segment files + an in-memory key index + background compaction**. The WAL, the two-phase-locking ACID layer, the transaction semantics, and the `synchronous` contract do not change. Only the materialization layer changes — which is where 100% of the ceiling lives.

**Targets (all falsifiable, asserted in CI):**

| Metric | Today (measured) | After |
|---|---|---|
| Sustained ingest at 1M docs | ~1k docs/s with multi-minute stalls | **≥20k docs/s, no stall >50 ms** |
| p99 write latency | unbounded (stall outliers) | **<10 ms** at any DB size |
| Crash recovery at 1M docs | ~13–22 min (full rewrite) | **<5 s** (WAL-since-checkpoint only) |
| Disk amplification | ~30× | **<2× payload** |
| First-enable backup of 1M docs | ~1M PUTs | **≤64 PUTs** (128 MB segments) |
| `keys()` / `count()` | impossible (no API; disk walk only) | **O(active keys) from index** |

Non-goals: SQL, secondary indexes (a hook is left, nothing more), compression (stretch), multi-process writes beyond the existing `fileLock`.

---

## 1. Where the ceiling actually is (no line of code enforces it)

There is no doc-count constant anywhere in `src/`. The ceiling is emergent from four code paths that all scale with **file count ≡ document count**:

1. **`partitionedPath` (`acid-engine.ts:679-692`)** — every key becomes exactly one `.json` file under a 256×256 leaf tree. The partitioning did its job (readdir degradation is deferred past ~65k leaves/doc-count) but cannot reduce the *number of files*, which is the real cost driver.
2. **`flushCommittedBuffer` (`acid-engine.ts:1480-1508`)** — every committed doc is `JSON.stringify` (2nd time — it was already stringified into the WAL) + `open(tmp)` + `write` + `rename`, plus `fsync` of the file **and of every touched directory** in `full` mode (`:1503-1507`). Driven by a 50 ms `setInterval` that runs in **every** mode including `off` (`:823`). This is the loop a stack sample catches when the process appears wedged: `uv_fs_open → uv_fs_write → uv_fs_rename`.
3. **`performCrashRecovery` (`acid-engine.ts:866-935`)** — redo rewrites **every committed document** through the same per-file path (`redoOperation`, `:926-935`). Recovery time = `docs ÷ ~1,000/s`, independent of data size.
4. **O(files) enumeration** — `walkPartitions` (`acid-engine.ts:700-729`) streams the whole tree for `verifyDataIntegrity` and all backup enumeration; the public API has no `keys()`/`count()` at all, so the database cannot enumerate its own keys except by walking the filesystem.

## 2. Design

### 2.1 Segment data files

Append-only files under `<dir>/segments/seg-<startLSN>.log`. Record format (v1, deliberately boring):

```
[4B length][4B crc32][keyLen:2B][key][payload json]   — length-prefixed, CRC'd
```

- **Flush = one append.** `flushCommittedBuffer` serializes the entire `committedBuffer` batch into a single buffer → one `writeSync` → one `fsync` (full mode) → one index update loop (pure memory). 5,000 docs go from ~15,000 syscalls to **2**. The `atomicWriteFile` tmp+rename dance disappears entirely; torn-tail risk is handled by CRC + WAL authority (§2.3).
- **In-memory index:** `key → {segId, off, len}` (+ tombstone set). Maintained at flush time; also consulted by `exists()` (`index.ts:940-955`) and `create()`'s existence check (`index.ts:824`) — both lose their `existsSync` slow path. Memory: plain `Map` ≈ 150 B/key → 1M keys ≈ 150 MB (fits today's node targets); **compact variant** (interned key-IDs + `Uint32Array` postings) ≈ 50–64 B/key → 1M keys ≈ 60 MB (fits the PRD's 256 MB edge budget). Ship plain Map first, compact index as Phase 5.
- **Reads:** cache-miss path = one positioned read (`pread`) at `(off, len)` + `JSON.parse`. Fewer syscalls than today (no 3-level directory resolution), identical O(1).
- **Rotation:** active segment rolls at `segmentSizeMB` (default 128). Closed segments are immutable — this is what makes backup and compaction cheap.

### 2.2 Checkpoint-LSN recovery

Each segment flush records `flushedThroughLSN` (header of next segment / manifest). `performCrashRecovery` then replays **only WAL entries with `LSN > flushedThroughLSN`** — the `CHECKPOINT` entry mechanism already exists in `rotateLog` (`acid-engine.ts:312-314`); segments simply become the checkpoint. Recovery time = "recent writes since last 50 ms tick," not "whole database." The 13–22-minute 1M-doc redo becomes **<5 s** at any DB size.

### 2.3 Crash model (unchanged trust, new mechanics)

The WAL remains the only durability authority — exactly the contract documented at `acid-engine.ts:777-782`. A crash can leave a torn tail in the active segment; on open, the loader validates records back-to-front via length+CRC, truncates at the first bad record, and WAL replay from `flushedThroughLSN` rewrites anything newer. Data files were already "a checkpointed cache rebuilt via redo on crash" — they just become a *correct and cheap* one.

### 2.4 Compaction

Background (tick-budgeted, I/O-capped per event-loop slice): when tombstone ratio > 20% or live-bytes-per-segment < 60%, rewrite live records into a fresh segment, update index entries in one swap, unlink old segment. Write amplification bounded ≈ 2× payload; disk floor drops from 4.4 KB/doc to ~1.1× payload. Compaction work is throttled (e.g., ≤8 MB per 50 ms tick) so p99 write latency stays flat.

### 2.5 Backup / hydration / enumeration

- **Snapshot = closed segments + manifest** (few objects for any doc count). First-enable backup of 1M docs: ~8 multipart PUTs, not 1M PUTs — the `roadmap4` economics now hold end-to-end. Incremental checkpoints keep using `takeDirtyKeys` (`acid-engine.ts:802`) → changed-key lists, but now re-materialize only touched segments' deltas.
- **`hydrateOnStartup: 'snapshot'` (`index.ts:140-151`)** downloads segments directly; `DataRecovery` stops writing one file per document on restore.
- **New API:** `keys()`, `count()`, `iterate()` served from the index — O(active keys), no filesystem walk. `walkPartitions` remains only for legacy migration (§3).

### 2.6 Config surface

```ts
// TeroConfig (index.ts:107)
engine?: 'file' | 'segment'        // default 'file' in 0.0.x; 'segment' default in 1.0
segmentSizeMB?: number             // default 128
indexCompact?: boolean             // Phase 5; default false
```

`synchronous: 'full' | 'normal' | 'off'` (`index.ts:107-119`) maps onto segment fsyncs 1:1 (per append / per timer / never). The `TERO_ALLOW_UNSAFE_OFF` guard (`index.ts:369-371`) is untouched.

---

## 3. Migration (zero-copy, non-breaking)

1. `engine: 'segment'` on an existing directory triggers a one-time import: `walkPartitions` (already streaming, `acid-engine.ts:700`) reads every legacy doc → one bulk append into segments → manifest written → legacy tree renamed `<dir>/legacy-<ts>/` and kept until first verified compaction. Progress + resumability via the existing manifest patterns in `backup.ts`.
2. WAL is replayed per the normal engine boot after import — no replay loss (same guarantee `upgrade3.md` §4 relies on for sharding moves).
3. Rollback = delete `segments/` + restore the renamed tree; `engine: 'file'` keeps working through 1.x.

---

## 4. Phases

| Phase | Deliverable | Effort | Exit criterion |
|---|---|---|---|
| 0 (done) | Baseline harness: `local_tests/capacity-probe.mjs` | — | Reproducible stall + amplification numbers (§0) |
| 1 | Segment files + batched flush + Map index behind `engine: 'segment'` | 2–3 wk | Probe at 1M docs: ≥20k docs/s sustained, zero stall >50 ms |
| 2 | Checkpoint-LSN recovery + torn-tail CRC validation | 1–2 wk | `kill -9` at 1M docs → recovered <5 s; chaos suite green |
| 3 | Compaction + disk-amplification bound | 1–2 wk | Probe: <2× payload floor after 2× churn; p99 flat |
| 4 | Segment-aware snapshot/hydrate + `keys()`/`count()`/`iterate()` | 1–2 wk | MinIO test: 1M-doc first-enable ≤64 PUTs; hydration O(segments) |
| 5 | Compact index + legacy migration tool + default flip + CI capacity gate | 2 wk | 1M keys <64 MB RSS; `npm test` includes the 1M-doc gate |

Total: ~8–11 weeks. Phases 1–2 alone kill the production blockers (stalls + recovery); 3–5 are economics and polish.

---

## 5. Verification (extends `local_tests/` + existing MinIO harness)

1. **Capacity gate (CI):** the probe promoted to an assertion suite — 1M docs, durability `normal`: sustained ≥20k docs/s, no batch stall >50 ms, RSS within budget, disk ≤2× payload.
2. **Recovery:** `kill -9` mid-flush at 1M docs (three checkpoints of recency) → assert <5 s and 100% committed-tx survival (extends `chaos-test.js` SIGKILL harness).
3. **Torn tail:** corrupt the last record of a segment file on disk → open truncates cleanly, WAL replay restores the tail, `verifyDataIntegrity` healthy.
4. **Compaction correctness:** post-compaction state byte-equivalent (per key) to pre-compaction; tombstones actually reclaim.
5. **Backup cost contract:** MinIO access log asserts PUTs ≤ segments+ε for first-enable and per-checkpoint (the §0 headline, in the spirit of `roadmap4.md` §7.1).
6. **Soak:** 24 h mixed 1k ops/s with hourly `kill -9` (protocol from `roadmap4.md` §9) — flat RSS, flat FDs, zero corruption.

---

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Index memory on the 256 MB edge budget | Phase-5 compact index (~60 B/key); documented formula; `indexCompact` flag; capacity gate asserts RSS |
| Compaction I/O stealing event-loop budget | Tick-budgeted rewrites (≤8 MB/50 ms); measured p99 in the gate; compaction pauses under write pressure |
| Segment tail torn-write on crash | CRC-per-record + truncate-on-open + WAL authority — the same trust model Tero already documents |
| Two-process writes | Existing `fileLock` (`index.ts:137`) unchanged; segments do not weaken it (single-writer, single append fd) |
| WAL record versioning | Adopt `roadmap4.md` open question now: explicit `v` field in segment headers (cheap, do it in Phase 1) |
| Scope creep toward a query engine | Non-goal by design; segments only remove the per-file tax. Secondary-index hook = segment-range scans, nothing more |

---

## 7. Decision asked of this document

Approve Phase 1–2 immediately (production blockers: stalls, recovery), Phase 3–5 behind the 1.0 default-flip. The engine's own architecture comment (`acid-engine.ts:777-782`) already promises "the WAL is the durable copy; data files are a checkpointed cache" — this roadmap makes the implementation keep that promise at 10⁶–10⁷ documents per node, with every number in §0 measured against today's code and every number in the targets column asserted in CI.


---
