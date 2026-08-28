# Tero

An embedded ACID JSON database for the edge. Single-node durability via fsync-on-commit; cloud durability via S3/R2/GCS storage.

```
[edge Tero node] --WAL+snapshot--> [S3/R2/GCS bucket]
```

Tero is a **library**, not a service. You embed it in a worker, container, or edge runtime. There is no clustering, no Raft, no distributed consensus — by design. Durability and scale come from cheap object storage, the same pattern Litestream pioneered for SQLite.

## What it is

- **Embedded JSON document DB** with key/value + batch operations
- **Real ACID**: WAL with fsync barriers on COMMIT/ROLLBACK, atomic data-file writes (temp → rename → fsync), in-memory pending-writes index so transaction reads never re-scan the WAL
- **WAL rotation** into archive segments — backs up WAL segments and snapshots to object storage
- **Schema validation** with strict mode (string/number/boolean/object/array/date/any, formats, enums, defaults, custom validators)
- **Cloud backup** to AWS S3 or Cloudflare R2 (cron-scheduled), archive or individual-file format
- **Cloud recovery** — full, single-file, or archive restore
- **v2: hydrate on startup** — pull missing or all files from object storage before the ACID engine initializes to reconstruct node state
- **v2: bucket backup** — one-shot snapshot of all data files + retained WAL segments + a manifest that hydrate-on-startup can discover
- **Per-instance cloud credentials** — each Tero instance manages its own storage credentials directly

## What it is not

- Not a server. No HTTP layer, no wire protocol. You embed it.
- Not distributed. No multi-node consensus. Global durability is the bucket's job.
- Not a query engine. Key/value + batch. No SQL, no indexes beyond the in-memory cache.
- Not horizontally scalable beyond one node's filesystem. One file per document puts a practical ceiling around 10⁵–10⁶ docs per node; the bucket is what scales.

These are deliberate design choices to keep Tero lightweight and fast inside edge worker runtimes while using object storage for global durability.

## Install

```bash
npm install tero
```

## Quick start

```javascript
import { Tero } from 'tero';

const db = new Tero({
  directory: './mydata',
  cacheSize: 1000,
});

await db.create('user1', { name: 'Alice', email: 'alice@example.com' });
const user = await db.get('user1');
await db.update('user1', { age: 30 });
await db.remove('user1');
```

## ACID transactions

Every convenience method (`create`, `get`, `update`, `remove`) is auto-wrapped in a transaction. For multi-step operations, use explicit transactions:

```javascript
const tx = db.beginTransaction();

try {
  await db.write(tx, 'account1', { balance: 900 });
  await db.write(tx, 'account2', { balance: 1100 });
  const a = await db.read(tx, 'account1');   // reads pending state within the tx
  await db.commit(tx);
} catch (error) {
  await db.rollback(tx);
  throw error;
}
```

The money-transfer example demonstrates atomicity: `db.transferMoney('savings', 'checking', 500)` — both balances update or neither does, with the writer held to a durable commit before control returns.

### Durability guarantee

A `commit()` returns only after the WAL `COMMIT` record and all pending writes have been fsynced to disk. A crash after `commit()` returns cannot lose the transaction. A crash mid-`commit()` leaves either the old or new state on disk, never a partial of either — data files are written via temp-file → fsync → atomic rename.

## Schema validation

```javascript
db.setSchema('users', {
  name:  { type: 'string', required: true, min: 2, max: 50 },
  email: { type: 'string', required: true, format: 'email' },
  age:   { type: 'number', min: 0, max: 150 },
  profile: {
    type: 'object',
    properties: {
      bio:     { type: 'string', max: 500 },
      website: { type: 'string', format: 'url' },
    },
  },
});

await db.create('user1', userData, { validate: true, schemaName: 'users', strict: true });
```

Field types: `string`, `number`, `boolean`, `object`, `array`, `date`, `any`.
Validation options: `required`, `min`, `max`, `format` (email/url/uuid/date/time/datetime/phone/ip), `pattern`, `enum`, `default`, `custom`.

## Batch operations

```javascript
await db.batchWrite([
  { key: 'product1', data: { name: 'Laptop',  price: 999.99 } },
  { key: 'product2', data: { name: 'Mouse',   price: 29.99  } },
  { key: 'product3', data: { name: 'Keyboard', price: 79.99 } },
]);

const products = await db.batchRead(['product1', 'product2', 'product3']);
```

## Cloud backup

