# Roadmap 5 — Segment Storage Engine: removing the file-count ceiling

**Status:** Draft v2 (supersedes roadmap5.md) · **Created:** 2026-09-01
**Scope:** `src/acid-engine.ts` (materialization), `src/index.ts` (config + existence paths), `src/recovery.ts` (hydration), `src/backup.ts` (snapshot units)
**Depends on:** `partitionedPath()` (2026-08) · `roadmap4.md` (WAL shipping) · `local_tests/capacity-probe.mjs`

---

## 0. Executive summary

Tero's durability layer is already log-structured: the WAL is the durable copy and data files are a checkpointed cache — SQLite WAL-mode architecture, by design. But the checkpoint cache is materialized as **one file per document**, which prices every operation in per-file syscalls and makes the cost of ownership grow with document count, not data volume.

**The problem, in one line:** at 1M documents, the engine spends its time creating, fsyncing, and renaming files — not serving data.

**The fix, in one line:** replace file-per-document with append-only segment files, an in-memory key index, and background compaction — leaving the WAL, the ACID transaction layer, and the `synchronous` durability contract untouched.

What this buys, per node:

| Dimension | Effect |
|---|---|
| Ingest throughput | Batched appends instead of per-document tmp+rename — targets ≥20k docs/s sustained at any DB size, vs. measured multi-minute stalls today |
| Latency | No stall outliers; p99 bounded by one batched append per 50 ms tick |
| Crash recovery | Replay only the WAL written since the last 50 ms checkpoint tick |
| Disk footprint | ~1.1× payload after compaction, vs. measured ~30× amplification at 50k docs |
| Backup economics | Snapshot = a handful of immutable segment objects, for any doc count — the roadmap4 cost model now holds end-to-end |
| New API surface | `keys()` / `count()` / `iterate()` served from the index — today impossible without a full filesystem walk |

**Honesty note on the baseline.** Numbers below marked *(measured)* come from `local_tests/capacity-probe.mjs` on APFS, 2026-08-31. The probe measures ingest, flush throughput, file counts, and RSS — it does not yet measure disk bytes or crash recovery. Phase 0 of this roadmap extends the probe to produce those baselines before Phase 1–2 exit criteria are asserted against them. Every "After" target is falsifiable and asserted in CI.

Non-goals: SQL, secondary indexes (a hook is left, nothing more), compression (stretch), multi-process writes beyond the existing `fileLock`.

---

## 1. Problem analysis

### 1.1 Where the ceiling is

No line of code enforces a document limit. The ceiling is emergent from four paths that all scale with **file count ≡ document count**:

1. **`partitionedPath` (`acid-engine.ts:679`)** — every key becomes exactly one `.json` file under a 256×256 leaf tree. The partitioning deferred readdir degradation past ~65k leaves but cannot reduce the *number of files*, which is the real cost driver.
2. **`flushCommittedBuffer` (`acid-engine.ts:1480`)** — every committed doc pays `JSON.stringify` + `open(tmp)` + `write` + `rename`, plus fsync of the file **and every touched directory** in `full` mode. Driven by a 50 ms timer that runs in every mode. Measured *(probe, durability `off`, 150-byte docs, APFS)*: ingest buffers at **21,126 docs/s**; the flush that drains the buffer runs at **~750–1,300 files/s** — 20× slower than ingest, so the backlog can never catch up and the event loop blocks for entire minutes during large flushes.
3. **O(files) enumeration** — `walkPartitions` (`acid-engine.ts:700`) streams the whole tree for integrity checks and all backup enumeration; there is no `keys()`/`count()` API, so the database cannot enumerate its own keys except by walking the filesystem.
4. **Per-file backup/restore** — first-enable backup and hydration are O(docs) object operations, the exact cost trap `roadmap4.md` removed for WAL shipping.

### 1.2 What the ceiling is *not*

- **Not the WAL.** WAL writes are already batched and group-committed; nothing changes there.
- **Not (primarily) crash recovery.** Recovery replays only the current ≤1 MB WAL segment (`performCrashRecovery`, `acid-engine.ts:866`); archived WALs are never replayed because rotation is preceded by a full data flush (`commitTransaction`, `:1343-1347`). Recovery cost today is bounded by log size, not DB size. Roadmap5 v1 overstated this; the segment engine still improves it (see §3.2) but it is not the headline.
- **Not the transaction layer.** Two-phase locking, deferred writes, and the `synchronous` contract are untouched.

One pre-existing defect surfaced during this analysis and is fixed as part of Phase 2: the **1 MB auto-rotation path** (`checkLogRotation`, `acid-engine.ts:272-280`) archives and truncates the WAL *without* first flushing `committedBuffer`, unlike the `commitTransaction` rotation path. A crash in that window can lose committed-but-unflushed transactions. The fix (flush-before-rotate, same ordering as `commitTransaction`) is small and lands with the checkpoint-LSN work that depends on it.

