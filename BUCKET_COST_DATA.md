# Tero Bucket Backup — Cost Data (AWS S3 vs Cloudflare R2)

> **Data verified:** 2026-08-28. AWS figures from the official AWS Price List feed for **US East (N. Virginia)** — publication date `2026-08-18T18:11:13Z`. Cloudflare figures from the R2 pricing docs, last updated **2026-08-07**. Other regions vary (S3 Standard ranges ~$0.021–$0.036/GB-mo); confirm on the official pages before budgeting.
>
> Sources: [aws.amazon.com/s3/pricing](https://aws.amazon.com/s3/pricing/) · [developers.cloudflare.com/r2/pricing](https://developers.cloudflare.com/r2/pricing/)

---

## 1. How Tero's bucket backup works (and what it costs)

All backup/restore paths live in `src/backup.ts` and `src/recovery.ts` and speak the S3 API — which is why both AWS S3 **and** Cloudflare R2 (fully S3-compatible) work with the same code and credential shape (`S3_ENDPOINT`, `S3_BUCKET`, region, keys).

| API call | What it does | S3/R2 operations generated |
|---|---|---|
| `db.backupToBucket({ tag })` | Flushes the WAL and checkpoints the engine **without stopping it**, then uploads **every** document file at `db/<2-hex>/<2-hex>/<key>.json`, all retained WAL archive segments, and a `MANIFEST.json` (tag, timestamp, counts, checksums) to `backups/<tag>/`. | **1 PUT per document** + 1 PUT per WAL segment (3 × 1 MB retained, `ARCHIVE_KEEP_COUNT = 3`) + 1 PUT for the manifest + a paginated LIST |
| `db.checkpointAndBackupToBucket({ tag })` | Same, but forces a full checkpoint first, which rotates the WAL and archives the active 1 MB segment (`LOG_FILE_SIZE_LIMIT = 1 MB`) before the snapshot upload. | Same as above |
| Retention / cleanup (cron-driven) | Lists `backups/*` and deletes tags older than the retention window. | LIST + DELETEs — **DELETEs are free on both providers** |
| `db.restoreFromBucket(tag)` / `hydrateOnStartup` | Lists the tag's objects, downloads each file, rebuilds the `db/ab/cd/` partition layout, replays archived WAL segments if any are newer than the checkpoint. | **1 GET per document** + LISTs + **egress bandwidth** |

### The key cost insight

Tero takes a **full snapshot** per backup: it re-uploads *every document*, not just deltas. The dominant cost driver is **object count (one object per document)**, not data size — 50,000 small documents cost the same number of PUTs as 50,000 large ones. A 50k-doc DB backed up daily ≈ 1.5M PUTs/month regardless of document size. WAL segments + manifest add only ~4 objects per backup (negligible). Egress is where the providers differ most: restores to the internet are metered on AWS and **free on R2**.

---

## 2. Unit prices

### Storage (per GB-month)

| Provider / class | Price | Notes |
|---|---|---|
| **R2 Standard** | **$0.015** | no retrieval fee, no minimum duration |
| **R2 Infrequent Access** | **$0.010** | + $0.01/GB retrieval; 30-day min duration |
| **S3 Standard** | **$0.023** | first 50 TB tier, us-east-1 |
| **S3 Standard-IA** | **$0.0125** | + $0.01/GB retrieval; 30-day min duration |
| **S3 One Zone-IA** | **$0.0100** | + $0.01/GB retrieval; single AZ |
| **S3 Intelligent-Tiering** | $0.023 / $0.0125 / $0.004 | Frequent / Infrequent / Archive-Instant; auto-moves objects ≥ 128 KB; monitoring $0.0025 per 1,000 objects |
| **S3 Glacier Instant Retrieval** | **$0.004** | ms access; + $0.03/GB retrieval; 90-day min |
| **S3 Glacier Flexible** | **$0.0036** | restore delays 1 min–12 h; 90-day min |
| **S3 Glacier Deep Archive** | **$0.00099** | restore delays up to 12 h; + $0.02/GB retrieval; 180-day min |

> Tero snapshot files are typically small (KBs) and overwritten each backup — lifecycle-tiering only pays off for **retained old tags** that are rarely restored (minimum-duration fees apply).

### Operations (per 1,000 requests)

| Operation | AWS S3 (us-east-1) | R2 Standard |
|---|---|---|
| PUT / COPY / POST / LIST | **$0.005** | **$0.0045** (Class A, $4.50/M) |
| GET / HEAD / SELECT | **$0.0004** | **$0.00036** (Class B, $0.36/M) |
| Lifecycle transitions (→ IA / Glacier-Flexible / Deep Archive) | $0.01 / $0.055 / $0.10 | n/a (R2 object lifecycles) |
| DELETE | **Free** | **Free** |

### Bandwidth (egress) — the big difference

| Direction | AWS S3 | R2 |
|---|---|---|
| Data transfer **in** | Free | Free |
| Data transfer **out** to internet | **$0.09/GB** (first **100 GB/month free**) | **$0.00 — always free** |
| S3 → CloudFront | Free | n/a |

### Free tiers

| | AWS S3 | R2 |
|---|---|---|
| Storage | 5 GB (first 12 months only) | **10 GB-month, every month** |
| Writes | 2,000 PUT/mo (12 months) | **1M Class A /mo, every month** |
| Reads | 20,000 GET/mo (12 months) | **10M Class B /mo, every month** |
| Egress | 100 GB/mo (ongoing) | Unlimited |

> ⚠️ **R2 billing quirk:** usage is rounded **up** to the next billing unit — 1,000,001 Class A ops are billed as 2M. At small scale this can flip R2 from cheaper to pricier on request-heavy months. Scenarios below use list-price math.

---

## 3. Monthly cost scenarios

Model: **full snapshot per backup** (Tero's behavior), **1 backup/day**, **7 tags retained** (≈ 7 stored copies), **1 restore/month**. `PUTs/month = days × (docs + 4)`; storage = retained copies × data size.

| Scenario | Data | Docs | PUTs/mo | AWS storage | R2 storage | AWS writes | R2 writes¹ | Restore GETs | Restore egress | **AWS total** | **R2 total** |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A — side project | 1 GB | 5,000 | ~150k | $0.16 | $0.11 | $0.75 | $0.68 | $0.002 | $0 / $0 | **≈ $0.91** | **≈ $0.79** |
| B — small prod | 10 GB | 50,000 | ~1.5M | $1.61 | $1.05 | $7.51 | $6.75 | $0.02 | $0 / $0 ² | **≈ $9.14** | **≈ $7.82** |
| C — large prod | 100 GB | 250,000 | ~7.5M | $16.10 | $10.50 | $37.51 | $33.75 | $0.10 | $0 / $0 ² | **≈ $53.71** | **≈ $44.34** |

¹ R2 list-price math (`ops/M × $4.50`). With R2's free tier (1M Class A/mo), scenarios A and B drop to ~$0 on writes. With the round-up rule, scenario B becomes 2M billable = $9.00 — recompute for your exact cadence.
² Restore egress: AWS includes 100 GB/mo free, so single restores of 10–100 GB are still $0 — but **DR drills, repeated restores, or copying between clouds** hit $0.09/GB immediately (a 1 TB DR pull = **$90 on AWS vs $0 on R2**).

### Sensitivity: backup frequency (50,000-doc DB, writes only)

| Backups/day | PUTs/mo | AWS @ $0.005/1k | R2 @ $4.50/M |
|---|---|---|---|
| 1 (daily) | 1.5M | $7.51 | $6.75 |
| 6 (every 4 h) | 9.0M | $45.00 | $40.50 |
| 24 (hourly) | 36.0M | $180.01 | $162.01 |

Write cost scales linearly with docs × frequency on **both** providers — R2 is ~10% cheaper per PUT. Storage differences only appear with data size; egress differences only appear with restores-to-internet.

---

## 4. Cost-optimization notes for Tero users

1. **Object count is the cost.** One object per document means 50k docs = 50k PUTs per backup even at 1 KB each. For many-tiny-document workloads, lower the backup frequency — small docs are not cheap on either provider.
2. **Right-size retention.** 7 tags stored = 7× storage. On AWS, add a lifecycle rule moving `backups/*` older than 30 days to Standard-IA (−46% storage; + $0.01/1k transition + retrieval fee on restore). On R2, use object lifecycles to Infrequent Access (−33%; + $0.01/GB retrieval).
3. **R2 wins on restores and DR.** Any workflow pulling snapshots to the internet, other clouds, or CI runners is free on R2 vs $0.09/GB on AWS. Frequent restore-testing is effectively free on R2.
4. **AWS wins slightly on request-heavy, storage-light workloads** once you exceed R2's free tier and hit its round-up rule (e.g., hourly backups of many tiny docs).
5. **Both free tiers cover scenario A fully** — a 1 GB hobby DB with daily backups costs $0/month on R2 (10 GB + 1M Class A covered), and $0 for the first 12 months on AWS.
6. **Coming improvement:** delta/incremental backups (uploading only changed documents + WAL segments since the last manifest) would cut write costs 10–1000× for update-heavy workloads — the WAL archive segments (3 × 1 MB) already capture exactly what changed.

---

*All AWS prices: us-east-1, USD, AWS Price List feed published 2026-08-18. Cloudflare prices: R2 docs updated 2026-08-07. Prices exclude taxes and vary by region. This file documents external pricing only — no code in this repo is affected.*

