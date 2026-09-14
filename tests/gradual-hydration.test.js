import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync, readdirSync } from 'fs';
import { resolve, join } from 'path';
import { Tero } from '../dist/index.js';
import { partitionedPath } from '../dist/acid-engine.js';

// Helper to recursively count JSON data files
function countLocalDataFiles(dir) {
  if (!existsSync(dir)) return 0;
  let count = 0;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      count += countLocalDataFiles(fullPath);
    } else if (entry.name.endsWith('.json') && !entry.name.startsWith('.')) {
      count++;
    }
  }
  return count;
}

// In-memory mock S3 client for tests
function createMockS3(initialFiles = {}) {
  const store = new Map(Object.entries(initialFiles));
  const calls = {
    get: [],
    list: 0,
    head: 0,
  };

  return {
    calls,
    store,
    async send(command) {
      const cmdName = command.constructor.name;
      if (cmdName === 'GetObjectCommand') {
        const key = command.input.Key;
        calls.get.push(key);
        // Extract base filename without prefix
        const base = key.split('/').pop();
        const docKey = base.replace(/\.json$/, '');
        if (store.has(docKey)) {
          const payload = JSON.stringify(store.get(docKey));
          return {
            Body: {
              transformToString: async () => payload,
              async *[Symbol.asyncIterator]() {
                yield Buffer.from(payload);
              }
            }
          };
        }
        const err = new Error('NoSuchKey');
        err.name = 'NoSuchKey';
        throw err;
      }

      if (cmdName === 'ListObjectsV2Command') {
        calls.list++;
        const contents = Array.from(store.entries()).map(([k, v]) => ({
          Key: `test-db/data/${k}.json`,
          Size: Buffer.byteLength(JSON.stringify(v)),
          LastModified: new Date(),
        }));
        return { Contents: contents, IsTruncated: false };
      }

      if (cmdName === 'HeadObjectCommand') {
        calls.head++;
        const key = command.input.Key;
        const base = key.split('/').pop().replace(/\.json$/, '');
        if (store.has(base)) {
          return { ContentLength: 100, LastModified: new Date() };
        }
        const err = new Error('NotFound');
        err.name = 'NotFound';
        throw err;
      }

      throw new Error(`Unhandled command: ${cmdName}`);
    }
  };
}

test('Lazy Hydration: Instant boot with 0 downloads and on-demand streaming', async (t) => {
  const testDir = resolve('./test_lazy_hydration_db');
  rmSync(testDir, { recursive: true, force: true });

  const mockDocs = {};
  for (let i = 1; i <= 50; i++) {
    mockDocs[`user_${i}`] = { id: i, name: `User ${i}`, role: 'engineer' };
  }
  const mockS3 = createMockS3(mockDocs);

  const startBoot = Date.now();
  const db = await Tero.create({
    directory: testDir,
    hydrateOnStartup: {
      cloudStorage: {
        bucket: 'test-bucket',
        region: 'us-east-1',
        accessKeyId: 'mock',
        secretAccessKey: 'mock',
        dbName: 'test-db',
      },
      mode: 'lazy', // default
      customS3Client: mockS3,
    },
  });
  const bootDuration = Date.now() - startBoot;

  try {
    // 1. Boot is instantaneous and downloaded ZERO files
    assert.ok(bootDuration < 100, `Boot must be instant, took ${bootDuration}ms`);
    assert.equal(mockS3.calls.get.length, 0, 'Must have downloaded 0 files during lazy startup');
    assert.equal(countLocalDataFiles(testDir), 0, 'Local directory must contain 0 files at startup');

    // 2. On-demand fetch of cold document
    const doc1 = await db.get('user_1');
    assert.deepEqual(doc1, mockDocs.user_1);
    assert.equal(mockS3.calls.get.length, 1, 'Exactly 1 S3 GET should have occurred');

    // File is now persisted locally
    const localPath = partitionedPath(testDir, 'user_1');
    assert.ok(existsSync(localPath), 'Fetched document must be saved in partitioned local path');

    // 3. Second get hits in-memory cache without S3 calls
    const doc1Repeat = await db.get('user_1');
    assert.deepEqual(doc1Repeat, mockDocs.user_1);
    assert.equal(mockS3.calls.get.length, 1, 'Second get must hit cache; 0 additional S3 calls');

    // 4. Unrequested documents are never downloaded
    assert.equal(countLocalDataFiles(testDir), 1, 'Only requested files must be on disk');

    // 5. Singleflight deduplication under concurrency
    const getCountBefore = mockS3.calls.get.length;
    const concurrentResults = await Promise.all([
      db.get('user_20'),
      db.get('user_20'),
      db.get('user_20'),
      db.get('user_20'),
      db.get('user_20'),
    ]);
    for (const res of concurrentResults) {
      assert.deepEqual(res, mockDocs.user_20);
    }
    const getCountAfter = mockS3.calls.get.length;
    assert.equal(getCountAfter - getCountBefore, 1, 'Singleflight must coalesce concurrent requests into exactly 1 S3 GET');

    // 6. Negative cache for missing keys
    const missingResult = await db.get('non_existent_key_xyz');
    assert.equal(missingResult, null);
    const s3CallsBefore = mockS3.calls.get.length;

    // Subsequent lookups for non-existent key must hit negative cache immediately
    for (let i = 0; i < 10; i++) {
      assert.equal(await db.get('non_existent_key_xyz'), null);
    }
    assert.equal(mockS3.calls.get.length, s3CallsBefore, 'Negative cache must prevent repeated S3 calls for missing keys');

    // 7. Creating key invalidates negative cache
    const created = await db.create('non_existent_key_xyz', { created: true });
    assert.equal(created, true);
    assert.deepEqual(await db.get('non_existent_key_xyz'), { created: true });

  } finally {
    await db.close();
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('Eager Hydration: Pre-downloads files on boot', async (t) => {
  const testDir = resolve('./test_eager_hydration_db');
  rmSync(testDir, { recursive: true, force: true });

  const mockDocs = {
    item_a: { name: 'Item A', qty: 10 },
    item_b: { name: 'Item B', qty: 20 },
  };
  const mockS3 = createMockS3(mockDocs);

  const db = await Tero.create({
    directory: testDir,
    hydrateOnStartup: {
      cloudStorage: {
        bucket: 'test-bucket',
        region: 'us-east-1',
        accessKeyId: 'mock',
        secretAccessKey: 'mock',
        dbName: 'test-db',
      },
      mode: 'eager',
      customS3Client: mockS3,
    },
  });

  try {
    // In eager mode, all files were downloaded before create() returned
    assert.ok(mockS3.calls.list > 0, 'Eager mode must list files');
    assert.ok(mockS3.calls.get.length >= 2, 'Eager mode must download all files up front');
    assert.equal(countLocalDataFiles(testDir), 2, 'Both files must be on disk at boot');

    // Reads hit disk/cache with 0 additional S3 calls
    const s3Calls = mockS3.calls.get.length;
    assert.deepEqual(await db.get('item_a'), mockDocs.item_a);
    assert.deepEqual(await db.get('item_b'), mockDocs.item_b);
    assert.equal(mockS3.calls.get.length, s3Calls, 'Reads must not trigger additional S3 calls in eager mode');
  } finally {
    await db.close();
    rmSync(testDir, { recursive: true, force: true });
  }
});
