import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'fs';
import { resolve } from 'path';
import { createHash } from 'crypto';
import { Tero } from '../dist/index.js';

test('Cloud Resilience: Deleted key in lazy mode never resurrects on subsequent reads or restarts', async () => {
  const testDir = resolve('./test_resurrection_db');
  rmSync(testDir, { recursive: true, force: true });

  const s3Store = new Map();
  const payload = Buffer.from(JSON.stringify({ id: 'resurrect_doc', active: true }));
  const md5 = createHash('md5').update(payload).digest('hex');
  s3Store.set('backups/resurrect_test/resurrect_doc.json', {
    size: payload.length,
    mtime: new Date(),
    eTag: `"${md5}"`,
    data: payload,
  });

  const mockS3 = {
    async send(command) {
      const name = command.constructor.name;
      if (name === 'ListObjectsV2Command') {
        const prefix = command.input.Prefix || '';
        const contents = Array.from(s3Store.entries())
          .filter(([k]) => k.startsWith(prefix))
          .map(([k, v]) => ({
            Key: k,
            Size: v.size,
            LastModified: v.mtime,
            ETag: v.eTag,
          }));
        return { Contents: contents, IsTruncated: false };
      }
      if (name === 'GetObjectCommand') {
        const item = s3Store.get(command.input.Key);
        if (!item) {
          const err = new Error('NoSuchKey');
          err.name = 'NoSuchKey';
          throw err;
        }
        return {
          Body: {
            transformToString: async () => item.data.toString('utf8'),
            async *[Symbol.asyncIterator]() {
              yield item.data;
            }
          }
        };
      }
      if (name === 'DeleteObjectCommand') {
        s3Store.delete(command.input.Key);
        return {};
      }
      return {};
    }
  };

  let db = await Tero.create({
    directory: testDir,
    hydrateOnStartup: {
      cloudStorage: {
        bucket: 'test-bucket',
        region: 'us-east-1',
        accessKeyId: 'k',
        secretAccessKey: 's',
        pathPrefix: 'backups',
        dbName: 'resurrect_test',
      },
      mode: 'lazy',
      customS3Client: mockS3,
    }
  });

  try {
    // Delete without ever reading locally first
    await db.delete('resurrect_doc');

    // Subsequent read must return null
    assert.equal(await db.get('resurrect_doc'), null, 'Deleted key must return null');
    assert.equal(db.exists('resurrect_doc'), false);

    // Verify S3 object was deleted
    assert.equal(s3Store.has('backups/resurrect_test/resurrect_doc.json'), false, 'Key must be deleted from cloud');

    // Restart database in lazy mode
    await db.close();
    db = await Tero.create({
      directory: testDir,
      hydrateOnStartup: {
        cloudStorage: {
          bucket: 'test-bucket',
          region: 'us-east-1',
          accessKeyId: 'k',
          secretAccessKey: 's',
          pathPrefix: 'backups',
          dbName: 'resurrect_test',
        },
        mode: 'lazy',
        customS3Client: mockS3,
      }
    });

    // Read again: must remain null, never resurrect!
    assert.equal(await db.get('resurrect_doc'), null, 'Deleted key must not resurrect across DB reboot');
    assert.equal(db.exists('resurrect_doc'), false);
  } finally {
    await db.close();
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('Cloud Resilience: Overwriting a cold document without prior read writes fresh data', async () => {
  const testDir = resolve('./test_overwrite_cold_db');
  rmSync(testDir, { recursive: true, force: true });

  const s3Store = new Map();
  const oldPayload = Buffer.from(JSON.stringify({ id: 'cold_doc', version: 'v1_old' }));
  const md5 = createHash('md5').update(oldPayload).digest('hex');
  s3Store.set('backups/overwritetest/cold_doc.json', {
    size: oldPayload.length,
    mtime: new Date(),
    eTag: `"${md5}"`,
    data: oldPayload,
  });

  const mockS3 = {
    async send(command) {
      const name = command.constructor.name;
      if (name === 'ListObjectsV2Command') {
        const prefix = command.input.Prefix || '';
        const contents = Array.from(s3Store.entries())
          .filter(([k]) => k.startsWith(prefix))
          .map(([k, v]) => ({
            Key: k,
            Size: v.size,
            LastModified: v.mtime,
            ETag: v.eTag,
          }));
        return { Contents: contents, IsTruncated: false };
      }
      if (name === 'GetObjectCommand') {
        const item = s3Store.get(command.input.Key);
        if (!item) {
          const err = new Error('NoSuchKey');
          err.name = 'NoSuchKey';
          throw err;
        }
        return {
          Body: {
            transformToString: async () => item.data.toString('utf8'),
            async *[Symbol.asyncIterator]() {
              yield item.data;
            }
          }
        };
      }
      return {};
    }
  };

  const db = await Tero.create({
    directory: testDir,
    hydrateOnStartup: {
      cloudStorage: {
        bucket: 'test-bucket',
        region: 'us-east-1',
        accessKeyId: 'k',
        secretAccessKey: 's',
        pathPrefix: 'backups',
        dbName: 'overwritetest',
      },
      mode: 'lazy',
      customS3Client: mockS3,
    }
  });

  try {
    // create() on existing cold document key must return false (already exists)
    const created = await db.create('cold_doc', { id: 'cold_doc', version: 'v2_new' });
    assert.equal(created, false, 'create() must return false when key already exists in cloud');

    // update() on cold document hydrates beforeImage and applies update
    await db.update('cold_doc', { version: 'v2_new' });

    // Read should return v2_new and preserve existing id
    const current = await db.get('cold_doc');
    assert.equal(current.version, 'v2_new', 'Update to cold document must take effect');
    assert.equal(current.id, 'cold_doc', 'Existing fields from cloud must be preserved via deep-merge');
  } finally {
    await db.close();
    rmSync(testDir, { recursive: true, force: true });
  }
});
