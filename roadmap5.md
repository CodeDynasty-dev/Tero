# Roadmap 5 — Segment Storage Engine: eliminating the file-count ceiling

**Status:** Revised Draft · **Created:** 2026-08-31 · **Revised:** 2026-09-01 · **Scope:** `src/acid-engine.ts` (data-file materialization), `src/index.ts` (config + existence path + API), `src/recovery.ts` (hydration), `src/backup.ts` (snapshot units), `src/manifest.ts` (new)
**Depends on:** `partitionedPath()` (2026-08) · `roadmap4.md` (WAL shipping — see §2.6 for namespace split) · `local_tests/capacity-probe.mjs` (baseline harness — see §0 caveat)

---

## 0. TL;DR — with measurement caveats (review 2026-09-01)

Tero's durability layer is log-structured: WAL is the durable copy, data files are a checkpointed cache (`src/acid-engine.ts:777-782`). The cache is materialized as **one file per document** (`partitionedPath`, `src/acid-engine.ts:679`), pricing every operation in per-file syscalls. The ceiling is real; the exact headline numbers need re-baselining.

**What the current probe actually measures** (`local_tests/capacity-probe.mjs:1-79`, `TARGET=50_000`, `synchronous:'off'`, Apple APFS):
- Ingest burst (committedBuffer RAM) ~21k docs/s; flush drain ~750–1,300 files/s (20× slower) — measured, reproducible.
- Event-loop stalls of minutes under burst — measured (one 5k batch ~455s wall includes fsync-of-directory stalls).
- File counts via `readdirSync` walks.

**What the probe does NOT measure (remove "real, not projected" claim):**
- Disk amplification 4.4KB/150B doc (~30×, 50.6MB for 11,513 files) — needs `du -sk` / `statfs` accounting, filesystem-dependent (APFS ≠ ext4). Re-measure on ext4.
- Crash recovery 5k 6.9s / 10k 7.6s / 50k 25.5s → "1M≈13–22min" — no kill/recovery harness in probe; bench is uncited. Must re-baseline (see A2). Recovery today streams only the current `.wal` (`src/acid-engine.ts:163,866-894`, `LOG_FILE_SIZE_LIMIT=1MB` `src/acid-engine.ts:44`) and `ARCHIVE_KEEP_COUNT=3` `src/acid-engine.ts:45`; with `flushCommittedBuffer(true)` before `rotateLog` (`src/acid-engine.ts:1343-1347`) archived entries are already materialized — recovery is O(current WAL ≈ ≤1 MB + unflushed `committedBuffer`), **not** O(docs). Auto-rotation path (see §2.2a) is the only loss window.

This roadmap replaces file-per-document with **append-only segment files + in-memory key index + persisted index snapshot + background compaction**. WAL, 2PL, transaction semantics, and `synchronous` contract are unchanged; only materialization changes.

**Targets (falsifiable, asserted in CI — mode-qualified):**

| Metric | Today (re-baseline in Phase 0) | After (CI-gated) |
|---|---|---|
| Sustained ingest at 1M docs (`synchronous:'normal'`) | ~1k docs/s with stalls (re-measure) | **≥20k docs/s, no flush stall >50 ms** (`DATA_FLUSH_INTERVAL_MS=50` `src/acid-engine.ts:785`) |
| p99 write latency | unbounded (flush outliers) | **<10 ms in `normal`/`off`; <25 ms in `full`** (fsync-bound — qualify by mode) |
| Crash recovery at 1M docs (`full`, 50ms checkpoint) | re-baseline (see §5.2) | **WAL-since-checkpoint only; index rebuild + replay <5 s** (see §2.2+2.4) |
| Disk amplification | ~30× on APFS (re-measure on ext4) | **<2× payload** (amortized block waste); post-compaction ~1.1× |
| First-enable backup of 1M docs (150B docs ≈ 180MB with overhead → ~2×128MB segments) | O(docs) PUTs | **2–3 segment PUTs + 1 manifest PUT** (not 64; not 8-multipart — define in §2.6) |
| `keys()` / `count()` | impossible | **O(active keys) from index** (snapshot semantics §2.7) |

Non-goals: SQL, secondary indexes (hook only), compression (stretch), multi-process writes beyond `fileLock` (`src/index.ts:137`).

---

## 1. Where the ceiling actually is

No doc-count constant in `src/`. Emergent from:

1. **`partitionedPath` (`src/acid-engine.ts:679-692`)** — 256×256 leaves defer `readdir` degradation but not file-count cost.
2. **`flushCommittedBuffer` (`src/acid-engine.ts:1480-1508`)** — per doc `JSON.stringify` (2nd) + `open(tmp)`+`write`+`rename` + `fsync` file+dirs in `full` (`src/acid-engine.ts:1503-1507`), driven every 50ms (`src/acid-engine.ts:823`) in all modes. Stack sample: `uv_fs_open→write→rename`.
3. **Flush amplification** — even with correct recovery (O(WAL tail)), each `committedBuffer` entry still pays per-file syscalls; this is where 100% of the *throughput* ceiling lives. Recovery headline is a throughput symptom, not a separate O(docs) redo bug (see §0 fix — but auto-rotate flush ordering is a real bug, §2.2a).
4. **O(files) enumeration** — `walkPartitions` (`src/acid-engine.ts:700-729`) for `verifyDataIntegrity`/backup; no `keys()`/`count()`.

`dirtyKeys` (`src/acid-engine.ts:796-806`) is O(dirty docs) and bounded by checkpoint cadence — not a ceiling, but Phase 4 must consume it per-segment.

---

## 2. Design

### 2.1 Segment files — record format v1 (with version now)

Path: `<dir>/segments/seg-<monotonicSeq>.seg` — **NOT** `seg-<startLSN>.log`. The WAL shipper already uses `nodes/<nodeId>/wal/seg-<start>-<end>.json.gz` (`src/backup.ts:1313,1343`); reusing the name collides in the same bucket namespace. Use `.seg` + monotonic seq.

Record format (all LE, CRC covers everything after `len`):

```
[4B totalLen][1B version=1][1B op: 0=PUT 1=DELETE][2B keyLen][4B crc32][8B lsn][key bytes UTF-8][payload bytes JSON UTF-8 or 0 for DELETE]
totalLen = 1+1+2+4+8 + keyLen + payloadLen
```

- `version` now — avoids wire break later (`roadmap4` open question, `roadmap5.md:135` — do in Phase 1).
- `op` gives tombstone on disk (compaction needs it).
- `lsn` = WAL LSN of the commit that produced this record (monotonic, see §2.2b) — lets compaction preserve ordering and lets index rebuild pick latest per key without extra manifest.
- `crc32` = IEEE over `version..payload` (not just payload) — detects key/len bitrot.

**Flush = one append.** `flushCommittedBuffer` serializes `committedBuffer` batch into one buffer → one `writeSync` → one `fsync` (in `full`; coalesced timer in `normal`; none in `off` — maps 1:1 to `synchronous`) → one in-memory index update. 5k docs: ~15k syscalls → 2 (+ 1 `fsyncDir` on segment *create* — still needed on ext4, so "tmp+rename disappears entirely" is false). `atomicWriteFile` is dead for data path.

**Rotation:** active segment rolls at `segmentSizeMB` (default 128, validate against `statfs` free >2× segment). Closed segments are immutable (backup/compaction cheap). Docs > segmentSize (16MB `src/index.ts:21` vs 128MB) are allowed — one doc may make one oversized segment; do not split a record.

### 2.2 Checkpoint-LSN recovery — with monotonic LSN fix and flush ordering

**Two bugs the draft missed (A2, A3):**

a) **Monotonic LSN.** Today `WriteAheadLog.currentLSN` `src/acid-engine.ts:43` is derived from current `.wal` only (`recoverFromLog` `src/acid-engine.ts:147-151`), so after `rotateLog` `src/acid-engine.ts:295-322` LSNs restart near 1. Any `LSN > flushedThroughLSN` watermark skips post-rotation writes. **Fix (Phase 1):** persist a monotonic counter in `<dir>/.lsn` (8B LE, `writeSync+fsync+fsyncDir` on bump every 1k LSNs or on rotate). `getCurrentLSN()` `src/acid-engine.ts:390` reads it; `writeLog` increments it; `recoverFromLog` takes `max(maxLSN_in_log, persistedLSN)`.

b) **Flush-before-rotate.** `commitTransaction` does `flushCommittedBuffer(true)` before `rotateLog` (`src/acid-engine.ts:1343-1347`) — correct. But `checkLogRotation` `src/acid-engine.ts:273-283` fires from `flushBuffer` (`src/acid-engine.ts:270`) **without** flushing `committedBuffer`. Crash between `rotateLog` truncate and next `flushCommittedBuffer` tick loses committed data whose WAL was archived/deleted. **Fix:** `checkLogRotation` must `flushCommittedBuffer(true)` before `rotateLog` (same guard as commit path); add assertion.

