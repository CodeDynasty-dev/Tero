import { Tero } from './dist/index.js';

async function debugConcurrentUpdates() {
    console.log('🔍 Debugging Concurrent Updates...\n');

    const db = new Tero({
        directory: 'TestDB',
        cacheSize: 10
    });

    // Create initial document
    console.log('📝 Creating initial document...');
    await db.create('concurrent');
    let data = await db.get('concurrent');
    console.log('Initial data:', JSON.stringify(data, null, 2));

    // Test sequential updates first
    console.log('\n📝 Testing sequential updates...');
    for (let i = 0; i < 3; i++) {
        console.log(`\nBefore update ${i}:`);
        data = await db.get('concurrent');
        console.log('  Current data:', JSON.stringify(data, null, 2));
        console.log(`  Updating with: { field${i}: 'value${i}' }`);

        await db.update('concurrent', { [`field${i}`]: `value${i}` });

        data = await db.get('concurrent');
        console.log(`  After update ${i}:`, JSON.stringify(data, null, 2));

        // Check what's actually on disk
        try {
            const fs = await import('fs');
            const fileContent = fs.readFileSync('TestDB/concurrent.json', 'utf-8');
            console.log(`  File on disk:`, JSON.parse(fileContent));
        } catch (e) {
            console.log(`  File on disk: [Error reading file]`);
        }
    }

    // Reset document
    await db.remove('concurrent');
    await db.create('concurrent');
    console.log('\n📝 Reset document for concurrent test...');

    // Test concurrent updates
    console.log('\n📝 Testing concurrent updates...');
    const promises = [];
    for (let i = 0; i < 5; i++) {
        promises.push(db.update('concurrent', { [`field${i}`]: `value${i}` }));
    }

    await Promise.all(promises);
    data = await db.get('concurrent');
    console.log('Final concurrent data:', JSON.stringify(data, null, 2));

    // Check which fields are missing
    console.log('\n🔍 Field check:');
    for (let i = 0; i < 5; i++) {
        const exists = data[`field${i}`] !== undefined;
        console.log(`  field${i}: ${exists ? '✅' : '❌'} ${exists ? data[`field${i}`] : 'MISSING'}`);
    }

    // Clean up
    await db.remove('concurrent');
    db.destroy();
}

debugConcurrentUpdates().catch(console.error);