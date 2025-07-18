import { Tero } from '../dist/index.js';

async function transactionExamples() {
  console.log('🚀 Transaction System Demo\n');

  try {
    // Initialize database
    const db = new Tero({
      Directory: 'TransactionTestDB',
      cacheSize: 50
    });

    // Create some initial data
    console.log('📝 Setting up initial data...');
    await db.create('account1');
    await db.create('account2');
    await db.create('account3');

    await db.update('account1', { name: 'Alice', balance: 1000 });
    await db.update('account2', { name: 'Bob', balance: 500 });
    await db.update('account3', { name: 'Charlie', balance: 750 });

    console.log('✅ Initial data created\n');

    // Example 1: Basic Transaction - Money Transfer
    console.log('💰 Example 1: Money Transfer Transaction');
    const transaction1 = db.beginTransaction();

    try {
      // Read current balances within transaction
      const alice = await transaction1.get('account1');
      const bob = await transaction1.get('account2');

      console.log(`Before: Alice has $${alice.balance}, Bob has $${bob.balance}`);

      // Transfer $200 from Alice to Bob
      const transferAmount = 200;

      if (alice.balance < transferAmount) {
        throw new Error('Insufficient funds');
      }

      await transaction1.update('account1', {
        ...alice,
        balance: alice.balance - transferAmount
      });

      await transaction1.update('account2', {
        ...bob,
        balance: bob.balance + transferAmount
      });

      // Commit the transaction
      await db.commitTransaction(transaction1.getId());

      // Verify the transfer
      const aliceAfter = await db.get('account1');
      const bobAfter = await db.get('account2');
      console.log(`After: Alice has $${aliceAfter.balance}, Bob has $${bobAfter.balance}`);
      console.log('✅ Money transfer completed successfully\n');

    } catch (error) {
      console.error('❌ Transaction failed:', error.message);
      await transaction1.rollback();
    }

    // Example 2: Transaction Rollback
    console.log('🔄 Example 2: Transaction Rollback Demo');
    const transaction2 = db.beginTransaction();

    try {
      const charlie = await transaction2.get('account3');
      console.log(`Charlie's balance before: $${charlie.balance}`);

      // Attempt to transfer more money than available
      await transaction2.update('account3', {
        ...charlie,
        balance: charlie.balance - 1000 // This would make balance negative
      });

      // Simulate a business rule check
      const updatedCharlie = await transaction2.get('account3');
      if (updatedCharlie.balance < 0) {
        throw new Error('Account balance cannot be negative');
      }

      await transaction2.commit();

    } catch (error) {
      console.log(`Expected error: ${error.message}`);
      await transaction2.rollback();

      // Verify rollback worked
      const charlieAfter = await db.get('account3');
      console.log(`Charlie's balance after rollback: $${charlieAfter.balance}`);
      console.log('✅ Transaction rollback successful\n');
    }

    // Example 3: Multiple Operations in One Transaction
    console.log('🔀 Example 3: Multiple Operations Transaction');
    const transaction3 = db.beginTransaction();

    try {
      // Create a new account
      await transaction3.create('account4');
      await transaction3.update('account4', { name: 'David', balance: 0 });

      // Transfer from multiple accounts to the new account
      const alice = await transaction3.get('account1');
      const bob = await transaction3.get('account2');
      const charlie = await transaction3.get('account3');

      const contribution = 50;

      await transaction3.update('account1', {
        ...alice,
        balance: alice.balance - contribution
      });

      await transaction3.update('account2', {
        ...bob,
        balance: bob.balance - contribution
      });

      await transaction3.update('account3', {
        ...charlie,
        balance: charlie.balance - contribution
      });

      await transaction3.update('account4', {
        name: 'David',
        balance: contribution * 3
      });

      await transaction3.commit();

      const david = await db.get('account4');
      console.log(`David's new account balance: $${david.balance}`);
      console.log('✅ Multi-operation transaction completed\n');

    } catch (error) {
      console.error('❌ Multi-operation transaction failed:', error.message);
      await transaction3.rollback();
    }

    // Example 4: Transaction with Timeout
    console.log('⏰ Example 4: Transaction with Timeout');
    const transaction4 = db.beginTransaction({
      timeout: 2000, // 2 seconds timeout
      isolationLevel: 'read_committed'
    });

    try {
      console.log('Starting long-running transaction...');

      await transaction4.update('account1', { lastActivity: new Date().toISOString() });

      // Simulate long processing
      console.log('Simulating 3-second delay (will timeout)...');
      await new Promise(resolve => setTimeout(resolve, 3000));

      await transaction4.commit();

    } catch (error) {
      console.log(`Expected timeout error: ${error.message}`);
      console.log('✅ Transaction timeout handled correctly\n');
    }

    // Example 5: Concurrent Transactions (Lock Demonstration)
    console.log('🔒 Example 5: Concurrent Transaction Locks');

    const tx1 = db.beginTransaction();
    const tx2 = db.beginTransaction();

    try {
      // First transaction locks account1
      await tx1.update('account1', { locked: true });
      console.log('Transaction 1: Locked account1');

      // Second transaction tries to access the same account
      try {
        await tx2.update('account1', { locked: false });
        console.log('Transaction 2: This should not appear');
      } catch (lockError) {
        console.log(`Transaction 2: Expected lock error - ${lockError.message}`);
      }

      // Commit first transaction to release lock
      await tx1.commit();
      console.log('Transaction 1: Committed and released lock');

      // Now second transaction can proceed with a new transaction
      const tx3 = db.beginTransaction();
      await tx3.update('account1', { locked: false });
      await tx3.commit();
      console.log('Transaction 3: Successfully updated account1');
      console.log('✅ Lock mechanism working correctly\n');

    } catch (error) {
      console.error('❌ Concurrent transaction test failed:', error.message);
      await tx1.rollback();
      await tx2.rollback();
    }

    // Example 6: Transaction Statistics
    console.log('📊 Example 6: Transaction Statistics');
    const stats = db.getTransactionStats();
    console.log('Transaction Stats:', stats);

    const activeTransactions = db.getActiveTransactions();
    console.log(`Active transactions: ${activeTransactions.length}`);
    console.log('✅ Statistics retrieved successfully\n');

    // Example 7: Transaction State Inspection
    console.log('🔍 Example 7: Transaction State Inspection');
    const inspectTx = db.beginTransaction();

    console.log(`Transaction ID: ${inspectTx.getId()}`);
    console.log(`Is Active: ${inspectTx.isActive()}`);
    console.log(`Operation Count: ${inspectTx.getOperationCount()}`);
    console.log(`Duration: ${inspectTx.getDuration()}ms`);

    await inspectTx.create('temp_account');
    await inspectTx.update('temp_account', { test: true });

    console.log(`Operations after updates: ${inspectTx.getOperationCount()}`);

    const state = inspectTx.getState();
    console.log('Transaction State:', {
      id: state.id,
      status: state.status,
      operationCount: state.operations.length
    });

    await inspectTx.rollback();
    console.log(`After rollback - Is Active: ${inspectTx.isActive()}`);
    console.log('✅ Transaction inspection completed\n');

    // Cleanup
    console.log('🧹 Cleaning up...');
    await db.delete('account1');
    await db.delete('account2');
    await db.delete('account3');
    await db.delete('account4');

    db.destroy();
    console.log('✅ Transaction demo completed successfully!');

  } catch (error) {
    console.error('❌ Demo failed:', error.message);
    console.error('Stack trace:', error.stack);
  }
}

