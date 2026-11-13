// Regression: a transaction that was in flight during a crash must never roll a
// document back on later boots, after newer commits have changed it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'fs';
import { Tero } from '../dist/index.js';

test('in-flight tx at crash does not restore a stale before-image on a later boot', async () => {
  const dir = 'TeroStaleUndo';
  rmSync(dir, { recursive: true, force: true });
  let db = new Tero({ directory: dir, synchronous: 'full', fileLock: false });
  await db.create('k', { v: 1 });
  const tx = db.beginTransaction();
  await tx.update('k', { v: 2 });            // never committed
  db.acidEngine.getWAL().forceFlush();       // its WRITE record is durable
  // crash: no commit, no rollback, no destroy
  db = new Tero({ directory: dir, synchronous: 'full', fileLock: false });
  assert.equal((await db.get('k')).v, 1, 'uncommitted write must not be visible');
  await db.update('k', { v: 3 });            // newer committed value
  db.destroy();
  db = new Tero({ directory: dir, synchronous: 'full', fileLock: false });
  assert.equal((await db.get('k')).v, 3, 'later boot must keep the newest committed value');
  db.destroy();
  rmSync(dir, { recursive: true, force: true });
});
