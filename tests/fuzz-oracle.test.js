import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'fs';
import { resolve } from 'path';
import { Tero } from '../dist/index.js';

function oracleMerge(target, source) {
  if (source === null || source === undefined) return target;
  if (typeof source !== 'object' || Array.isArray(source)) return source;
  const result = { ...target };
  for (const key in source) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
    if (typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key]) &&
        typeof target[key] === 'object' && target[key] !== null && !Array.isArray(target[key])) {
      result[key] = oracleMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

test('Differential Fuzzing: 1500 randomized operations match in-memory Oracle through multiple restarts', async () => {
  const testDir = resolve('./test_fuzz_oracle_db');
  rmSync(testDir, { recursive: true, force: true });

  let db = new Tero({ directory: testDir, synchronous: 'normal', commitIntervalMs: 5 });
  const oracle = new Map();

  const KEYS = Array.from({ length: 40 }, (_, i) => `fuzz_key_${i}`);
  const NUM_OPS = 1500;

  try {
    for (let step = 1; step <= NUM_OPS; step++) {
      const opChoice = Math.random();
      const key = KEYS[Math.floor(Math.random() * KEYS.length)];

      if (opChoice < 0.35) {
        // Create or Update
        const payload = {
          step,
          val: Math.floor(Math.random() * 10000),
          tag: `str_${Math.random().toString(36).slice(2, 6)}`,
          nested: { count: step % 10 }
        };

        if (!oracle.has(key)) {
          await db.create(key, payload);
          oracle.set(key, payload);
        } else {
          await db.update(key, payload);
          oracle.set(key, oracleMerge(oracle.get(key) || {}, payload));
        }
      } else if (opChoice < 0.50) {
        // Delete
        if (oracle.has(key)) {
          await db.delete(key);
          oracle.delete(key);
        } else {
          assert.equal(db.exists(key), false);
        }
      } else if (opChoice < 0.75) {
        // Read & Invariant Check
        const dbVal = await db.get(key);
        const oracleVal = oracle.get(key) ?? null;
        assert.deepEqual(dbVal, oracleVal, `Step ${step}: db.get(${key}) must match Oracle`);
        assert.equal(db.exists(key), oracle.has(key), `Step ${step}: db.exists(${key}) must match Oracle`);
      } else if (opChoice < 0.95) {
        // Multi-op Transaction with commit or rollback
        const tx = db.beginTransaction();
        const txScratch = new Map();
        const shouldCommit = Math.random() > 0.3; // 70% commit, 30% abort

        try {
          const txKeys = [
            KEYS[Math.floor(Math.random() * KEYS.length)],
            KEYS[Math.floor(Math.random() * KEYS.length)]
          ];

          for (const tKey of txKeys) {
            const tVal = { txStep: step, tag: 'tx_data', num: Math.random() };
            await tx.update(tKey, tVal);
            const prev = txScratch.has(tKey) ? txScratch.get(tKey) : (oracle.get(tKey) || {});
            txScratch.set(tKey, oracleMerge(prev, tVal));
          }

          if (shouldCommit) {
            await tx.commit();
            for (const [k, v] of txScratch.entries()) {
              oracle.set(k, v);
            }
          } else {
            await tx.rollback();
          }
        } catch (e) {
          try { await tx.rollback(); } catch {}
        }
      } else {
        // Simulate database restart / cold reload from disk
        await db.forceCheckpoint();
        db.destroy();
        db = new Tero({ directory: testDir, synchronous: 'normal', commitIntervalMs: 5 });

        // Verify that after restart, every key in Oracle exists in DB
        for (const [oKey, oVal] of oracle.entries()) {
          const loaded = await db.get(oKey);
          assert.deepEqual(loaded, oVal, `Post-restart verification for ${oKey}`);
        }
      }
    }

    // Final end-of-fuzz verification
    await db.forceCheckpoint();
    for (const key of KEYS) {
      const dbVal = await db.get(key);
      const oracleVal = oracle.get(key) ?? null;
      assert.deepEqual(dbVal, oracleVal, `Final audit for ${key}`);
      assert.equal(db.exists(key), oracle.has(key), `Final exists audit for ${key}`);
    }

    const integrity = await db.verifyDataIntegrity();
    assert.equal(integrity.healthy, true, 'Database must be 100% healthy after fuzz test');
    assert.equal(integrity.corruptedFiles.length, 0);
  } finally {
    db.destroy();
    rmSync(testDir, { recursive: true, force: true });
  }
});
