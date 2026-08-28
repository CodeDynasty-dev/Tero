#!/usr/bin/env node
/**
 * S3 live backup round-trip test for Tero.
 *
 * Verifies the v2 "live backup" API against a real S3-compatible endpoint
 * (AWS S3, Cloudflare R2, MinIO, LocalStack — anything speaking the S3 API):
 *
 *   1. configureBackup + testCloudConnection        (bucket reachability)
 *   2. Live writes                                  (single / transactional / batch)
 *   3. backupToBucket()                             (snapshot data files + retained WAL segments + MANIFEST.json)
 *   4. checkpointAndBackupToBucket()                (rotate WAL into a fresh segment, then back it up)
 *   5. Raw S3 verification of the bucket layout     (independent of Tero's own client)
 *   6. Hydrate-on-startup round trip                (fresh node restores all data from the bucket)
 *
 * Configuration via environment variables:
 *
 *   S3_ENDPOINT            optional — e.g. http://127.0.0.1:9000 for MinIO. Omit for real AWS.
 *   S3_REGION              default: us-east-1
 *   S3_BUCKET              required — bucket name (created automatically if missing)
 *   AWS_ACCESS_KEY_ID      required
 *   AWS_SECRET_ACCESS_KEY  required
 *   S3_PATH_PREFIX         optional — default: tero-backups
 *
 * Run against MinIO:
 *   S3_ENDPOINT=http://127.0.0.1:9000 S3_BUCKET=tero-live-backup-test \
 *   AWS_ACCESS_KEY_ID=minioadmin AWS_SECRET_ACCESS_KEY=minioadmin \
 *   node local_tests/s3-live-backup-test.js
 *
 * Run against real AWS:
 *   S3_BUCKET=my-test-bucket AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \
 *   node local_tests/s3-live-backup-test.js
 */