// Configuration examples
console.log(`
📋 Transaction Configuration Examples:

🔸 Basic Transaction:
const tx = db.beginTransaction();

🔸 Transaction with Timeout:
const tx = db.beginTransaction({ 
  timeout: 30000 // 30 seconds
});

🔸 Transaction with Isolation Level:
const tx = db.beginTransaction({ 
  isolationLevel: 'serializable',
  timeout: 60000
});

🔸 Auto-commit Transaction:
const tx = db.beginTransaction({ 
  autoCommit: true // Commits automatically on success
});

💡 Transaction Methods:
- tx.create(key)           // Create new document
- tx.update(key, data)     // Update document
- tx.delete(key)           // Delete document
- tx.get(key)              // Read document (with transaction isolation)
- tx.commit()              // Commit all changes
- tx.rollback()            // Rollback all changes
- tx.getId()               // Get transaction ID
- tx.isActive()            // Check if transaction is active
- tx.getOperationCount()   // Get number of operations
- tx.getDuration()         // Get transaction duration

🔒 Isolation Levels:
- 'read_committed': Default, prevents dirty reads
- 'serializable': Highest isolation, prevents all anomalies

⏰ Timeout Examples:
- 5000   = 5 seconds
- 30000  = 30 seconds  
- 300000 = 5 minutes
`);

transactionExamples();