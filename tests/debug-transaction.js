import { Tero } from '../dist/index.js';
import { existsSync, rmSync } from 'fs';

async function debugTransaction() {
  console.log('🔍 Debugging ACID Transaction Flow...\n');

  const testDbPath = 'DebugTestDB';

  // Clean up any existing test data
  if (existsSync(testDbPath)) rmSync(testDbPath, { recursive: true, force: true });

  const db = new Tero({
    Directory: testDbPath,
    cacheSize: 10
  });

  try {
    console.log('Step 1: Begin transaction');
    const txId = db.beginACIDTransaction();
    console.log(`Transaction ID: ${txId}`);

    console.log('\nStep 2: Write data to transaction');
    const testData = { message: 'Hello ACID', value: 42, timestamp: Date.now() };
    await db.acidWrite(txId, 'debug_test', testData);
    console.log(`Data written: ${JSON.stringify(testData)}`);

    console.log('\nStep 3: Read data from transaction (before commit)');
    const readData = await db.acidRead(txId, 'debug_test');
    console.log(`Data read from transaction: ${JSON.stringify(readData)}`);

    console.log('\nStep 4: Check if file exists on disk (should not exist yet)');
    const fileExists = db.exists('debug_test');
    console.log(`File exists on disk: ${fileExists}`);

    console.log('\nStep 5: Commit transaction');
    await db.commitACIDTransaction(txId);
    console.log('Transaction committed');

    console.log('\nStep 6: Check if file exists on disk (should exist now)');
    const fileExistsAfterCommit = db.exists('debug_test');
    console.log(`File exists on disk after commit: ${fileExistsAfterCommit}`);

    console.log('\nStep 7: Read data using regular get method');
    const persistedData = await db.get('debug_test');
    console.log(`Data read from disk: ${JSON.stringify(persistedData)}`);

    console.log('\nStep 8: Test rollback scenario');
    const txId2 = db.beginACIDTransaction();
    await db.acidWrite(txId2, 'rollback_test', { shouldNotPersist: true });

    const dataBeforeRollback = await db.acidRead(txId2, 'rollback_test');
    console.log(`Data in transaction before rollback: ${JSON.stringify(dataBeforeRollback)}`);

    await db.rollbackACIDTransaction(txId2);

    const dataAfterRollback = await db.get('rollback_test');
    console.log(`Data after rollback: ${dataAfterRollback}`);

  } catch (error) {
    console.error(`❌ Debug failed: ${error.message}`);
    console.error(error.stack);
  } finally {
    // Cleanup
    db.destroy();
    if (existsSync(testDbPath)) rmSync(testDbPath, { recursive: true, force: true });
  }
}

debugTransaction().catch(console.error);