# Roadmap 4 — Continuous Bucket Backup: per-second consistency at ~1000× lower write cost

**Status:** Draft · **Created:** 2026-08-28 · **Scope:** `src/backup.ts`, `src/recovery.ts`, `src/acid-engine.ts` (WAL), API surface in `src/index.ts`
**Depends on:** `partitionedPath()` fix in recovery (2026-08) · Cost analysis in [BUCKET_COST_DATA.md](./BUCKET_COST_DATA.md)

---

## 0. TL;DR

Today Tero's bucket backup is **full-snapshot-on-demand**: every backup re-uploads *every* document, so write cost is `O(docs) × backup frequency`, and the bucket is only as fresh as the last time someone called backup. This roadmap replaces that model with **continuous WAL shipping**: the engine streams its existing write-ahead log to the bucket as it commits, and the bucket always holds a consistent state that is **at most 1 second old** — Tero's one and only offered consistency level.

- **Write cost at target RPO:** fixed `1 PUT per second with writes` (plus rare checkpoints) instead of `O(docs)` per backup. For a 50k-doc DB, per-second consistency under the old model would cost **4.32B PUTs/day (~$21.6k/day)** — impossible; under this model it costs **≤ $12.96/mo**, and read-mostly workloads pay far less because idle seconds ship nothing.
- **API simplification:** no backup schedules, no consistency menu. `consistency: 'per-second'` is the only value; snapshots become an internal compaction mechanism, not a user-facing knob.
- **Bonus capability:** because the bucket holds the WAL chain, **point-in-time recovery** to any commit within the retention window falls out for free.

---

## 1. Why the current model has to go

| Problem | Detail |
|---|---|
| Cost scales with docs × frequency | One daily backup of 50k docs = 1.5M PUTs/mo ($7.51 AWS). Hourly = $180/mo. Per-second under the same model = 4.32B PUTs/day — no provider survives this, and small docs cost exactly as much as large ones (one object per document). |
| RPO is unbounded | The bucket reflects whatever the last backup captured — minutes, hours, or a day old. There is no consistency contract, just "whenever you ran it". |
| Snapshot = consistency point | Users are forced to think about backup scheduling to get durability. Durability should be a property of the system, not a cron entry. |
| Manifest races | `MANIFEST.json` is read-modify-write; two nodes backing up into one bucket can clobber each other's manifests. |
| No point-in-time recovery | Retention deletes whole tags; you cannot restore "as of 10:32:04". |

---

## 2. Goals and non-goals

**Goals**
1. **RPO ≤ 1 second** for any committed record, whenever the bucket is reachable — the *only* consistency level Tero ships.
2. Bucket write operations bounded by **seconds-with-writes**, never by document count.
3. Restore = fetch one snapshot + bounded replay (≤ a few minutes of segments), never full-history replay.
4. Point-in-time recovery within the retention window.
5. Safe for multiple nodes writing to one bucket (no manifest races, no cross-node interference).
6. Measurably testable: the contract is small enough to assert in CI with MinIO.

**Non-goals**
- Sub-second RPO (that is replication, not backup — see roadmap for a future streaming-replica design).
- Querying from the bucket; cross-region automatic failover; active-active multi-master.
- Encrypted/encrypted-client-side formats beyond what the S3 API already offers.

---

## 3. Design

### 3.1 The consistency contract (only level we offer)

```javascript
db.configureBackup({
  consistency: 'per-second',   // ← only accepted value; anything else throws
  nodeId: 'node-a',            // required when >1 node shares a bucket
  retention: '7d',
  bucket: { provider: 'aws-s3' | 'cloudflare-r2' | ..., ... },
});
```

**Definition:** for every transaction that has returned commit under the engine's `synchronous` mode, its WAL record is durable in the bucket within **1 second** of commit (or is already there). A restore always yields a state ≥ the last commit at or before the requested point. Measured lag is exposed via `db.backupStatus()`. If the bucket is unreachable, Tero keeps buffering locally, the lag number grows, and status flips to degraded — RPO degrades loudly, never silently.

### 3.2 Write path: WAL shipper