---

## 2. Design

### 2.1 Segment data files

Append-only files under `<dir>/segments/seg-<seq>.log`, where `<seq>` is a monotonically increasing segment sequence number (not an LSN — see §3.1 for why). Record format v1:

```
[1B version][1B flags][1B op][4B length][4B crc32][2B keyLen][key][payload json]
```

- `op`: `0=put`, `1=delete` — deletes are first-class on-disk records (tombstones), required for compaction.
- `crc32` covers everything after itself (keyLen + key + payload).
- `length` covers `keyLen + key + payload`.
- The `version` and `flags` bytes ship in Phase 1. Wire formats are cheap to extend forward and expensive to retrofit.

**Flush = one append.** `flushCommittedBuffer` serializes the batch into one buffer → one `writeSync` → one `fsync` (in `full` mode) → one in-memory index update loop. Segment file **creation** still uses tmp+rename with a directory fsync (append-only doesn't exempt a new file's directory entry from ext4 `data=ordered` semantics); what disappears is the per-document dance.

**In-memory index:** `key → {segId, off, len}` + tombstone set. Maintained at flush time; consulted by `exists()` and `create()`'s duplicate check — both lose their `existsSync` slow path under the segment engine. The existing `knownKeys` LRU (`index.ts:342`, capped at 10k) is retired for the segment engine; the index replaces it.

**Memory budget — measured, not guessed.** Roadmap5 v1 estimated 150 B/key by assertion; v2 treats index cost as an empirical number. Phase 1 ships a plain `Map` with an exit criterion of *"measure B/key at 1M keys and publish the formula."* If plain-Map cost exceeds the edge-device budget, Phase 5 ships the compact variant (interned key-IDs + typed-array postings). The CI gate asserts RSS either way. On boot, the index is rebuilt from segments with a **zero-parse scan** (length-prefixed framing means keys and offsets are extractable without `JSON.parse`); a persisted index snapshot in the manifest is a stretch goal, not a dependency.

**Reads:** cache-miss = one positioned read at `(off, len)` + `JSON.parse`. Fewer syscalls than today's three-level directory resolution, same O(1). Offsets stored as `Number` (safe up to 2⁵³ — far beyond any segment size).

**Rotation:** the active segment rolls at `segmentSizeMB` (default 128) or when a single record would straddle the boundary. Closed segments are immutable — this is what makes backup and compaction cheap.

### 2.2 Checkpoint-LSN recovery

The design premise that makes this safe: **LSNs must be globally monotonic across log rotation.** Today `recoverFromLog` derives `currentLSN` from the current log only (`acid-engine.ts:147`), so LSNs restart near 1 after every `rotateLog`. Phase 2 first fixes this with a persisted monotonic LSN counter (durable on every rotation), then builds on it:

1. Each segment flush advances `flushedThroughLSN` — the LSN of the last WAL entry whose effects are in a segment.
2. `flushedThroughLSN` is persisted in the manifest, **fsynced strictly after** the segment data it describes.
3. `performCrashRecovery` replays only WAL entries with `LSN > flushedThroughLSN`.

Recovery time becomes "recent writes since the last 50 ms tick," independent of DB size. On open, only the **active** segment's tail is validated (closed segments are immutable and were fsynced before rotation): a forward scan that (a) rejects any record where fewer bytes remain than `length` claims — a torn partial header — and (b) truncates at the first CRC mismatch. WAL replay from `flushedThroughLSN` rewrites anything newer.

The existing `CHECKPOINT` entry emitted at rotation is not sufficient for this and is not relied upon; the watermark is new machinery.

### 2.3 Crash model (unchanged trust, new mechanics)

The WAL remains the only durability authority — the contract documented at `acid-engine.ts:777`. A crash can leave a torn tail in the active segment; the loader truncates it and WAL replay restores anything newer. In `synchronous: 'off'` — which is documented as "data loss on crash is certain" — both the WAL and segment tails may be lost; that is the existing, explicitly-accepted contract, unchanged.

`synchronous` mapping: `full` = fsync the segment batch on every flush tick; `normal` = fsync on the coalescing timer; `off` = never. The per-commit cost profile is unchanged from today (one WAL fsync per commit in `full`); segment fsyncs ride the 50 ms batch tick. `TERO_ALLOW_UNSAFE_OFF` (`index.ts:369`) is untouched.

### 2.4 Compaction

Background, async-I/O (`fs/promises`) with `setImmediate` yields — **no synchronous reads/writes on the event loop**, so compaction cannot stall writers. Trigger per segment: tombstone ratio > 20% **or** live-bytes < 60%. Per-segment live-bytes statistics are maintained by the index at flush and read time (no extra I/O).