**Watermark protocol:**
- Each segment flush persists `flushedThroughLSN` in a manifest `<dir>/segments/MANIFEST.json` — entry `{seq, startLSN, endLSN, keys, bytes, crc, flushedThroughLSN}`.
- Ordering: `fsync(segment)` → `write+fsync(MANIFEST.json.tmp)` → `rename` → `fsyncDir(segments/)`. Manifest is the commit point; without its fsync, segment data is invisible to recovery.
- `performCrashRecovery` replays **only WAL entries with `lsn > manifest.flushedThroughLSN`** via redo that *appends to segments* (not `redoOperation` `src/acid-engine.ts:926` file-per-doc path — rewrite redo). Recovery time = WAL tail since last 50ms flush + index rebuild.

### 2.3 Crash model (torn tail — forward scan only)

WAL remains authority (`src/acid-engine.ts:777-782`). Torn tail handling:

- Loader scans **only the active (last) segment** forward: read `totalLen`; if `read < totalLen`, torn partial header → truncate at that offset; else read frame, verify `crc32`, on mismatch truncate at frame start; else advance. No back-to-front scan.
- After truncation, WAL replay from `flushedThroughLSN` rewrites lost tail.
- `synchronous:'off'` is documented lossy — no new guarantee. `synchronous:'normal'` may lose ≤`commitIntervalMs` `src/index.ts:121` of tail in both WAL and segment (same RPO).

### 2.4 In-memory index + persisted snapshot

`key → {segSeq, off, len, lsn}` (+ tombstone via `op`). Maintained at flush; consulted by `exists()` (`src/index.ts:940-955`) and `create()` existence check (`src/index.ts:824`) — removes `existsSync` fast path *for segment engine only*; file engine path unchanged. File-engine `knownKeys` LRU (`src/index.ts:342`, cap 10k) stays as fallback for file mode; under segment mode it is deprecated (index is authoritative). Decide in Phase 4: keep LRU as negative-cache for segment mode or remove.

**Memory:** Do not assert 150B or 500B/key — measure in gate. Ship plain `Map` first. Phase 5 compact index (interned key-IDs + `Uint32Array`) only if gate shows RSS breach. Document formula after measurement.

**Cold-start rebuild:** Pure-memory index requires full scan. Add **MANIFEST-embedded index snapshot** every N flushes (e.g., every 10 segments or 5s): `<dir>/segments/index-<seq>.json` (key→loc, compressed). On open, load latest snapshot + scan only segments `seq > snapshot.seq`. Keeps open <5s at 1M docs (snapshot load O(active keys), tail scan ≤ few segments). Without this, recovery <5s is impossible.

**Reads:** cache-miss = one `pread(off, len)` + `JSON.parse` + CRC check. Hold a read-fd pool per segment; compaction unlinks old segments only after epoch quiescence (refcount — see §2.5).

### 2.5 Compaction — with crash protocol and async I/O

Trigger: per-segment `liveBytes < 60%` OR global `tombstoneRatio > 20%`. Needs per-segment stats (maintain `segmentStats: segSeq→{liveBytes,totalBytes,tombstones}` at flush).

Work: rewrite live records of eligible segments into new segment(s), build new index entries in shadow map, then:

1. `fsync(new segment(s))`
2. Write `MANIFEST.json` with `pendingCompaction:{inputSeqs, outputSeqs}` → fsync+rename+fsyncDir
3. Swap index (atomic reference swap)
4. Update MANIFEST to committed (remove pending) → fsync+rename
5. Unlink input segments only after step 4 durably. Orphans GC on next boot if crash between 2 and 4.

**Tick budget:** Async I/O, not sync — use `fs/promises` with `setImmediate` yields, cap to ≤8MB per 50ms *wall* but yield every 1MB. Do not block loop with `readSync/writeSync/fsyncSync` bursts — the draft's budget still stalls p99 if sync.

Amplification: ~2× worst-case with these thresholds; not proven for adversarial hot-key churn — gate asserts `<2×` after 2× churn, tune thresholds if breached.

Pause compaction under write pressure (backoff if `committedBuffer.size > threshold`).

### 2.6 Backup / hydration / enumeration — segment-aware

