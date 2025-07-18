import { Tero } from '../dist/index.js';
import { existsSync, rmSync } from 'fs';

async function runTransactionTests() {
  console.log('🧪 Running Transaction System Tests...\n');

  let passed = 0;
  let failed = 0;

  // Test helper
  const test = async (name, testFn) => {
    try {
      await testFn();
      console.log(`✅ ${name}`);
      passed++;
    } catch (error) {
      console.log(`❌ ${name}: ${error.message}`);
      failed++;
    }
  };

  // Setup test database
  const testDbPath = 'TransactionTestDB';

  // Clean up any existing test data
  if (existsSync(testDbPath)) rmSync(testDbPath, { recursive: true, force: true });

  const db = new Tero({
    Directory: testDbPath,
    cacheSize: 10
  });

  // Create initial test data
  await db.create('user1');
  await db.create('user2');
  await db.update('user1', { name: 'Alice', balance: 1000 });
  await db.update('user2', { name: 'Bob', balance: 500 });

  // Test 1: Basic transaction creation
  await test('Create transaction', async () => {
    const tx = db.beginTransaction();
    if (!tx.getId()) throw new Error('Transaction ID not generated');
    if (!tx.isActive()) throw new Error('Transaction should be active');
    await db.rollbackTransaction(tx.getId());
  });

  // Test 2: Transaction create operation
  await test('Transaction create operation', async () => {
    const tx = db.beginTransaction();
    await tx.create('user3');
    await tx.update('user3', { name: 'Charlie', balance: 750 });
    await db.commitTransaction(tx.getId());

    const user3 = await db.get('user3');
    if (!user3 || user3.name !== 'Charlie') throw new Error('Create operation failed');

    await db.delete('user3'); // Cleanup
  });

  // Test 3: Transaction update operation
  await test('Transaction update operation', async () => {
    const originalUser = await db.get('user1');

    const tx = db.beginTransaction();
    await tx.update('user1', { balance: originalUser.balance + 100 });
    await db.commitTransaction(tx.getId());

    const updatedUser = await db.get('user1');
    if (updatedUser.balance !== originalUser.balance + 100) {
      throw new Error('Update operation failed');
    }

    // Restore original balance
    await db.update('user1', { balance: originalUser.balance });
  });

  // Test 4: Transaction delete operation
  await test('Transaction delete operation', async () => {
    // Create temporary user
    await db.create('temp_user');
    await db.update('temp_user', { name: 'Temp' });

    const tx = db.beginTransaction();
    await tx.delete('temp_user');
    await db.commitTransaction(tx.getId());

    const exists = db.exists('temp_user');
    if (exists) throw new Error('Delete operation failed - file still exists');
  });

  // Test 5: Transaction rollback
  await test('Transaction rollback', async () => {
    const originalUser = await db.get('user1');

    const tx = db.beginTransaction();
    await tx.update('user1', { balance: 9999 });
    await db.rollbackTransaction(tx.getId());

    const userAfterRollback = await db.get('user1');
    if (userAfterRollback.balance !== originalUser.balance) {
      throw new Error('Rollback failed');
    }
  });

  // Test 6: Transaction isolation (read within transaction)
  await test('Transaction isolation', async () => {
    const originalUser = await db.get('user1');

    const tx = db.beginTransaction();
    await tx.update('user1', { balance: originalUser.balance + 500 });

    // Read within transaction should see the update
    const userInTx = await tx.get('user1');
    if (userInTx.balance !== originalUser.balance + 500) {
      throw new Error('Transaction isolation failed - should see updated value');
    }

    await db.rollbackTransaction(tx.getId());

    // After rollback, should see original value
    const userAfterRollback = await db.get('user1');
    if (userAfterRollback.balance !== originalUser.balance) {
      throw new Error('Transaction isolation failed - rollback did not work');
    }
  });

  // Test 7: Multiple operations in single transaction
  await test('Multiple operations in transaction', async () => {
    const user1 = await db.get('user1');
    const user2 = await db.get('user2');

    const tx = db.beginTransaction();

    // Transfer money
    const transferAmount = 200;
    await tx.update('user1', { ...user1, balance: user1.balance - transferAmount });
    await tx.update('user2', { ...user2, balance: user2.balance + transferAmount });

    if (tx.getOperationCount() !== 2) throw new Error('Wrong operation count');

    await db.commitTransaction(tx.getId());

    const finalUser1 = await db.get('user1');
    const finalUser2 = await db.get('user2');

    if (finalUser1.balance !== user1.balance - transferAmount) {
      throw new Error('User1 balance incorrect');
    }
    if (finalUser2.balance !== user2.balance + transferAmount) {
      throw new Error('User2 balance incorrect');
    }

    // Restore original balances
    await db.update('user1', { balance: user1.balance });
    await db.update('user2', { balance: user2.balance });
  });

  // Test 8: Transaction state inspection
  await test('Transaction state inspection', async () => {
    const tx = db.beginTransaction();

    const initialState = tx.getState();
    if (initialState.status !== 'active') throw new Error('Wrong initial status');
    if (initialState.operations.length !== 0) throw new Error('Should have no operations initially');

    await tx.create('state_test');
    await tx.update('state_test', { value: 123 });

    if (tx.getOperationCount() !== 2) throw new Error('Wrong operation count');

    const duration = tx.getDuration();
    if (typeof duration !== 'number' || duration < 0) throw new Error('Invalid duration');

    await db.rollbackTransaction(tx.getId());

    if (tx.isActive()) throw new Error('Should not be active after rollback');
    if (!tx.isRolledBack()) throw new Error('Should be marked as rolled back');
  });

  // Test 9: Transaction manager statistics
  await test('Transaction manager statistics', async () => {
    const tx1 = db.beginTransaction();
    const tx2 = db.beginTransaction();

    const activeStats = db.getTransactionStats();
    if (activeStats.active < 2) throw new Error('Should have at least 2 active transactions');

    await db.commitTransaction(tx1.getId());
    await db.rollbackTransaction(tx2.getId());

    const finalStats = db.getTransactionStats();
    if (typeof finalStats.committed !== 'number') throw new Error('Invalid committed count');
    if (typeof finalStats.rolledBack !== 'number') throw new Error('Invalid rolled back count');
  });

  // Test 10: Error handling in commit
  await test('Error handling in commit', async () => {
    const tx = db.beginTransaction();

    // Try to create a document that already exists
    try {
      await tx.create('user1'); // user1 already exists
      await db.commitTransaction(tx.getId());
      throw new Error('Should have failed to create existing document');
    } catch (error) {
      if (!error.message.includes('already exists')) throw error;
    }
  });

  // Test 11: Invalid operations after commit
  await test('Invalid operations after commit', async () => {
    const tx = db.beginTransaction();
    await tx.create('commit_test');
    await db.commitTransaction(tx.getId());

    try {
      await tx.update('commit_test', { test: false });
      throw new Error('Should not allow operations after commit');
    } catch (error) {
      if (!error.message.includes('committed')) throw error;
    }

    // Cleanup
    await db.delete('commit_test');
  });

  // Test 12: Invalid operations after rollback
  await test('Invalid operations after rollback', async () => {
    const tx = db.beginTransaction();
    await tx.create('rollback_test');
    await db.rollbackTransaction(tx.getId());

    try {
      await tx.update('rollback_test', { test: false });
      throw new Error('Should not allow operations after rollback');
    } catch (error) {
      if (!error.message.includes('rolled back')) throw error;
    }
  });

  // Test 13: Concurrent transaction handling
  await test('Concurrent transaction handling', async () => {
    const promises = [];

    // Create multiple concurrent transactions
    for (let i = 0; i < 3; i++) {
      promises.push((async () => {
        const tx = db.beginTransaction();
        await tx.create(`concurrent_${i}`);
        await tx.update(`concurrent_${i}`, { value: i });
        await db.commitTransaction(tx.getId());
      })());
    }

    await Promise.all(promises);

    // Verify all documents were created
    for (let i = 0; i < 3; i++) {
      const doc = await db.get(`concurrent_${i}`);
      if (!doc || doc.value !== i) throw new Error(`Concurrent document ${i} failed`);
      await db.delete(`concurrent_${i}`); // Cleanup
    }
  });

  // Test 14: Transaction timeout
  await test('Transaction timeout', async () => {
    const tx = db.beginTransaction({ timeout: 100 }); // 100ms timeout

    await tx.create('timeout_test');

    // Wait longer than timeout
    await new Promise(resolve => setTimeout(resolve, 200));

    // Transaction should be timed out
    if (tx.isActive()) throw new Error('Transaction should have timed out');
  });

  // Test 15: Transaction destroy/cleanup
  await test('Transaction destroy and cleanup', async () => {
    const tx = db.beginTransaction();
    await tx.create('destroy_test');

    // Destroy should rollback active transaction
    tx.destroy();

    if (tx.isActive()) throw new Error('Transaction should not be active after destroy');

    // Verify rollback occurred - document should not exist
    const exists = db.exists('destroy_test');
    if (exists) throw new Error('Destroy should have rolled back changes');
  });

  // Cleanup
  console.log('\n🧹 Cleaning up test files...');
  try {
    db.destroy();
    if (existsSync(testDbPath)) rmSync(testDbPath, { recursive: true, force: true });
  } catch (cleanupError) {
    console.warn('⚠️ Cleanup warning:', cleanupError.message);
  }

  // Summary
  console.log(`\n📊 Transaction Test Results:`);
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`📈 Success Rate: ${((passed / (passed + failed)) * 100).toFixed(1)}%`);

  if (failed === 0) {
    console.log('\n🎉 All transaction tests passed! Transaction system is ready for production.');
  } else {
    console.log('\n⚠️ Some transaction tests failed. Please review the issues.');
    process.exit(1);
  }
}

runTransactionTests().catch(console.error);