```javascript
db.configureBackup({
  format: 'archive',   // or 'individual' for per-file backups
  cloudStorage: {
    provider: 'aws-s3',
    region: 'us-east-1',
    bucket: 'my-backup-bucket',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
  retention: '30d',
});

const result = await db.performBackup();
const scheduleId = db.scheduleBackup({ interval: '6h', retention: '7d' });
db.cancelScheduledBackup(scheduleId);
```

Tero interacts directly with object storage from each instance, keeping credentials local and isolated.

## Cloud recovery

```javascript
db.configureDataRecovery({
  cloudStorage: cloudConfig,
  localPath: './mydata',
  autoRecover: true,
});

await db.recoverFromCloud('important-data');           // one file
const result = await db.recoverAllFromCloud();         // all files
const archives = await db.listAvailableArchives();     // discover tar.gz backups
const info = await db.getRecoveryInfo();               // local vs cloud diff
```

## v2: hydrate on startup

`Tero.create()` is the async factory that pulls missing/all files from object storage **before** the ACID engine runs crash recovery — so a fresh node boots with the latest durable state.

```javascript
const db = await Tero.create({
  directory: './mydata',
  hydrateOnStartup: {
    cloudStorage: cloudConfig,
    mode: 'missing',          // 'all' overwrites local; 'missing' only pulls absent files
    continueOnError: true,    // don't block boot on a single failed download
    timeout: 30000,
  },
});

// Or run hydration any time after construction:
db.configureDataRecovery({ cloudStorage: cloudConfig, localPath: './mydata' });
await db.hydrate({ mode: 'missing' });
```

Hydration is non-fatal by design: an unreachable or misconfigured bucket will not block engine startup. The local filesystem remains the source of truth.

## v2: bucket backup with WAL segments

`backupToBucket()` snapshots every data JSON file plus any retained WAL archive segments and writes a manifest the hydrate path can discover:

```javascript
const result = await db.backupToBucket({ tag: 'hourly-snapshot' });
// result: { success, uploadedDataFiles, uploadedWALSegments, duration, errors }

// Force a fresh WAL archive segment first, then back it up:
await db.checkpointAndBackupToBucket({ tag: 'post-burst' });
```

This enables point-in-time recovery: rotate the WAL into a new immutable segment, push it to object storage, and a rehydrated node can replay from that segment forward.

## v2: read with cloud fallback

```javascript
const data = await db.getWithRecovery('maybe-missing');
// returns the document from local or, if absent locally, fetches from the bucket.
// returns false if absent on both sides. does not throw on cloud failure —
// use recoverFromCloud() if you need to see those errors.

const probe = await db.existsWithCloudCheck('user1');
// { local: true, cloud: true, canRecover: false }
```

## Unique ID generation

MongoDB ObjectId-style identifiers, unique across processes and time:

```javascript
const userId = db.getNewId('user');       // user-507f1f77bcf86cd799439011
const orderId = db.getNewId('order');     // order-507f1f77bcf86cd799439012
await db.create(userId, { name: 'Alice' });
```

Composition: 4-byte timestamp + 5-byte process-unique random + 3-byte incrementing counter.

## Monitoring

```javascript
const cache = db.getCacheStats();              // { size, maxSize, hitRate }
const tx = db.getTransactionStats();           // { active, committed, rolledBack, total }
const integrity = await db.verifyDataIntegrity();
// { totalFiles, corruptedFiles, missingFiles, healthy }
const active = db.getActiveTransactions();
db.forceCheckpoint();                          // flush a CHECKPOINT into the WAL
```

## Architecture

```
Tero instance (one per process)
├── ACIDStorageEngine
│   ├── WriteAheadLog ─── append-only, fsync on barriers, rotates to archive segments
│   ├── LockManager   ─── per-key shared/exclusive locks with wait queue
│   └── pendingWrites ─── in-memory per-transaction op index (O(1) reads within a tx)
├── SchemaValidator
├── BackupManager     ─── cron-scheduled snapshot + WAL segment upload to object storage
└── DataRecovery      ─── hydrate-on-startup + runtime getWithRecovery
```


## Error handling

```javascript
try {
  await db.create('user', invalidData, { validate: true, strict: true });
} catch (error) {
  if (error.message.includes('Schema validation failed')) { /* validation error */ }
  else if (error.message.includes('already exists'))     { /* duplicate key */ }
}
```