Crash protocol (two-phase):

1. Write the replacement segment; fsync it.
2. Mark the swap `pending` in the manifest; fsync manifest.
3. Swap index entries atomically (in memory); mark `committed`; fsync manifest.
4. Unlink the old segment; prune the manifest entry.

A crash at any point is recoverable: before `pending`, the orphan replacement is garbage-collected on boot; after `committed`, duplicate records across old+new segments are resolved by the index (new segment wins) and the old one is re-unlinked. `flushedThroughLSN` never moves backwards.

Throughput bound: ≤8 MB of **asynchronous** I/O per 50 ms slice, paused entirely under sustained write pressure. Disk floor target: ~1.1× payload at steady state; peak during a rewrite is bounded by (old + new) per segment, ≤2× for the affected segment only.

### 2.5 Backup / hydration / enumeration

- **Snapshot = closed segments + manifest**, for any doc count. A 1M-doc × 150-byte DB is ~200 MB ≈ 2 segment objects (+ multipart part PUTs within each). §0 targets are stated as "O(segments), not O(docs)" — the exact PUT count depends on the multipart layout and is asserted by the Phase 4 gate, not by this document.
- **Segment naming:** `data-seg-<seq>.log` — deliberately distinct from the roadmap4 WAL shipper's existing `wal/seg-<start>-<end>.json.gz` namespace (`backup.ts:1313`). No collision, no restore ambiguity.
- **Incremental checkpoints:** `takeDirtyKeys` (`acid-engine.ts:802`) continues to produce changed-key lists. For the segment engine, dirty keys map to **dirty active-segment byte ranges**; the active segment's new bytes since the last checkpoint upload as a delta object referenced by the manifest, and closed segments are never re-uploaded. (Object stores cannot append; delta objects + manifest is the mechanism. Phase 4 deliverable.)
- **Hydration, all modes.** `snapshot` mode downloads segments directly. Critically, the `all`/`missing` modes — which today restore per-document `.json` files into the legacy partition layout (`recovery.ts:127,379,520`) — are re-targeted in Phase 4: cloud restore writes segments (or triggers the §4 import walk on legacy-layout payloads). A restored directory must never be a layout the running engine can't read.
- **`walkPartitions` and the live-checkpoint path** (`backup.ts:269,1061`), which enumerate `*.json` files that will no longer exist, are rewritten onto the index/segments in Phase 4. This is why Phase 4 is scoped at 2–3 weeks, not 1–2.

### 2.6 New API

`keys()`, `count()`, `iterate()` — served from the index, unioned with `committedBuffer` (committed-but-unflushed writes) and excluding tombstones/pending deletes. Snapshot-consistent: iteration runs against an index generation number; compaction swaps are generation-bumped so readers on the old generation finish against the old segment before it's unlinked (generation-graceful unlink, not RCU).

### 2.7 Config surface

```ts
// TeroConfig (index.ts:107)
engine?: 'file' | 'segment'        // default 'file' in 0.0.x
segmentSizeMB?: number             // default 128
indexCompact?: boolean             // Phase 5; default false
```

Format detection, not flag inference: on open, the engine reads the directory layout (presence of `segments/manifest.json` vs. partition tree) and boots the matching engine, erroring only on a genuinely ambiguous state. The config flag governs *new* databases and explicit migration (§4). This removes the "existing DB + new binary + no flag" failure mode.

---

## 3. Migration (zero-copy, non-breaking)

1. `engine: 'segment'` on a legacy directory triggers a one-time import: `walkPartitions` (streaming, `acid-engine.ts:700`) reads every legacy doc → bulk append into segments → manifest written (with a `migrating` state marker) → legacy tree renamed `<dir>/legacy-<ts>/` with a parent-directory fsync → manifest marked `migrated` atomically.
2. **Boot-state machine:** `no segments + partitions` → boot file engine. `segments + migrating marker` → resume import (idempotent: the manifest records the last imported key range; no double-append). `segments + migrated` → boot segment engine. `both, no marker` → refuse to boot with a recovery instruction (never guess).
3. ENOSPC pre-flight: import requires free space ≥ estimated segment size before starting; aborts cleanly with the manifest in `migrating` state.
4. **Rollback window is explicit:** `segments/` deletion + legacy-tree restore is supported **until the first verified compaction GCs the legacy tree**. After that, rollback is export-based (dump via the index → re-import to file engine). Documented, not hidden.
5. WAL is replayed per normal engine boot after import — no replay loss.

## 4. Phases

