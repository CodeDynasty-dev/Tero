# Upgrade 3 — Enterprise Single-Node Max Inject + Per-Minute Bucket-Merge Eventual Consistency

**Status:** Draft · **Scope:** `src/backup.ts` (WalShipper), `src/index.ts` (Tero eventual merge), `../crudemonkey/lib/db.ts` (metaTero/dataTero, memoization, materializer), `fly.toml`
**Depends on:** Upgrade 2 sharding plan (metaTero vs dataTero[4]) · `BUCKET_COST_DATA.md` · `roadmap4.md`
**Default change:** `liveBackup.intervalMs` `1000` → `60_000` (per-minute)

---

## 0. TL;DR

Single-node Tero caps at 50-100M events/mo with 4 shards. Per-second WAL shipping burns `~2.6M PUTs/mo/shard` for ~1s RPO that analytics does not need.
This upgrade:

1. **Caps single-node inject** with `metaTero` + `dataTero[4]`, 50k LRU/shard, `quotaDayMemo`, nightly `doc:materialized:admin_overview`.
2. **Flips default WAL ship from per-second to per-minute** — 60x fewer PUTs, 60x fewer `seg-*` objects, same 60s eventual window the 3-year horizontal feature needs.
3. **Adds per-k/v bucket merge for last 60s** behind `eventual: {enabled, stalenessMs: 60_000}` — background poll every 10s + on-miss `GET`, last-write-wins CRDT for daily metrics. Enables horizontal `N` replicas sharing one bucket with 60-70s eventual RPO.

Per-second stays opt-in for `Pro` tenants that pay for `RPO 1s`.

---

## 1. Why per-minute is technically accurate (not per-second)

| | per-second (current) | per-minute (new default) |
|---|---|---|
| `WalShipper` `src/backup.ts:1225` `intervalMs` | 1000 | 60_000 |
| PUTs/mo/shard (with writes) | ~2.59M (86,400/day) | ~43k (1,440/day) — **60x cheaper** |
| Cost `BUCKET_COST_DATA.md:89` 4 shards | ~$52 AWS | ~$0.86 AWS |
| Segments to replay on cold start `src/backup.ts:1149` | up to 2.5k/day | up to 43/day |
| RPO `roadmap4.md:1` | 1s | 60s |
| Aligns with | `FLUSH_INTERVAL 1s` `crudemonkey/lib/db.ts:388` (too chatty) | `digestTick 10m` + `retentionSweep hourly` + your 60s merge window |

Analytics `recordEvent` `lib/db.ts:1314` is buffered 1s then `flushBuffers()` `lib/db.ts:571` — losing 1s vs 60s is indistinguishable for `pageviews/users`. `getMetrics` `lib/db.ts:1644` aggregates `metric:<pid>:<date>` daily docs — no query needs 1s freshness.
Per-second is still offered as `liveBackup: {intervalMs: 1000}` for `Enterprise` low-volume high-durability; default should be per-minute for max inject.

Effective staleness with `ship 60s + poll 10s` = 60-70s. Document as `RPO 60s ship, 70s visible` or ship `30s` if you must guarantee `<60s` wall-clock (cost 2x).

---

## 2. Tero changes (`src/`)

### 2.1 `BackupManager` / `WalShipper` default

`src/backup.ts:929` `enableLiveBackup()`:

```ts
// before
const intervalMs = Math.max(250, opts.intervalMs ?? 1000);
if (intervalMs > 1000) throw ...

// after
const intervalMs = Math.max(1000, opts.intervalMs ?? 60_000);
if (intervalMs < 1000) throw new Error("intervalMs <1000 not offered");
if (intervalMs > 60_000 && opts.consistency !== "per-minute") throw ...
```

Keep `consistency: "per-second" | "per-minute"` — default `per-minute`. `getLiveBackupStatus()` `src/backup.ts:983` unchanged.

`WalShipper` `src/backup.ts:1265` unchanged except `gzip` segment now holds up to 60s of `WAL_SHIPPED_OPS` `src/backup.ts:26` (~5MB max, still `Upload` `src/backup.ts:441` if large).

### 2.2 Per-k/v bucket merge (new, behind flag)

`src/index.ts` `TeroConfig`:

```ts
eventual?: { enabled: boolean; stalenessMs?: number; peerPrefix?: string } // default 60_000
```

`src/index.ts` `Tero` add:

```ts
private eventualEnabled = false;
private eventualStaleness = 60_000;
private lastMergedPerPeer = new Map<string, number>(); // peer -> lsn
private peerListCache: { peers:string[], at:number } | null = null;

private async mergeRecentForKey(key: string) // called at top of get/update/create/delete when eventualEnabled
  // 1. peers = cached listPrefix(peerPrefix) 10s TTL (not per k/v LIST)
  // 2. for peer != self: list wal/seg-* where endLsn > lastMerged && maxTimestamp > now-stalenessMs
  // 3. download gz, filter e.key===key, apply in LSN order to committedBuffer/src/acid-engine.ts:783 + cache, bump lastMerged
```

Background poller `every 10s` (like `WalShipper` `src/backup.ts:1246` but reverse):

```ts
setInterval(() => this.mergeAllPeersWindow(60_000), 10_000).unref()
```

`get()` `src/index.ts:860` path becomes `mergeRecentForKey(key) -> cache -> committedBuffer -> disk -> cloud GET` `src/recovery.ts:78`.

Conflict: daily `metric:<pid>:<date>` must be CRDT — store `{pageviews:{v, ts}}` and merge `max(v)` not `deepMerge` `src/acid-engine.ts:1384`. Phase Y2.

---

## 3. Crudemonkey `lib/db.ts` changes

Apply revised sharding plan verbatim:

* `metaTero` `join(TERO_DIR,"meta")` for `users:index, user:*, projects:index, project:*, customer:*, subscription:*, internals:*, doc:materialized:*`
* `dataTero[NUM_SHARDS]` `NUM_SHARDS = max(1, Number(TERO_SHARDS)||4)` for `metric/vitals/events/funnel_sessions` via `hash(projectId)%NUM`
* `getShardFor(key)` + `isMetaKey(key)` router, `batchRead` cross-shard `Promise.all`
* `TERO_CACHE_SIZE=50000` per shard `lib/db.ts:266`, `fly.toml` `TERO_SHARDS=4`
* `quotaDayMemo Map<${pid}:${ds}, number>` `lib/db.ts:504` set in `flushBuffers()` `lib/db.ts:571`, delete in `retentionSweep()` `lib/db.ts:703`
* `materializeAdminOverview()` -> `metaTero` `doc:materialized:admin_overview` `{users, projects, subscriptions, revenue, events, generatedAt}` nightly `lib/db.ts:2848`

**Plus per-minute defaults:**

```ts
liveBackup: { consistency: "per-minute", intervalMs: 60_000, nodeId: TERO_NODE_ID } // was 1000
eventual: { enabled: !!process.env.TERO_EVENTUAL, stalenessMs: 60_000 }
```

---

## 4. Migration

* Detect legacy `TERO_DIR/*.wal` + `TERO_DIR/*/*.json` (flat). For each doc, `isMetaKey ? meta : dataTero[hash(pid)%N]` `partitionedPath(targetDir,key)` `src/acid-engine.ts:679` `renameSync(src,dst)` — zero-copy.
* No WAL replay loss — `ACIDStorageEngine` `src/acid-engine.ts:866` runs per shard after move.

---

## 5. Verification

* `npm run build` + `bun x tsc --noEmit` 0 errors
* `scratch/verify_tero_sharding.ts` (Bun): shard isolation, `batchRead` merge, `quotaDayMemo` hit, `getLiveBackupStatus()` aggregates 5 shards, `mergeRecentForKey` with 2 nodes writing same `metric:<pid>:<today>` (last-write-wins)
* `npm run test:production` 54/54, `s3-live-backup-test.js` with `S3_ENDPOINT` MinIO — assert PUTs ≈ `activeMinutes` not `activeSeconds`
* Soak: 50M synthetic `recordEvent` 1k rps, 7d retention, `kill -9` during `flushBuffers` — expect ≤60s loss (vs ≤1s before)

---

## 6. Risks

* `staleness 60s` + poll 10s = 70s visible — document, or ship 30s for `<60s` guarantee (2x cost).
* Per-k/v `mergeRecentForKey` must not `LIST` per `get` — peer list cached 10s.
* `eventual` CRDT migration Y2 is breaking for daily docs — version field `v:2` required.

---

## 7. Decision

Set default `60_000`. Keep `1000` opt-in via `liveBackup.intervalMs`. This is the technically accurate default for analytics max inject — per-second was the `roadmap4.md` single-node durability play, per-minute is the 3y horizontal eventual play you described.