- **Snapshot = closed segments + MANIFEST + latest index snapshot** (2–3 objects for 1M×150B docs; define once: 180MB payload + overhead ≈ 200MB → 2×128MB segments). Manifest is the restore atomic point; order: `PUT(segments)` → `PUT(MANIFEST)` (visibility marker — same as `roadmap4` `nodes/<nodeId>/manifest.json` `roadmap4.md:84` but separate namespace `segments/` vs `nodes/<nodeId>/wal/`).
- **Incremental checkpoints:** `takeDirtyKeys` `src/acid-engine.ts:802` is per-key; under segments it feeds compaction, not per-S3-object deltas (S3 objects are immutable — "re-materialize only touched segments' deltas" is hand-wavy; drop it). Economics come from immutability of closed segments (unchanged segments cost 0), not per-key delta PUTs.
- **Enumeration rewrite (understated in draft):** `BackupManager.getJsonFiles()` `src/backup.ts:259` and `createArchiveBackup` `src/backup.ts:289` and `backupToBucket` `src/backup.ts:754-838` all use `walkPartitions` `src/acid-engine.ts:700`; under segments they must list `segments/*.seg` + MANIFEST. `DataRecovery.recoverSingleFile` `src/recovery.ts:121` and `recoverIndividualFiles` `src/recovery.ts:216` / `recoverMissingFiles` `src/recovery.ts:394` write via `partitionedPath` `src/acid-engine.ts:679` — dead for segment engine. Phase 4 rewrites these paths to `GET segments/` + `MANIFEST` and to download segments directly. Scope is not "1–2 wk polish."
- **Hydration modes:** `hydrateOnStartup:'snapshot'` `src/index.ts:140-151` is the only valid mode for segment engine. `'all'`/`'missing'` (`src/recovery.ts:127,379,520`) produce legacy layout files the segment engine never reads — disable with clear error or auto-rename to segment import path.
- **Namespace split:** WAL shipper `src/backup.ts:1269-1357` stays under `nodes/<nodeId>/wal/`; segments under `segments/` — no collision after rename.

### 2.7 New API

`keys()`, `count()`, `iterate()` served from index + `committedBuffer` (must union pending flush; exclude tombstones). Define snapshot semantics: `iterate()` sees a point-in-time view (copy-on-read of index reference, not live Map) and is O(active keys). `walkPartitions` remains only for legacy import (§3).

### 2.8 Config surface + auto-detection

```ts
// TeroConfig (src/index.ts:107)
engine?: 'file' | 'segment'        // default 'file' in 0.0.x; auto-detect in 1.0 (see below)
segmentSizeMB?: number             // default 128, validated against free disk
indexCompact?: boolean             // Phase 5; default false
```

In 1.0, do **not** flip default blindly — on open, detect on-disk format: if `<dir>/segments/MANIFEST.json` exists → segment engine; else if legacy partition tree non-empty → file engine (or trigger migration if `engine:'segment'`); else new DB → respect `engine` flag. Add persisted `<dir>/.engine` marker written atomically at format init.

`synchronous` maps 1:1 onto segment fsyncs (per-append batch). `TERO_ALLOW_UNSAFE_OFF` `src/index.ts:369-371` unchanged.

---

## 3. Migration (non-breaking, idempotent)

1. `engine:'segment'` on existing dir triggers one-time import **guarded by import manifest**: `walkPartitions` `src/acid-engine.ts:700` streams legacy docs → bulk append into `segments/seg-*.seg` (check `statfs` free > 1.5× source size first) → write `MANIFEST.json` (seq 0) → write `.engine='segment'` → `fsyncDir` → rename legacy tree to `<dir>/legacy-<ts>/` (keep until first *verified* compaction). Progress = `import-manifest.json` with `lastKey` cursor; resume is idempotent — skip keys already indexed (compare `lsn`/`crc`), never double-append.
2. WAL replayed per normal boot after import — no loss (same as `upgrade3.md` §4).
3. Rollback = delete `segments/` + `.engine` + restore legacy tree *only while legacy retained*; after GC, rollback is destructive — document it. `engine:'file'` keeps working through 1.x for non-migrated DBs.

---

## 4. Phases (re-estimated)