Keys are validated to prevent path traversal (`..`, `/`, `\` are rejected).

## Configuration

```javascript
const db = new Tero({
  directory: './data',     // default: 'TeroDB'
  cacheSize: 1000,        // default: 100, capped at 1000
  backup: { ... },        // optional: install a BackupConfig at construction
  hydrateOnStartup: { ... }, // optional: v2 hydration before engine init
});
```

## Testing

```bash
npm run build           # tsc + full test suite
npm run test            # full suite (includes the ~60s benchmark)
npm run test:production # ACID + schema + transactions + perf
npm run test:backup     # backup + scheduling + retention
npm run test:schema     # schema validation
npm run test:legacy     # legacy suite
node local_tests/v2-test.js   # v2: hydrate + bucket backup surface
```

### Testing S3 live backup locally (MinIO)

`npm run test:s3` round-trips the live backup API against a real S3-compatible
endpoint: live writes → `backupToBucket()` → `checkpointAndBackupToBucket()` →
raw bucket verification → hydrate-on-startup into a fresh node. Without
credentials it skips, so plain `npm test` stays green.

The cheapest way to exercise it is MinIO in Docker:

```bash
# 1. Start a local S3-compatible server
docker run -d --name tero-minio-test -p 9000:9000 -p 9001:9001 \
  -v /tmp/tero-minio-data:/data \
  minio/minio server /data --console-address ":9001"

# 2. Run the round-trip test (bucket is created if missing)
S3_ENDPOINT=http://127.0.0.1:9000 \
S3_BUCKET=tero-live-backup-test \
AWS_ACCESS_KEY_ID=minioadmin \
AWS_SECRET_ACCESS_KEY=minioadmin \
npm run test:s3

# 3. Inspect what Tero wrote (console at http://localhost:9001)
#    s3://tero-live-backup-test/tero-backups/<dbName>/
#      ├── <key>.json        # data snapshots
#      ├── wal/.wal.<ts>     # archived WAL segments
#      └── MANIFEST.json     # hydration entry point

# 4. Clean up
docker rm -f tero-minio-test && rm -rf /tmp/tero-minio-data
```

Against real AWS, omit `S3_ENDPOINT` and pass an IAM user with
`s3:PutObject/GetObject/ListBucket/CreateBucket` on the test bucket:

```bash
S3_BUCKET=my-test-bucket \
AWS_ACCESS_KEY_ID=... \
AWS_SECRET_ACCESS_KEY=... \
npm run test:s3
```

## Performance characteristics

```
normal mode (recommended production — group commit 10ms + deferred data flush):
  Single create:       ~10,000–14,000 ops/s
  Update (same key):   ~51,000 ops/s
  Batch (100 docs/tx): ~47,000 docs/s
  Hot read (cached):   ~1,000,000 ops/s
  exists():            ~1,000,000 ops/s

full mode (fsync per commit — max durability):
  Single create:       ~45 ops/s
  Batch (100 docs/tx): ~4,000 docs/s
```

- **synchronous: 'full'** (default) — fsync per commit. Max durability. Use when every commit must survive power loss.
- **synchronous: 'normal'** — group commit + deferred data flush. WAL is fsynced every 10ms (configurable via `commitIntervalMs`); data files checkpoint every 50ms (configurable via `dataFlushIntervalMs`). 200x+ throughput vs full mode. WAL sync window is up to 10ms of writes. This is the SQLite `PRAGMA synchronous=NORMAL` equivalent.
- **synchronous: 'off'** — never fsync. Testing/benchmark only.

Architecture:
- In-memory WAL write buffer — one `appendFileSync` per flush, not per entry
- FNV-1a hash for WAL integrity (100x faster than SHA-256 for small entries)
- Deferred data-file writes via `committedBuffer` + background timer (SQLite WAL-mode pattern)
- Transaction-free `get()` fast path: LRU cache → committedBuffer → disk (zero syscalls on cache hit)
- `knownKeys` Set replaces `existsSync()` on the hot path
- Per-tx `heldLocks` Set for O(1) lock release (was O(allLocks))
- Per-tx `txTouchedKeys` Set for O(touched) cache promotion (was O(cacheSize))
- Sync `commitTransaction()` / `rollbackTransaction()` — no async overhead on the happy path
- Lock manager returns `true` (sync) instead of `Promise` on the uncontended fast path
- WAL rotation at 1 MB or every 500 commits, keeping recovery replays bounded

This is single-node throughput, not cluster throughput. For higher write rates, run multiple Tero instances behind a sharding layer; each owns its own bucket and directory.

## License

MIT — see [LICENSE](./LICENSE).

## Contributing

1. Fork the repo
2. Create a feature branch
3. Add tests in `local_tests/` for new functionality
4. Ensure `npm run build` is green
5. Open a pull request

## Support

- GitHub Issues: https://github.com/codedynasty-dev/tero/issues

---

**Tero** — embedded ACID JSON for the edge.