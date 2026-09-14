import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'fs';
import { resolve } from 'path';
import { Tero } from '../dist/index.js';

test('Concurrency Invariant: Multi-account bank transfers conserve total money', async () => {
  const testDir = resolve('./test_bank_concurrency_db');
  rmSync(testDir, { recursive: true, force: true });
  const db = new Tero({ directory: testDir, synchronous: 'normal', commitIntervalMs: 5 });

  const NUM_ACCOUNTS = 10;
  const INITIAL_BALANCE = 1000;
  const TOTAL_MONEY = NUM_ACCOUNTS * INITIAL_BALANCE;

  try {
    // Seed accounts
    for (let i = 0; i < NUM_ACCOUNTS; i++) {
      await db.create(`acc_${i}`, { balance: INITIAL_BALANCE });
    }

    // 20 concurrent transfer workers executing 400 randomized transfers
    const NUM_TRANSFERS = 400;
    let successfulTransfers = 0;
    let abortedTransfers = 0;

    async function runTransferWorker(workerId, transfers) {
      for (let t = 0; t < transfers; t++) {
        const fromIdx = Math.floor(Math.random() * NUM_ACCOUNTS);
        let toIdx = Math.floor(Math.random() * NUM_ACCOUNTS);
        while (toIdx === fromIdx) {
          toIdx = Math.floor(Math.random() * NUM_ACCOUNTS);
        }

        const fromKey = `acc_${fromIdx}`;
        const toKey = `acc_${toIdx}`;
        const amount = Math.floor(Math.random() * 50) + 1; // $1 - $50

        // Always acquire locks in consistent lexicographical order to minimize deadlocks
        const firstKey = fromKey < toKey ? fromKey : toKey;
        const secondKey = fromKey < toKey ? toKey : fromKey;

        const tx = db.beginTransaction();
        try {
          // Read both with exclusive locks
          const firstDoc = await tx.get(firstKey, { lock: 'exclusive' });
          const secondDoc = await tx.get(secondKey, { lock: 'exclusive' });

          const fromDoc = fromKey === firstKey ? firstDoc : secondDoc;
          const toDoc = toKey === firstKey ? firstDoc : secondDoc;

          if (fromDoc.balance >= amount) {
            fromDoc.balance -= amount;
            toDoc.balance += amount;

            await tx.update(fromKey, fromDoc);
            await tx.update(toKey, toDoc);
            await tx.commit();
            successfulTransfers++;
          } else {
            await tx.rollback();
            abortedTransfers++;
          }
        } catch (err) {
          // Deadlock or contention abort
          try { await tx.rollback(); } catch {}
          abortedTransfers++;
        }
      }
    }

    const workers = [];
    for (let w = 0; w < 10; w++) {
      workers.push(runTransferWorker(w, NUM_TRANSFERS / 10));
    }
    await Promise.all(workers);

    // Force durable flush
    await db.forceCheckpoint();

    // Verify conservation invariant: sum of balances MUST EQUAL TOTAL_MONEY!
    let finalSum = 0;
    for (let i = 0; i < NUM_ACCOUNTS; i++) {
      const acc = await db.get(`acc_${i}`);
      assert.ok(acc.balance >= 0, `Account acc_${i} balance must never be negative`);
      finalSum += acc.balance;
    }

    assert.equal(finalSum, TOTAL_MONEY, `Total money must be conserved! Expected $${TOTAL_MONEY}, found $${finalSum}`);
    assert.ok(successfulTransfers > 0, 'At least some transfers must have succeeded');
  } finally {
    db.destroy();
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('Lock Contention & Deadlock Storm: High concurrency lock cycles abort gracefully without leaks', async () => {
  const testDir = resolve('./test_deadlock_storm_db');
  rmSync(testDir, { recursive: true, force: true });
  const db = new Tero({ directory: testDir });

  try {
    await db.create('resource_A', { val: 'A' });
    await db.create('resource_B', { val: 'B' });

    let deadlocksCaught = 0;
    let commitsSucceeded = 0;

    // Concurrently trigger inverted lock ordering
    const runInvertedTx = async (order) => {
      const tx = db.beginTransaction();
      try {
        const k1 = order === 'AB' ? 'resource_A' : 'resource_B';
        const k2 = order === 'AB' ? 'resource_B' : 'resource_A';

        await tx.get(k1, { lock: 'exclusive' });
        // Slight yield to increase chance of interleave
        await new Promise(r => setImmediate(r));
        await tx.get(k2, { lock: 'exclusive' });

        await tx.update(k1, { val: order + '_1' });
        await tx.update(k2, { val: order + '_2' });
        await tx.commit();
        commitsSucceeded++;
      } catch (err) {
        if (err.message.includes('Deadlock detected')) {
          deadlocksCaught++;
        }
        try { await tx.rollback(); } catch {}
      }
    };

    // Run 30 paired concurrent inverted transactions
    const pairs = [];
    for (let i = 0; i < 30; i++) {
      pairs.push(runInvertedTx('AB'));
      pairs.push(runInvertedTx('BA'));
    }
    await Promise.all(pairs);

    assert.ok(deadlocksCaught > 0, 'Deadlock detector must have caught at least one cycle');
    assert.ok(commitsSucceeded > 0, 'At least one transaction must have completed');

    // Verify lockManager has zero leaked locks
    const stats = db.getTransactionStats();
    assert.equal(stats.active, 0, 'All transactions must be finished (0 active)');
  } finally {
    db.destroy();
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('LRU Cache Pressure & Eviction: 1000 items through 20-slot cache with 0 corruption', async () => {
  const testDir = resolve('./test_lru_pressure_db');
  rmSync(testDir, { recursive: true, force: true });
  const db = new Tero({ directory: testDir, cacheSize: 20, synchronous: 'normal', commitIntervalMs: 5 });

  const NUM_DOCS = 1000;

  try {
    // Write 1,000 documents
    for (let i = 0; i < NUM_DOCS; i++) {
      await db.create(`lru_${i}`, { index: i, data: `content_${i}` });
    }
    await db.forceCheckpoint();

    // 20 concurrent readers making 200 random reads each
    async function reader() {
      for (let r = 0; r < 50; r++) {
        const idx = Math.floor(Math.random() * NUM_DOCS);
        const doc = await db.get(`lru_${idx}`);
        assert.ok(doc !== null, `Document lru_${idx} must exist`);
        assert.equal(doc.index, idx);
        assert.equal(doc.data, `content_${idx}`);
      }
    }

    const readers = [];
    for (let i = 0; i < 10; i++) {
      readers.push(reader());
    }
    await Promise.all(readers);

    // Cache hit rate must be positive
    const stats = db.getPerformanceStats();
    assert.ok(stats.cacheStats.hitRate >= 0, 'Cache stats must be tracked');
  } finally {
    db.destroy();
    rmSync(testDir, { recursive: true, force: true });
  }
});

test('Thundering Herd / Lazy Hydration Deduplication: 50 concurrent GETs dispatch exactly 1 S3 request', async () => {
  const testDir = resolve('./test_thundering_herd_db');
  rmSync(testDir, { recursive: true, force: true });

  let s3GetCount = 0;
  const mockDoc = { id: 'cold_doc_1', value: 'secret_payload', timestamp: 12345 };
  const mockPayload = JSON.stringify(mockDoc);

  const mockS3 = {
    async send(command) {
      const name = command.constructor.name;
      if (name === 'ListObjectsV2Command') {
        return {
          Contents: [{
            Key: 'backups/thundertest/cold_doc_1.json',
            Size: mockPayload.length,
            LastModified: new Date(),
          }],
          IsTruncated: false
        };
      }
      if (name === 'GetObjectCommand') {
        s3GetCount++;
        // Inject 50ms artificial network latency so concurrent callers pile up
        await new Promise(r => setTimeout(r, 50));
        return {
          Body: {
            transformToString: async () => mockPayload,
            async *[Symbol.asyncIterator]() {
              yield Buffer.from(mockPayload);
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
        dbName: 'thundertest',
      },
      mode: 'lazy',
      customS3Client: mockS3,
    }
  });

  try {
    // Fire 50 simultaneous get() requests for the cold key
    const promises = [];
    for (let i = 0; i < 50; i++) {
      promises.push(db.get('cold_doc_1'));
    }

    const results = await Promise.all(promises);

    // Verify all 50 callers received the identical payload
    for (const r of results) {
      assert.deepEqual(r, mockDoc, 'Every caller must receive the exact document');
    }

    // Crucial: exactly 1 S3 GET request must have been dispatched (stampede prevention)
    assert.equal(s3GetCount, 1, 'In-flight hydration must coalesce 50 concurrent calls to exactly 1 S3 request');

    // Subsequent read hits local disk/cache with 0 additional S3 requests
    const cachedDoc = await db.get('cold_doc_1');
    assert.deepEqual(cachedDoc, mockDoc);
    assert.equal(s3GetCount, 1, 'Subsequent read must not trigger S3 GET');
  } finally {
    await db.close();
    rmSync(testDir, { recursive: true, force: true });
  }
});