| Phase | Deliverable | Effort | Exit criterion |
|---|---|---|---|
| **0 — Re-baseline** | Fix `checkLogRotation` flush-before-rotate; extend `capacity-probe.mjs` with `du` disk accounting + `kill -9` recovery harness; measure on ext4 | 1 wk | Disk amplification and recovery wall-time reported per `synchronous` mode; no "real, not projected" without data |
| **1 — Segments + monotonic LSN + batched flush + Map index** | `.lsn` monotonic counter, segment append + `fsyncDir` on create, MANIFEST with `flushedThroughLSN`, index + snapshot, redo rewritten to segments | 3–4 wk | 1M docs (`normal`) ≥20k docs/s sustained, no flush stall >50 ms; `kill -9` mid-flush → WAL tail replay correct |
| **2 — Torn tail + recovery + index snapshot** | Forward-scan active tail only (partial-header + CRC), MANIFEST two-phase fsync ordering, index snapshot load+tail scan | 1–2 wk | `kill -9` at 1M docs (`full`) → open <5 s (snapshot+tail), 100% committed-tx survival in `full`; `corrupt-last-record` and `torn-partial-header` tests green |
| **3 — Compaction** | Per-segment stats, async tick-budgeted rewrite with yields, pending→committed MANIFEST, orphan GC, backpressure | 2 wk | After 2× churn: disk ≤2× payload; p99 flat per mode; post-compaction state byte-equivalent; tombstones reclaim |
| **4 — Segment-aware snapshot/hydrate + `keys()/count()/iterate()`** | Rewrite `getJsonFiles`/`backupToBucket`/`DataRecovery` to `segments/`+MANIFEST, snapshot-only hydration gate, `iterate()` snapshot semantics | 2 wk | MinIO: 1M-doc first-enable = `ceil(payload/128MB)` segment PUTs +1 manifest, verified; hydration `O(segments)` |
| **5 — Compact index (if needed) + migration tool + auto-detect + CI gate** | Measure B/key in gate; if breach, compact index; finalize `.engine` auto-detect, legacy import resume, `indexCompact` flag | 2 wk | Gate asserts `RSS ≤ baseline + index_measured`; 50k→1M gate runs on ext4 runner with timeout headroom |

Total: ~10–13 weeks. Phases 1–2 are production blockers; 3–5 are economics/polish. Phase 4 scope was understated — plan 2 wk, not 1.

---

## 5. Verification (extends `local_tests/` + MinIO `test:s3`)

1. **Capacity gate:** 50k probe stays; new `capacity-probe-1m.mjs` (opt-in nightly, not per-PR — 1M docs OOMs PR runners) asserts `normal` ≥20k docs/s, no stall >50 ms, `du` ≤2× payload.
2. **Recovery (mode-qualified):** `kill -9` mid-flush at 1M docs (`full`, three recencies) → open <5 s, 100% committed survival; same in `normal` → ≤`commitIntervalMs` loss window only.
3. **Torn tail:** (a) flip last byte (CRC mismatch) → truncates one record, WAL restores it; (b) truncate inside `totalLen` header (partial header) → detects `read < totalLen`, truncates, WAL restores; `verifyDataIntegrity` healthy.
4. **Compaction correctness:** byte-equivalent per key after compaction; tombstones actually reclaim; per-segment stats accurate.
5. **Backup cost contract:** MinIO access log asserts `PUTs == segments + 1 (manifest)` for first-enable; WAL shipper `wal/` PUTs counted separately. No per-doc PUTs after first-enable.
6. **Soak:** 24h mixed 1k ops/s (or nightly 4h scaled) with hourly `kill -9` — flat RSS (gate, not speculation), FDs < limit, zero corruption. Deduplicate `roadmap4.md:168` soak where possible.

---

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Monotonic LSN restart after rotation | Persisted `.lsn` file, fsynced, read on boot (`max(log, file)`) — Phase 1 hard gate |
| `checkLogRotation` without `flushCommittedBuffer` | Fix ordering per §2.2b, add test |
| Index memory / cold-start scan | MANIFEST index snapshot + tail scan; gate measures B/key, no speculative 150/500 numbers |
| Compaction stalls p99 | Async I/O with `setImmediate` yields, 1MB chunks, pause under write pressure |
| Segment file creation durability | `fsyncDir(segments/)` on new file; MANIFEST `fsync+rename+fsyncDir` |
| Hydration mode break | Segment engine only supports `snapshot`; `'all'`/`'missing'` error or auto-import |
| Backup path rewrite understated | Phase 4 rewrites `getJsonFiles`/`backupToBucket`/`DataRecovery` — 2 wk, not polish |
| Migration atomicity / ENOSPC | `statfs` preflight, import manifest + idempotent resume, `.engine` marker, legacy retained to GC |
| Namespace collision `seg-` | Segments `.seg` under `segments/`, WAL under `nodes/<id>/wal/` — distinct |
| Scope creep | Segments only remove per-file tax; secondary-index hook stays hook |

---

## 7. Decision asked

Approve **Phase 0 (re-baseline) + Phase 1–2** now. Block 1.0 default-flip on Phase 0 numbers and monotonic-LSN + MANIFEST durability gates — the two load-bearing fixes for the roadmap's headline claims. The core thesis (per-file materialization is the ceiling; segments+index+compaction fix it) survives review; the numbers and several mechanics needed correction above.
