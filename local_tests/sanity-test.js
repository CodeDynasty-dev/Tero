import { Tero } from '../dist/index.js';
import { existsSync, rmSync, readdirSync } from 'fs';

async function run() {
  console.log('Sanity check after 64-bit checksum migration...\n');

  let pass = 0, fail = 0;
  const test = async (name, fn) => {
    try { await fn(); console.log('✅', name); pass++; }
    catch (e) { console.log('❌', name, '-', e.message); fail++; }
  };

  const dir = 'SanityDB';
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });

  const db = new Tero({ directory: dir, cacheSize: 50, synchronous: 'normal' });

  await test('create + get', async () => {
    if (!(await db.create('user1', { name: 'Alice', balance: 100 }))) throw new Error('create returned false');
    const r = await db.get('user1');
    if (!r || r.name !== 'Alice' || r.balance !== 100) throw new Error('data mismatch');
  });

  await test('update + get', async () => {
    await db.update('user1', { balance: 200 });
    const r = await db.get('user1');
    if (r.balance !== 200) throw new Error('update failed');
  });

  await test('transaction commit', async () => {
    const tx = db.beginTransaction();
    await db.write(tx, 'a1', { v: 1 });
    await db.write(tx, 'a2', { v: 2 });
    await db.commit(tx);
    if ((await db.get('a1')).v !== 1) throw new Error('tx commit failed');
  });

  await test('transaction rollback', async () => {
    const tx = db.beginTransaction();
    await db.write(tx, 'temp', { v: 99 });
    await db.rollback(tx);
    if (await db.get('temp')) throw new Error('rollback failed - data exists');
  });

  await test('exists + remove', async () => {
    if (!db.exists('user1')) throw new Error('exists should return true');
    await db.remove('user1');
    if (db.exists('user1')) throw new Error('remove failed');
  });

  await test('schema validation', async () => {
    db.setSchema('users', {
      name: { type: 'string', required: true },
      age: { type: 'number', min: 0, max: 150 }
    });
    const r = await db.createWithValidation('u1', { name: 'Bob', age: 25 }, { validate: true, schemaName: 'users' });
    if (!r.valid) throw new Error('validation should pass');
    try {
      await db.create('u2', { name: 'X', age: -5 }, { validate: true, schemaName: 'users', strict: true });
      throw new Error('should reject negative age');
    } catch (e) {
      if (!e.message.includes('Schema validation failed')) throw e;
    }
  });

  await test('batch write + read', async () => {
    await db.batchWrite([
      { key: 'p1', data: { v: 1 } },
      { key: 'p2', data: { v: 2 } },
      { key: 'p3', data: { v: 3 } }
    ]);
    const r = await db.batchRead(['p1', 'p2', 'p3']);
    if (r.p1.v !== 1 || r.p2.v !== 2 || r.p3.v !== 3) throw new Error('batch failed');
  });

  await test('crash recovery preserves data', async () => {
    // write data, destroy, re-instantiate — recovery replays WAL entries
    await db.create('persist1', { v: 'kept' });
    await db.create('persist2', { v: 'kept' });
    db.destroy();

    const db2 = new Tero({ directory: dir, cacheSize: 50, synchronous: 'normal' });
    const r1 = await db2.get('persist1');
    const r2 = await db2.get('persist2');
    if (!r1 || r1.v !== 'kept') throw new Error('persist1 lost: ' + JSON.stringify(r1));
    if (!r2 || r2.v !== 'kept') throw new Error('persist2 lost');
    db2.destroy();
  });

  rmSync(dir, { recursive: true, force: true });

  console.log(`\n${pass}/${pass + fail} passed`);
  if (fail > 0) process.exit(1);
}
run().catch(e => { console.error(e); process.exit(1); });