| Phase | Deliverable | Effort | Exit criterion |
|---|---|---|---|
| 0 | Extended probe: disk-byte accounting, `kill -9` recovery timing, full-mode flush latency | 3–5 d | Re-baselined §0 numbers, reproducible from one command |
| 1 | Segment files, batched async-safe flush, Map index behind `engine: 'segment'`; record format v1 with version/op bytes | 2–3 wk | Probe at 1M docs: ≥20k docs/s sustained, no stall >50 ms; measured B/key published |
| 2 | Persistent monotonic LSN; checkpoint-LSN recovery; flush-before-auto-rotate fix; active-tail validation | 1–2 wk | `kill -9` at 1M docs (durability `full` and `normal`) → recovery <5 s, zero committed-tx loss beyond the documented `normal`-mode RPO; chaos suite green |
| 3 | Compaction + two-phase manifest + generation-based reader safety | 1–2 wk | Probe: <2× payload floor after 2× churn; p99 flat during compaction; kill-mid-compaction suite green |
| 4 | Segment-aware snapshot/hydrate (all three modes); rewritten backup + live-checkpoint paths; `keys()`/`count()`/`iterate()`; `data-seg-` namespace | 2–3 wk | MinIO gate: first-enable backup O(segments); hydration O(segments); delta checkpoints upload only active-segment new bytes |
| 5 | Compact index (if Phase 1 measurement demands it); legacy migration hardening; CI capacity gate | 2 wk | Gate green on CI hardware at the documented doc/byte profile |

Total: ~9–12 weeks. Phases 1–2 remove the production blockers (flush stalls); 3–5 are economics, API surface, and the 1.0 default flip.

## 5. Verification (extends `local_tests/` + existing MinIO harness)

1. **Capacity gate (CI):** 1M docs, durability `normal`: sustained ≥20k docs/s, no batch stall >50 ms, RSS within the measured budget, disk ≤2× payload. Sized to run on hosted CI runners (Phase 0 validates the memory/footprint envelope; the 1M gate runs nightly, a 100k gate per-commit).
2. **Recovery:** `kill -9` mid-flush at 1M docs, three checkpoints of recency, in both `full` and `normal` → <5 s; committed-tx survival asserted against each mode's documented RPO (no unconditional "100%" claim — `normal` mode accepts up to `commitIntervalMs` of loss by design).
3. **Torn tail:** corrupt the last record (CRC break) *and* truncate mid-header (short read) of the active segment → clean truncation, WAL replay restores the tail, `verifyDataIntegrity` healthy.
4. **Compaction correctness:** post-compaction per-key byte-equivalence; tombstones actually reclaim; `kill -9` at each of the four two-phase manifest steps → boot resolves every case per §2.4.
5. **LSN invariants:** monotonic across rotation, compaction, and truncated tails; `flushedThroughLSN` never regresses; every index `(off, len)` within its segment's file size.
6. **Backup cost contract:** MinIO access log asserts PUTs = O(segments) for first-enable and O(dirty bytes) per checkpoint, with the WAL shipper enabled — the combined number, not a shipper-disabled one.
7. **Soak:** 24 h mixed 1k ops/s with hourly `kill -9` — flat RSS, flat FDs, zero corruption (extends the `roadmap4.md` §9 protocol).

## 6. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Index memory on edge budgets | Measured in Phase 1, not estimated; compact index behind `indexCompact` if needed; CI asserts RSS |
| Batch flush itself stalling the loop | Chunked serialization + async I/O in the flush path; the 50 ms stall budget is an exit criterion, not an assumption |
| Compaction I/O stealing event-loop budget | Async I/O with yields (§2.4); measured p99 in the gate; compaction pauses under write pressure |
| Segment tail torn-write on crash | CRC + length-short-read detection + active-tail-only validation + WAL authority |
| LSN redesign touching rotation | Phase 2 lands it *before* any recovery logic depends on it; the flush-before-auto-rotate defect is fixed in the same phase |
| Cloud-path regressions | Phase 4 covers every `partitionedPath`/`walkPartitions` consumer (verified inventory: `backup.ts:269,1061,1088,1178,1189,1212`; `recovery.ts:127,379,520`); namespace kept distinct from WAL shipper |
| Migration ambiguity | Boot-state machine refuses ambiguous states rather than guessing; idempotent resume; explicit rollback window |
| Scope creep toward a query engine | Non-goal by design; secondary-index hook = segment-range scans, nothing more |

## 7. Decision asked of this document

Approve Phase 0–2 immediately (probe re-baseline, then the stall fix and checkpoint-LSN recovery — the production blockers). Phases 3–5 gate the 1.0 default flip. The engine's architecture comment (`acid-engine.ts:777`) already promises "the WAL is the durable copy; data files are a checkpointed cache" — this roadmap makes the implementation keep that promise at 10⁶–10⁷ documents per node, with baselines re-measured in Phase 0 and every target asserted in CI.

---
