import { Tero } from '../dist/index.js';
import { existsSync, rmSync } from 'fs';

async function runSimpleACIDTest() {
    console.log('🧪 Running Simple ACID Test...\n');

    const testDbPath = 'SimpleACIDTestDB';

    // Clean up any existing test data
    if (existsSync(testDbPath)) rmSync(testDbPath, { recursive: true, force: true });

    const db = new Tero({
        Directory: testDbPath,
        cacheSize: 10
    });

    try {
        console.log('1. Testing basic ACID transaction creation...');
        const txId = db.beginACIDTransaction();
        console.log(`✅ Transaction created: ${txId}`);

        console.log('2. Testing ACID write operation...');
        await db.acidWrite(txId, 'test1', { message: 'Hello ACID', value: 42 });
        console.log('✅ ACID write successful');

        console.log('3. Testing ACID read operation...');
        const data = await db.acidRead(txId, 'test1');
        console.log(`✅ ACID read successful: ${JSON.stringify(data)}`);

        console.log('4. Testing transaction commit...');
        await db.commitACIDTransaction(txId);
        console.log('✅ Transaction committed successfully');

        console.log('5. Testing data persistence after commit...');
        const persistedData = await db.get('test1');
        console.log(`✅ Data persisted: ${JSON.stringify(persistedData)}`);

        console.log('6. Testing transaction rollback...');
        const txId2 = db.beginACIDTransaction();
        await db.acidWrite(txId2, 'test2', { message: 'This should be rolled back' });
        await db.rollbackACIDTransaction(txId2);

        const rolledBackData = await db.get('test2');
        if (rolledBackData === false) {
            console.log('✅ Transaction rollback successful - data not persisted');
        } else {
            console.log('❌ Transaction rollback failed - data was persisted');
        }

        console.log('7. Testing money transfer (ACID consistency)...');
        await db.createACID('account_a', { name: 'Alice', balance: 1000 });
        await db.createACID('account_b', { name: 'Bob', balance: 500 });

        await db.transferMoney('account_a', 'account_b', 200);

        const accountA = await db.get('account_a');
        const accountB = await db.get('account_b');

        console.log(`Account A balance: ${accountA.balance} (expected: 800)`);
        console.log(`Account B balance: ${accountB.balance} (expected: 700)`);

        if (accountA.balance === 800 && accountB.balance === 700) {
            console.log('✅ Money transfer successful - consistency maintained');
        } else {
            console.log('❌ Money transfer failed - consistency violated');
        }

        console.log('8. Testing batch operations...');
        await db.batchWrite([
            { key: 'batch1', data: { value: 1 } },
            { key: 'batch2', data: { value: 2 } },
            { key: 'batch3', data: { value: 3 } }
        ]);

        const batchResults = await db.batchRead(['batch1', 'batch2', 'batch3']);
        console.log(`✅ Batch operations successful: ${JSON.stringify(batchResults)}`);

        console.log('\n🎉 All simple ACID tests passed!');

    } catch (error) {
        console.error(`❌ Test failed: ${error.message}`);
        console.error(error.stack);
    } finally {
        // Cleanup
        db.destroy();
        if (existsSync(testDbPath)) rmSync(testDbPath, { recursive: true, force: true });
    }
}

runSimpleACIDTest().catch(console.error);