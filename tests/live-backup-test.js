/**
 * Tero DB — Live Backup (per-second WAL shipping) Test — hardened
 *
 * Coverage:
 *   Phase A — pure WAL shipping incl. ARCHIVE rotation (620 commits > COMMIT_INTERVAL
 *             of 500 forces the engine to rotate its WAL into archives), crash sim,
 *             point-in-time restore, full restore, exists() semantics.
 *   Phase B — automatic initial FULL checkpoint (pre-enable data protected),
 *             incremental checkpoint, DELETE tombstones (deleted docs must STAY
 *             deleted after restore), rolled-back transaction exclusion.
 *   Phase C — API guards: constructor rejects liveBackup without cloudStorage;
 *             intervalMs > 1000 rejected (violates the per-second RPO contract).
 *
 * Run:
 *   S3_ENDPOINT=http://127.0.0.1:9000 S3_BUCKET=tero-live-test \
 *   AWS_ACCESS_KEY_ID=minioadmin AWS_SECRET_ACCESS_KEY=minioadmin \
 *   node local_tests/live-backup-test.js
 *
 * Skips cleanly without env vars (so `npm test` stays green).
 */
import { Tero } from '../dist/index.js';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { rmSync } from 'fs';

const E = process.env;
const ENDPOINT = E.S3_ENDPOINT, BUCKET = E.S3_BUCKET || 'tero-live-test';
const REGION = E.S3_REGION || 'us-east-1';
const AK = E.AWS_ACCESS_KEY_ID, SK = E.AWS_SECRET_ACCESS_KEY;
const hasCreds = ENDPOINT && AK && SK;
let passed = 0, failed = 0;
const ok = n => { passed++; console.log(`  ✅ ${n}`); };
const fail = (n, e) => { failed++; console.log(`  ❌ ${n}: ${e instanceof Error ? e.message : e}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cloud = () => ({ provider: 'aws-s3', region: REGION, bucket: BUCKET, accessKeyId: AK, secretAccessKey: SK, endpoint: ENDPOINT });

async function clearBucket(s3) {
  let t;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, ContinuationToken: t }));
    if (r.Contents?.length) await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: r.Contents.map(o => ({ Key: o.Key })) } }));
    t = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (t);
}

async function phaseA() {
  console.log('\n── Phase A: WAL shipping incl. archive rotation + PIT restore ──');
  const dir = 'TeroLiveA';
  rmSync(dir, { recursive: true, force: true });
  const db = new Tero({ directory: dir, backup: { format: 'individual', cloudStorage: cloud() } });
  // Enable BEFORE any writes — the automatic initial checkpoint captures an empty
  // DB, so ALL 620 docs must come back via WAL replay (archive + current log).
  // This is the only configuration that actually exercises archive shipping.
  db.enableLiveBackup({ consistency: 'per-second', intervalMs: 500 });
  ok('enableLiveBackup(per-second) accepted');
  for (let i = 0; i < 300; i++) await db.create(`a-doc-${i}`, { id: i, label: `A${i}` });
  const tCut = Date.now();
  await sleep(20);
  for (let i = 300; i < 620; i++) await db.create(`a-doc-${i}`, { id: i, label: `A${i}` });
  ok('wrote 620 docs (620 commits > COMMIT_INTERVAL=500 → WAL rotated to archive)');
  await sleep(3000);
  const st = db.getLiveBackupStatus();
  if (st.state === 'healthy' && st.segmentsShipped > 0 && st.errorCount === 0) ok(`shipper healthy: ${st.segmentsShipped} segments shipped, lastLsn=${st.lastShippedLsn}`);
  else fail('shipper should be healthy with segments and no errors', JSON.stringify(st));
  db.destroy();
  rmSync(dir, { recursive: true, force: true });
  ok('crash simulation: instance destroyed + local dir wiped');

  // Point-in-time restore: only docs written before tCut survive.
  const pit = await Tero.restoreFromLiveBackup({ directory: dir, cloudStorage: cloud(), pointInTime: tCut });
  let pitWrong = 0;
  for (let i = 0; i < 300; i += 7) if (!(await pit.get(`a-doc-${i}`))) pitWrong++;
  for (let i = 300; i < 620; i += 7) if (await pit.get(`a-doc-${i}`)) pitWrong++;
  if (pitWrong === 0) ok('point-in-time restore: exactly the pre-cutoff docs present');
  else fail('point-in-time restore', `${pitWrong} sampled docs on the wrong side of the cutoff`);
  pit.destroy();
  rmSync(dir, { recursive: true, force: true });

  // Full restore — proves archive + current-log segments both replayed.
  const r = await Tero.restoreFromLiveBackup({ directory: dir, cloudStorage: cloud() });
  let missing = 0, wrong = 0, existsBad = 0;
  for (let i = 0; i < 620; i++) {
    const d = await r.get(`a-doc-${i}`);
    if (!d) { missing++; continue; }
    if (d.label !== `A${i}`) wrong++;
    if (i % 100 === 0 && await r.exists(`a-doc-${i}`) !== true) existsBad++;
  }
  if (missing === 0 && wrong === 0 && existsBad === 0) ok('full restore: all 620 docs present incl. WAL-archive segments (exists() works)');
  else fail('full restore', `${missing} missing, ${wrong} wrong, ${existsBad} exists() failures`);
  r.destroy();
  rmSync(dir, { recursive: true, force: true });
}


async function phaseB() {
  console.log('\n── Phase B: auto checkpoint, incremental + tombstones, rollback ──');
  const dir = 'TeroLiveB';
  rmSync(dir, { recursive: true, force: true });
  const db = new Tero({ directory: dir, backup: { format: 'individual', cloudStorage: cloud() } });
  for (let i = 0; i < 50; i++) await db.create(`doc-${i}`, { id: i, label: `Document ${i}`, data: 'x'.repeat(100) });
  db.enableLiveBackup({ consistency: 'per-second', intervalMs: 500 });
  // The initial FULL checkpoint fires automatically — poll for it. Without it, a
  // crash before the first manual checkpoint would lose all pre-enable data.
  let autoDone = false;
  for (let t = 0; t < 100 && !autoDone; t++) { await sleep(100); autoDone = db.getLiveBackupStatus().checkpointsTaken >= 1; }
  if (autoDone) ok('automatic initial FULL checkpoint taken (pre-enable data protected)');
  else fail('automatic initial checkpoint should complete', JSON.stringify(db.getLiveBackupStatus()));
  for (let i = 50; i < 100; i++) await db.create(`doc-${i}`, { id: i, label: `Document ${i}`, data: 'y'.repeat(100) });
  const tx = db.beginTransaction();
  for (let i = 0; i < 10; i++) await tx.create(`tx-doc-${i}`, { id: i, source: 'transaction' });
  await db.commitTransaction(tx.getId());
  const rtx = db.beginTransaction();
  for (let i = 0; i < 5; i++) await rtx.create(`rb-doc-${i}`, { id: i, source: 'rolled-back' });
  await db.rollbackTransaction(rtx.getId());
  for (let i = 0; i < 10; i++) await db.update(`doc-${i}`, { id: i, label: `Updated ${i}`, data: 'z'.repeat(100), updated: true });
  for (let i = 50; i < 55; i++) await db.delete(`doc-${i}`);
  ok('wrote 50 more docs + 10 committed tx + 5 rolled-back + 10 updates + 5 deletes');
  await sleep(2500);
  const ck = await db.liveCheckpointToBucket();
  if (!ck.fullUpload && ck.tombstonedDocs === 5 && ck.uploadedDocs > 0 && ck.uploadedDocs <= 125) {
    ok(`incremental checkpoint: ${ck.uploadedDocs} docs uploaded, ${ck.tombstonedDocs} tombstones`);
  } else fail('incremental checkpoint with 5 tombstones', JSON.stringify(ck));
  db.destroy();
  rmSync(dir, { recursive: true, force: true });

  const r = await Tero.restoreFromLiveBackup({ directory: dir, cloudStorage: cloud() });
  let missing = 0, wrong = 0, resurrected = 0, rbLeaked = 0, existsBad = 0;
  for (let i = 0; i < 10; i++) { const d = await r.get(`doc-${i}`); if (!d) { missing++; continue; } if (d.label !== `Updated ${i}` || d.data !== 'z'.repeat(100)) wrong++; }
  for (let i = 10; i < 50; i++) { const d = await r.get(`doc-${i}`); if (!d) { missing++; continue; } if (d.label !== `Document ${i}` || d.data !== 'x'.repeat(100)) wrong++; }
  for (let i = 50; i < 55; i++) { if (await r.get(`doc-${i}`) || await r.exists(`doc-${i}`)) resurrected++; }
  for (let i = 55; i < 100; i++) { const d = await r.get(`doc-${i}`); if (!d) { missing++; continue; } if (d.label !== `Document ${i}` || d.data !== 'y'.repeat(100)) wrong++; }
  for (let i = 0; i < 10; i++) { const d = await r.get(`tx-doc-${i}`); if (!d) { missing++; continue; } if (d.source !== 'transaction') wrong++; }
  for (let i = 0; i < 5; i++) { if (await r.get(`rb-doc-${i}`) || await r.exists(`rb-doc-${i}`)) rbLeaked++; }
  if (await r.exists('doc-0') !== true) existsBad++;
  if (missing === 0 && wrong === 0 && resurrected === 0 && rbLeaked === 0 && existsBad === 0) {
    ok('restore verified: 110 docs correct, 5 deletes STAY deleted, 5 rolled-back docs absent');
  } else {
    fail('restore verification', `missing=${missing} wrong=${wrong} resurrected=${resurrected} rolledBackLeaked=${rbLeaked} existsBad=${existsBad}`);
  }
  r.destroy();
  rmSync(dir, { recursive: true, force: true });
}

async function phaseC() {
  console.log('\n── Phase C: API guards ──');
  let threw = false;
  try { new Tero({ directory: 'TeroLiveC', liveBackup: { consistency: 'per-second' } }); }
  catch (e) { threw = /liveBackup requires/.test(e.message); }
  if (threw) ok('constructor rejects liveBackup without backup.cloudStorage');
  else fail('constructor should reject liveBackup without backup config', 'no throw');
  rmSync('TeroLiveC', { recursive: true, force: true });
  threw = false;
  const db = new Tero({ directory: 'TeroLiveC', backup: { format: 'individual', cloudStorage: cloud() } });
  try { db.enableLiveBackup({ consistency: 'per-second', intervalMs: 5000 }); }
  catch (e) { threw = /per-second consistency contract/.test(e.message); }
  if (threw) ok('intervalMs > 1000 rejected (violates per-second RPO contract)');
  else fail('intervalMs > 1000 should throw', 'no throw');
  db.destroy();
  rmSync('TeroLiveC', { recursive: true, force: true });
}

async function main() {
  if (!hasCreds) { console.log('⏭️  Skipping live-backup test (no S3 env vars).'); return; }
  const s3 = new S3Client({ endpoint: ENDPOINT, region: REGION, credentials: { accessKeyId: AK, secretAccessKey: SK }, forcePathStyle: true });
  console.log('\n🧪 Tero Live Backup (per-second WAL shipping) Test — hardened\n');
  await clearBucket(s3);
  try {
    await phaseA();
    await phaseB();
    await phaseC();
  } catch (err) { fail('unexpected error', err); console.error(err); }
  await clearBucket(s3);
  console.log('\n' + '─'.repeat(60));
  console.log(` Results: ${passed} passed, ${failed} failed`);
  console.log('─'.repeat(60) + '\n');
  if (failed > 0) process.exit(1);
}
main().catch(e => { console.error(e); process.exit(1); });