import { Tero } from '../dist/index.js';
import {
    S3Client,
    HeadBucketCommand,
    CreateBucketCommand,
    ListObjectsV2Command,
    GetObjectCommand,
} from '@aws-sdk/client-s3';
import { existsSync, rmSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const ENDPOINT = process.env.S3_ENDPOINT || ''; // empty → real AWS
const REGION = process.env.S3_REGION || 'us-east-1';
const BUCKET = process.env.S3_BUCKET;
const ACCESS_KEY_ID = process.env.AWS_ACCESS_KEY_ID;
const SECRET_ACCESS_KEY = process.env.AWS_SECRET_ACCESS_KEY;
const PATH_PREFIX = process.env.S3_PATH_PREFIX || 'tero-backups';

// NOTE: no dots in directory names — Tero.create() sanitizes directory paths
// and strips characters outside [a-zA-Z0-9_-/]. The restore directory must
// share the BASENAME of the primary directory because Tero derives its cloud
// key prefix from basename(directory): <pathPrefix>/<dbName>/...
const ROOT = resolve('tmp_s3_live_test');
const PRIMARY_DIR = join(ROOT, 'primary');
const RESTORE_PARENT = join(ROOT, 'restore_node');
const RESTORE_DIR = join(RESTORE_PARENT, 'primary'); // same basename as PRIMARY_DIR

const cloudStorage = {
    provider: ENDPOINT ? 'cloudflare-r2' : 'aws-s3', // endpoint → path-style S3-compatible
    region: REGION,
    bucket: BUCKET,
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
    ...(ENDPOINT ? { endpoint: ENDPOINT } : {}),
    pathPrefix: PATH_PREFIX,
};

// Raw S3 client used ONLY for independent verification of what Tero wrote.
const rawS3 = new S3Client({
    region: REGION,
    credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
    ...(ENDPOINT ? { endpoint: ENDPOINT, forcePathStyle: true } : {}),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
    return async () => {
        const t0 = Date.now();
        try {
            await fn();
            passed++;
            console.log(`  ✅ ${name} (${Date.now() - t0}ms)`);
            return true;
        } catch (error) {
            failed++;
            failures.push({ name, error });
            console.error(`  ❌ ${name}: ${error.message}`);
            return false;
        }
    };
}

async function listBucketKeys(prefix) {
    const keys = [];
    let token;
    do {
        const res = await rawS3.send(new ListObjectsV2Command({
            Bucket: BUCKET,
            Prefix: prefix,
            ContinuationToken: token,
        }));
        for (const obj of res.Contents || []) keys.push(obj.Key);
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return keys;
}

async function getObjectText(key) {
    const res = await rawS3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return await res.Body.transformToString('utf-8');
}

async function ensureBucket() {
    try {
        await rawS3.send(new HeadBucketCommand({ Bucket: BUCKET }));
        return;
    } catch (error) {
        const status = error?.$metadata?.httpStatusCode;
        if (status !== 404 && error?.name !== 'NoSuchBucket') throw error;
    }
    await rawS3.send(new CreateBucketCommand({ Bucket: BUCKET }));
    console.log(`  🪣 Created bucket: ${BUCKET}`);
}

function cleanupLocal() {
    for (const dir of [PRIMARY_DIR, RESTORE_PARENT]) {
        try { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

// ---------------------------------------------------------------------------
// Preconditions
// ---------------------------------------------------------------------------

if (!BUCKET || !ACCESS_KEY_ID || !SECRET_ACCESS_KEY) {
    // Skipped, not failed: this test needs a real S3-compatible endpoint and
    // credentials, so bare `npm test` runs (CI, fresh clones) stay green.
    console.log('⏭️  SKIPPED: S3 env vars not set (S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY).');
    console.log('   To run the S3 live backup round-trip test, see the header of this file.');
    process.exit(0);
}

console.log('════════════════════════════════════════════════════════════');
console.log(' Tero — S3 live backup round-trip test');
console.log('════════════════════════════════════════════════════════════');
console.log(`  endpoint:   ${ENDPOINT || '(default AWS)'}`);
console.log(`  bucket:     ${BUCKET}`);
console.log(`  region:     ${REGION}`);
console.log(`  pathPrefix: ${PATH_PREFIX}`);
console.log('');

cleanupLocal();
mkdirSync(PRIMARY_DIR, { recursive: true });
mkdirSync(RESTORE_DIR, { recursive: true });

await check('bucket is reachable (creates it if missing)', ensureBucket)();

// ---------------------------------------------------------------------------
// 1. Live node: writes of every style
// ---------------------------------------------------------------------------

const db = new Tero({
    directory: PRIMARY_DIR,
    cacheSize: 100,
    backup: {
        format: 'archive',
        cloudStorage,
    },
});

const expected = new Map();

await check('live writes: create / transaction / batchWrite', async () => {
    await db.create('user1', { name: 'Alice', age: 30 });
    await db.create('user2', { name: 'Bob', age: 25 });
    await db.create('user3', { name: 'Carol', age: 41 });

    const tx = db.beginTransaction();
    await db.write(tx, 'account:a', { owner: 'Alice', balance: 900 });
    await db.write(tx, 'account:b', { owner: 'Bob', balance: 1100 });
    await db.commit(tx);

    await db.batchWrite([
        { key: 'product:1', data: { name: 'Laptop', price: 999.99 } },
        { key: 'product:2', data: { name: 'Mouse', price: 29.99 } },
        { key: 'product:3', data: { name: 'Keyboard', price: 79.99 } },
    ]);

    for (const key of ['user1', 'user2', 'user3', 'account:a', 'account:b', 'product:1', 'product:2', 'product:3']) {
        expected.set(key, await db.get(key));
    }
    assert.equal(expected.size, 8, '8 live documents should exist locally');
})();

// ---------------------------------------------------------------------------
// 2. Live backup #1 — backupToBucket
// ---------------------------------------------------------------------------

let backup1;
await check('backupToBucket() snapshots live data to S3', async () => {
    backup1 = await db.backupToBucket({ tag: 'live-1' });
    assert.equal(backup1.success, true, `backup should succeed, errors: ${JSON.stringify(backup1.errors)}`);
    assert.equal(backup1.errors.length, 0, 'no upload errors expected');
    assert.ok(backup1.uploadedDataFiles >= 8, `expected >= 8 data files, got ${backup1.uploadedDataFiles}`);
    assert.ok(backup1.duration >= 0);
})();

// ---------------------------------------------------------------------------
// 3. More live writes, then backup #2 with WAL rotation
// ---------------------------------------------------------------------------

await check('writes continue while bucket backup is active', async () => {
    await db.create('user4', { name: 'Dave', age: 19 });
    await db.update('user1', { age: 31 });
    expected.set('user4', await db.get('user4'));
    expected.set('user1', await db.get('user1'));
})();

let backup2;
await check('checkpointAndBackupToBucket() rotates WAL + uploads segment', async () => {
    backup2 = await db.checkpointAndBackupToBucket({ tag: 'live-2' });
    assert.equal(backup2.success, true, `backup should succeed, errors: ${JSON.stringify(backup2.errors)}`);
    assert.ok(backup2.uploadedWALSegments >= 1, `expected >= 1 WAL segment, got ${backup2.uploadedWALSegments}`);
    assert.ok(backup2.uploadedDataFiles >= 9, `expected >= 9 data files (user4 added), got ${backup2.uploadedDataFiles}`);
})();

// ---------------------------------------------------------------------------
// 4. Independent raw-S3 verification of the bucket layout
// ---------------------------------------------------------------------------

const dbPrefix = `${PATH_PREFIX}/primary`;

await check('bucket contains data files, WAL segments and MANIFEST.json', async () => {
    const keys = await listBucketKeys(dbPrefix);
    const dataKeys = keys.filter(k => k.endsWith('.json') && !k.endsWith('MANIFEST.json'));
    const walKeys = keys.filter(k => k.startsWith(`${dbPrefix}/wal/`));

    assert.ok(dataKeys.length >= 9, `expected >= 9 data JSON files under ${dbPrefix}/, got ${dataKeys.length}`);
    assert.ok(walKeys.length >= 1, `expected >= 1 WAL segment under ${dbPrefix}/wal/, got ${walKeys.length}`);

    const manifestKey = `${dbPrefix}/MANIFEST.json`;
    assert.ok(keys.includes(manifestKey), 'MANIFEST.json missing from bucket');

    const manifest = JSON.parse(await getObjectText(manifestKey));
    assert.equal(manifest.tag, 'live-2', 'manifest should reflect the latest backup tag');
    assert.ok(Array.isArray(manifest.dataFiles) && manifest.dataFiles.length >= 9, 'manifest dataFiles incomplete');
    assert.ok(Array.isArray(manifest.walSegments) && manifest.walSegments.length >= 1, 'manifest walSegments incomplete');
    assert.equal(manifest.dbPath, 'primary');

    console.log(`\n     📦 MANIFEST.json:\n${JSON.stringify(manifest, null, 2).split('\n').map(l => '        ' + l).join('\n')}\n`);
})();

// ---------------------------------------------------------------------------
// 5. Round trip — a fresh node hydrates from the bucket
// ---------------------------------------------------------------------------

await check('fresh node hydrates full state from bucket (Tero.create mode: all)', async () => {
    // Simulate a brand-new node: empty local directory, only bucket credentials.
    rmSync(RESTORE_DIR, { recursive: true, force: true });

    const db2 = await Tero.create({
        directory: RESTORE_DIR,
        cacheSize: 100,
        hydrateOnStartup: {
            cloudStorage,
            mode: 'all',          // overwrite local from bucket
            continueOnError: true,
        },
    });

    // Every document written on the live node must be identical after hydration.
    for (const [key, data] of expected) {
        const restored = await db2.get(key);
        assert.deepEqual(restored, data, `restored document "${key}" differs from live state`);
    }

    // Post-backup-1 state must be present too (proves snapshot #2 captured it).
    assert.equal((await db2.get('user1')).age, 31, 'update made after backup #1 should be in the bucket snapshot');
    assert.ok(await db2.get('user4'), 'document created after backup #1 should be in the bucket snapshot');
})();

// ---------------------------------------------------------------------------
// 6. Round trip #2 — hydrate with mode 'missing' (idempotent / incremental)
// ---------------------------------------------------------------------------

await check('hydrate mode missing is idempotent on an already-restored node', async () => {
    const db3 = await Tero.create({
        directory: RESTORE_DIR,
        cacheSize: 100,
        hydrateOnStartup: {
            cloudStorage,
            mode: 'missing',
        },
    });
    const doc = await db3.get('user2');
    assert.deepEqual(doc, expected.get('user2'), 'user2 should still be intact after incremental hydration');
})();

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('────────────────────────────────────────────────────────────');
console.log(` Results: ${passed} passed, ${failed} failed`);
console.log('────────────────────────────────────────────────────────────');

if (failed > 0) {
    for (const f of failures) {
        console.error(`\n ❌ ${f.name}\n    ${f.error.stack}`);
    }
}

cleanupLocal();
console.log(`\n 🧹 Local test directories removed. Bucket contents kept for inspection:`);
console.log(`    s3://${BUCKET}/${dbPrefix}/`);
console.log(`    (delete with: aws s3 rm s3://${BUCKET}/${PATH_PREFIX}/ --recursive)\n`);

process.exit(failed > 0 ? 1 : 0);