The engine already buffers WAL records (`writeBuffer` in `WriteAheadLog`), flushes them on durability barriers (group-commit timer in `normal` mode, commit in `full` mode), and rotates segments at 1 MB (`LOG_FILE_SIZE_LIMIT`). The shipper hooks into those existing events — **no new fsyncs, no extra syscalls**:

- **Ship unit:** every `uploadIntervalMs` (default `1000`), all WAL records appended since the last uploaded LSN are gzipped (`node:zlib`, zero new dependencies) into one object:
  `nodes/<nodeId>/wal/seg-<startLSN>-<endLSN>.json.gz`
- **Idle = free:** if no records were appended since the last upload, skip the PUT entirely. Cost is driven by *active seconds*, not wall-clock seconds.
- **Idempotence & integrity:** each object carries `{nodeId, startLSN, endLSN, prevEndLSN, crc32, createdAt}`; re-uploading an identical LSN range is a no-op-safe PUT; gaps in `prevEndLSN` chains are detected at restore.
- **Large batches:** if a single interval exceeds ~5 MB compressed, split into multipart upload parts (the `Upload` from `@aws-sdk/lib-storage` already used in `backup.ts`).
- **Backpressure:** if the bucket is unavailable, records keep accumulating in the local archive directory (extending `ARCHIVE_KEEP_COUNT` locally); writes are never blocked by default (configurable `strict` mode for users who want write-fail-on-bucket-fail).

### 3.3 Snapshots become internal compaction

Replaying WAL from the beginning of time makes restore slow and retention storage unbounded. Tero keeps snapshots — but as an **internal mechanism**, not a user-facing consistency knob:

- **First enable:** one full snapshot (`nodes/<nodeId>/snap-<seq>/…`, reusing the existing `backupToBucket` upload path) becomes the restore base.
- **Incremental checkpoints (the cost lever):** on an adaptive trigger — `elapsed ≥ 15 min with writes` OR `segmentsSinceSnapshot ≥ 1,800` OR `dirtyDocs ≥ 20%` — upload **only documents modified since the previous checkpoint** (`snap-<seq>/delta-<n>/…`). Unchanged docs cost zero PUTs. This is the second half of the cost win: today every backup re-uploads *all* docs; tomorrow, checkpoints upload *dirty* docs only, and full snapshots happen only on first enable or explicit `compactToBucket()`.
- **Why adaptive:** a fixed fast checkpoint interval reintroduces `O(docs)` writes; a fixed slow one makes replay unbounded. The triggers bound both: restore replay is capped at ~30 min of active-seconds of segments, while checkpoint cost stays proportional to churn, not DB size.

### 3.4 Manifest v2 — per-node, race-free

`MANIFEST.json` as a single shared read-modify-write file is a race under multi-node. Replace it:

```
nodes/<nodeId>/manifest.json        ← only this node ever writes it
  { version: 2, nodeId, latestSnapshotSeq, latestDelta,
    segments: [{key, startLSN, endLSN, crc32, createdAt}],
    retentionEndsAt }
```

- Manifest update is **PUT-after-data** (objects first, manifest last); a manifest that references a missing object is detected at restore and healed from the local archive.
- Cross-node visibility (e.g., "list all nodes") is a `ListObjectsV2` on `nodes/` — no shared mutable state.
- Old `MANIFEST.json` is still *read* during migration (Phase 5 removes that).

### 3.5 Restore path

1. Read `nodes/<nodeId>/manifest.json` (or PITR target → newest manifest state ≤ target).
2. Fetch latest snapshot + deltas (`GET`s, Class B / S3 GET pricing — ~40× cheaper than PUTs on AWS, and R2 Class B is $0.36/M).
3. Fetch segments since the last delta (bounded by the checkpoint triggers, ≈ ≤1,800 objects; fetched with concurrency 32 — ~30 s worst case).
4. Verify `prevEndLSN` chain + CRC per segment; apply records in LSN order into a fresh engine via the existing hydration path (`DataRecovery`, `partitionedPath()`-aware).
5. **PITR:** `restoreToPoint({ nodeId, timestamp | LSN })` replays only up to the requested record — free once the chain exists.

---

