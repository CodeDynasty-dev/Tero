/**
 * Tero DB — Live Backup (per-second WAL shipping) Test
 * Verifies roadmap4.md design end-to-end against a live MinIO server.
 * Run: S3_ENDPOINT=http://127.0.0.1:9000 S3_BUCKET=tero-live-test \
 *   AWS_ACCESS_KEY_ID=minioadmin AWS_SECRET_ACCESS_KEY=minioadmin \
 *   node local_tests/live-backup-test.js
 * Skips cleanly without env vars (so `npm test` stays green).
 */
import { Tero } from '../dist/index.js';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';

const E = process.env;
const ENDPOINT = E.S3_ENDPOINT, BUCKET = E.S3_BUCKET || 'tero-live-test';
const REGION = E.S3_REGION || 'us-east-1';
const AK = E.AWS_ACCESS_KEY_ID, SK = E.AWS_SECRET_ACCESS_KEY;
const hasCreds = ENDPOINT && AK && SK;
let passed = 0, failed = 0;
const ok = n => { passed++; console.log(`  ✅ ${n}`); };
const fail = (n, e) => { failed++; console.log(`  ❌ ${n}: ${e instanceof Error ? e.message : e}`); };

async function clearBucket(s3) {
  let t;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, ContinuationToken: t }));
    if (r.Contents?.length) await s3.send(new DeleteObjectsCommand({ Bucket: BUCKET, Delete: { Objects: r.Contents.map(o => ({ Key: o.Key })) } }));
    t = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (t);
}
async function listKeys(s3, prefix) {
  const keys = []; let t;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: t }));
    if (r.Contents) for (const o of r.Contents) if (o.Key) keys.push(o.Key);
    t = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (t);
  return keys;
}


async function main() {
  if (!hasCreds) { console.log('⏭️  Skipping live-backup test (no S3 env vars).'); return; }
  const s3 = new S3Client({ endpoint: ENDPOINT, region: REGION, credentials: { accessKeyId: AK, secretAccessKey: SK }, forcePathStyle: true });
  console.log('\n🧪 Tero Live Backup (per-second WAL shipping) Test\n');
  const cloud = { provider: 'aws-s3', region: REGION, bucket: BUCKET, accessKeyId: AK, secretAccessKey: SK, endpoint: ENDPOINT };
  await clearBucket(s3);
  const dbDir = 'TeroLiveTest';
  const fs0 = await import('fs'); fs0.rmSync(dbDir, { recursive: true, force: true });
  try {
    const db = new Tero({ directory: dbDir, backup: { format: 'individual', cloudStorage: cloud } });
    for (let i = 0; i < 50; i++) await db.create(`doc-${i}`, { id: i, label: `Document ${i}`, data: 'x'.repeat(100) });
    db.enableLiveBackup({ consistency: 'per-second', intervalMs: 500 });
    ok('enableLiveBackup(per-second) accepted');
    let threw = false;
    try { db.enableLiveBackup({ consistency: 'eventual' }); } catch { threw = true; }
    if (threw) ok("non-'per-second' consistency rejected"); else fail("non-'per-second' should throw");
    for (let i = 50; i < 100; i++) await db.create(`doc-${i}`, { id: i, label: `Document ${i}`, data: 'y'.repeat(100) });
    const tx = db.beginTransaction();
    for (let i = 0; i < 10; i++) await tx.create(`tx-doc-${i}`, { id: i, source: 'transaction' });
    await db.commitTransaction(tx.getId());
    for (let i = 0; i < 10; i++) await db.update(`doc-${i}`, { id: i, label: `Updated ${i}`, data: 'z'.repeat(100), updated: true });
    ok('wrote 100 docs + 10 tx docs + 10 updates after enable');
    await new Promise(r => setTimeout(r, 2500));
    const st = db.getLiveBackupStatus();
    if (st.state === 'healthy' && st.segmentsShipped > 0) ok(`shipper healthy: ${st.segmentsShipped} segments, lastLsn=${st.lastShippedLsn}`);
    else fail('shipper should be healthy', JSON.stringify(st));
    const ck1 = await db.liveCheckpointToBucket();
    if (ck1.fullUpload && ck1.uploadedDocs > 0) ok(`first checkpoint FULL: ${ck1.uploadedDocs} docs in ${ck1.duration}ms`);
    else fail('first checkpoint should be full', JSON.stringify(ck1));
    for (let i = 0; i < 5; i++) await db.update(`doc-${i}`, { id: i, label: `Second update ${i}`, data: 'w'.repeat(50) });
    await new Promise(r => setTimeout(r, 1000));
    const ck2 = await db.liveCheckpointToBucket();
    if (!ck2.fullUpload && ck2.uploadedDocs <= 5) ok(`incremental checkpoint: only ${ck2.uploadedDocs} dirty docs`);
    else fail('second checkpoint should be incremental', JSON.stringify(ck2));
    const all = await listKeys(s3, `tero-backups/${dbDir}/nodes/`);
    const segs = all.filter(k => k.includes('/wal/seg-')), cks = all.filter(k => k.includes('/checkpoint/'));
    if (segs.length > 0) ok(`bucket has ${segs.length} WAL segment(s)`); else fail('bucket should have WAL segments');
    if (cks.length > 0) ok('bucket has checkpoint data'); else fail('bucket should have checkpoint data');
    if (all.some(k => k.endsWith('MANIFEST.json'))) ok('bucket has per-node MANIFEST.json'); else fail('bucket should have MANIFEST.json');
    db.destroy();
    const fs = await import('fs'); fs.rmSync(dbDir, { recursive: true, force: true });
    ok('simulated crash: instance destroyed + local dir wiped');
    const restored = await Tero.restoreFromLiveBackup({ directory: dbDir, cloudStorage: cloud });
    ok('Tero.restoreFromLiveBackup() completed');
    let missing = 0, wrong = 0;
    for (let i = 0; i < 5; i++) { const d = await restored.get(`doc-${i}`); if (!d) { missing++; continue; } if (d.label !== `Second update ${i}` || d.data !== 'w'.repeat(50)) wrong++; }
    for (let i = 5; i < 10; i++) { const d = await restored.get(`doc-${i}`); if (!d) { missing++; continue; } if (d.label !== `Updated ${i}` || d.data !== 'z'.repeat(100)) wrong++; }
    for (let i = 10; i < 50; i++) { const d = await restored.get(`doc-${i}`); if (!d) { missing++; continue; } if (d.label !== `Document ${i}` || d.data !== 'x'.repeat(100)) wrong++; }
    for (let i = 50; i < 100; i++) { const d = await restored.get(`doc-${i}`); if (!d) { missing++; continue; } if (d.label !== `Document ${i}` || d.data !== 'y'.repeat(100)) wrong++; }
    for (let i = 0; i < 10; i++) { const d = await restored.get(`tx-doc-${i}`); if (!d) { missing++; continue; } if (d.source !== 'transaction') wrong++; }
    if (missing === 0 && wrong === 0) ok('all 120 documents restored and verified');
    else fail('restore verification', `${missing} missing, ${wrong} wrong out of 120`);
    restored.destroy(); fs.rmSync(dbDir, { recursive: true, force: true });
  } catch (err) { fail('unexpected error', err); console.error(err); }
  await clearBucket(s3);
  console.log('\n' + '─'.repeat(60));
  console.log(` Results: ${passed} passed, ${failed} failed`);
  console.log('─'.repeat(60) + '\n');
  if (failed > 0) process.exit(1);
}
main().catch(e => { console.error(e); process.exit(1); });
