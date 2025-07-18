import { Tero } from '../dist/index.js';

async function runTests() {
  console.log('🧪 Running Tero Tests...\n');

  const db = new Tero({
    Directory: 'TestDB',
    cacheSize: 10
  });

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

  // Test 1: Basic CRUD operations
  await test('Create document', async () => {
    const result = await db.create('test1');
    if (!result) throw new Error('Should return true for new document');
  });

  await test('Update document', async () => {
    await db.update('test1', { name: 'Test User', age: 25 });
  });

  await test('Get document', async () => {
    const data = await db.get('test1');
    if (!data || data.name !== 'Test User') throw new Error('Data mismatch');
  });

  await test('Document exists', async () => {
    const exists = db.exists('test1');
    if (!exists) throw new Error('Document should exist');
  });

  // Test 2: Error handling
  await test('Invalid key validation', async () => {
    try {
      await db.create('../invalid');
      throw new Error('Should have thrown error for invalid key');
    } catch (error) {
      if (!error.message.includes('invalid characters')) throw error;
    }
  });

  await test('Null value validation', async () => {
    try {
      await db.update('test1', null);
      throw new Error('Should have thrown error for null value');
    } catch (error) {
      if (!error.message.includes('cannot be null')) throw error;
    }
  });

  // Test 3: Cache functionality
  await test('Cache stats', async () => {
    const stats = db.getCacheStats();
    if (typeof stats.size !== 'number') throw new Error('Invalid cache stats');
  });

  await test('Cache clear', async () => {
    db.clearCache();
    const stats = db.getCacheStats();
    if (stats.size !== 0) throw new Error('Cache should be empty');
  });

  // Test 4: Backup
  await test('Backup creation', async () => {
    const result = await db.backup();
    if (!result) throw new Error('Backup should succeed');
  });

  // Test 5: Delete
  await test('Delete document', async () => {
    await db.delete('test1');
    const exists = db.exists('test1');
    if (exists) throw new Error('Document should not exist after deletion');
  });

  // Test 6: Concurrent operations
  await test('Concurrent updates', async () => {
    await db.create('concurrent');

    const promises = [];
    for (let i = 0; i < 5; i++) {
      promises.push(db.update('concurrent', { [`field${i}`]: `value${i}` }));
    }

    await Promise.all(promises);
    const data = await db.get('concurrent');

    // Should have all fields
    for (let i = 0; i < 5; i++) {
      if (!data[`field${i}`]) throw new Error(`Missing field${i}`);
    }

    await db.delete('concurrent');
  });

  // Summary
  console.log(`\n📊 Test Results:`);
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`📈 Success Rate: ${((passed / (passed + failed)) * 100).toFixed(1)}%`);

  if (failed === 0) {
    console.log('\n🎉 All tests passed! Tero is production ready.');
  } else {
    console.log('\n⚠️  Some tests failed. Please review the issues.');
    process.exit(1);
  }
}

runTests().catch(console.error);