## 4. Cost model (illustrative, from [BUCKET_COST_DATA.md](./BUCKET_COST_DATA.md) unit prices)

**Assumptions:** avg doc 1 KB, gzip ≈5:1 on WAL records, 20% of seconds have writes (17,280 active s/day), hourly checkpoints with 2% dirty docs, 7-day retention, us-east-1 ($0.005/1k PUT) and R2 Standard ($4.50/M Class A, 1M/mo free).

| Scenario | Old model: 1 daily backup | Old model at per-second RPO | **New model, per-second RPO** |
|---|---|---|---|
| A — 5k docs | $0.91/mo, RPO = 24 h | ~$2,160/**day** (~$64.8k/mo) | **≈ $2.95/mo AWS · $0.00 R2** (free tier covers it) |
| B — 50k docs | $9.14/mo, RPO = 24 h | ~$21,600/**day** — impossible | **≈ $6.20/mo AWS · ≈ $1.07 R2** |
| C — 250k docs | $53.71/mo, RPO = 24 h | ~$108,000/**day** — impossible | **≈ $20.60/mo AWS · ≈ $14.03 R2** |

Write-op breakdown (scenario B): 518k WAL PUTs/mo + 720k checkpoint PUTs/mo ≈ **1.24M writes/mo** for an RPO 86,400× better than today's daily backup — which alone burns 1.5M writes/mo. At equal cost, **10–1000× fewer writes**; at per-second RPO, **~4–5 orders of magnitude fewer**.

Storage: ~17 MB/day segments + ~12 MB/day checkpoints ≈ 210 MB for 7-day retention — pennies on both providers; lifecycle rules transition segments ≥24 h old to IA-class storage automatically (Phase 2).

**Honest caveats:** checkpoint cost is churn-driven — a workload rewriting 100% of docs every hour turns checkpoints back into full uploads (mitigation: `checkpointInterval` tuning, or future doc-batching); R2's per-unit rounding can add a dollar-scale bump at small sizes; idle-but-charging seconds don't exist here because idle seconds ship nothing.

---

## 5. Rollout phases

| Phase | Scope | Exit criteria |
|---|---|---|
| **0 — Prep** (~1 wk) | Expose `currentLSN` + per-record CRC from `WriteAheadLog`; dirty-doc tracker in `acid-engine`; `backupStatus()` stub; feature flag `continuousBackup` (default off). No behavior change. | `tsc` clean; existing suites green (49/49 prod, 8/8 S3). |
| **1 — Shipper MVP** (~2 wk) | Per-second gzip segment PUTs (`seg-<start>-<end>.json.gz`), idle-skip, first-enable full snapshot, restore = snapshot + replay. Single node. | MinIO CI: scripted workload costs ≤ active-seconds + ε PUTs; kill -9 at t → restore on fresh node contains all commits ≥ t−1 s. |
| **2 — Checkpoints & manifest v2** (~2 wk) | Adaptive incremental checkpoints; per-node manifests; segment lifecycle (IA at 24 h, delete at retention). | Restore replay ≤ 1,800 segments; two-node isolation (no shared manifest writes); lifecycle verified on MinIO ILM. |
| **3 — PITR & ops** (~1–2 wk) | `restoreToPoint(timestamp \| LSN)`; gap detection + auto-heal from local archive; degraded-state metrics; `strict` backpressure mode. | Injected gap is detected and healed; PITR at arbitrary ts matches a golden fixture. |
| **4 — Hardening** (~1 wk) | Multi-node soak; >5 MB multipart; crash-mid-PUT idempotence; timer-starvation profiling under sync-FS stalls. | 24 h soak with zero chain gaps; documented event-loop limitation if any. |
| **5 — API cutover** | `configureBackup()` public with `consistency: 'per-second'` as the only accepted value; `backupToBucket`/`checkpointAndBackupToBucket` become thin aliases for a forced checkpoint (deprecated, documented); remove scheduled-backup code; update README + BUCKET_COST_DATA.md. | Docs updated; old options throw with migration message; all suites green. |

## 6. Failure modes and their answers

| Failure | Behavior | Cost impact |
|---|---|---|
| Bucket unreachable | Keep appending to local archive (extends `ARCHIVE_KEEP_COUNT` semantics); status → `degraded`, lag grows in `backupStatus()`; default never blocks writes (`strict` opt-in). | Zero bucket writes; catch-up PUTs on reconnect are batched (fewer, larger objects). |
| Crash between segment PUTs | Chain gap (`prevEndLSN` mismatch) detected at restore; healed from local archive, else restore fails loudly — never silently restores a hole. | ≤1 s of in-buffer records lost by contract (RPO holds: they were not yet committed-and-shipped). |
| Corrupt segment (bit rot) | CRC mismatch → restore falls back to last snapshot + skips to next intact segment; health flag raised. | One re-upload. |
| Burst > 5 MB compressed in one second | Multipart upload via existing `@aws-sdk/lib-storage` `Upload`. | Same object count. |
| Two nodes, one bucket | Per-node prefixes + per-node manifests; nothing shared is ever mutated in place. | None. |
| Restore while node is shipping | Restore reads to a pinned LSN; live node unaffected. | None. |
| Event-loop stall (sync FS) delays the 1 s timer | Ship fires on next tick; RPO violated only while the process is stalled — documented limitation, monitored via p99 ship-lag metric. | None. |

## 7. Test plan (extends `local_tests/`, runs under the existing MinIO `test:s3` harness)

1. **Write-cost contract:** scripted mixed workload; assert `PUTs ≤ activeSeconds + checkpoints + ε` — the headline guarantee, asserted in CI.
2. **RPO contract:** write burst → `kill -9` within 900 ms → restore on a fresh node → every commit returned before kill is present.
3. **Idle = free:** 60 s with zero writes → zero PUTs (assert via MinIO access logs / object mtimes).
4. **Gap injection:** delete a segment object → restore detects, heals from local archive; with archive cleared, fails loudly.
5. **PITR:** restore at three timestamps against golden fixtures.
6. **Multi-node:** two nodes, one bucket, concurrent writes + restores; assert isolation and no manifest clobber.
7. **Checkpoint correctness:** delta checkpoint on churned subset; restored state must equal a same-LSN full snapshot byte-for-byte.
8. **Multipart & corruption:** >5 MB burst; flipped byte in a segment.

## 8. Acceptance criteria

- p99 ship lag ≤ 1 s at 1k writes/s (local NVMe + MinIO).
- Scenario-B restore < 60 s end-to-end.
- Monthly bucket write cost for scenario B ≤ $7 AWS / ≤ $2 R2 at the §4 assumptions.
- Zero PUTs when idle; zero full-DB uploads after first enable (barring explicit `compactToBucket()`).
- README, BUCKET_COST_DATA.md, and this file updated at Phase 5.

## 9. 24-Hour Soak & Chaos Testing Protocol

To prove long-term endurance for Tier-1 infrastructure deployment:

1. **Continuous 24-Hour Sustained Load:**
   - Workload: 1,000 mixed operations/sec (70% reads, 20% updates, 10% inserts/deletes).
   - Target metrics: Zero RSS memory leakage (<150MB flat memory ceiling), stable file descriptor count (<50 open FDs), zero WAL segment corruption over 86,400 consecutive shipping cycles.
2. **Periodic Unannounced `SIGKILL` Chaos Cycles:**
   - Automated hourly `kill -9` process termination while mid-commit and mid-WAL shipping.
   - Assert: Stale `.lock` PID reclamation succeeds; crash recovery replays 100% of committed transactions without manual intervention.
3. **Network Partition Injection:**
   - Simulate 5-minute simulated S3/R2 outages via proxy fault injection.
   - Assert: Live shipper gracefully degrades to `degraded` state without blocking local transaction commits; auto-heals and flushes pending WAL archives once connectivity resumes.

## Open questions

- Should `shipIntervalMs` be user-tunable below 1000, or is 1 s a hard product constant? (Tunable risks users re-creating the old cost trap.)
- WAL record schema versioning: add an explicit `v` field to segment headers now (cheap) — recommended yes.
- Client-side encryption format for segments (SSE covers at-rest; roadmap defers).
- Future: batch multiple docs' records per WAL entry to cut segment size further for tiny docs.


