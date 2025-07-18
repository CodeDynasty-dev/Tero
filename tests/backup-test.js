import { Tero } from '../dist/index.js';
import { existsSync, rmSync } from 'fs';

async function runBackupTests() {
  console.log('🧪 Running Advanced Backup Tests...\n');

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
  const testDbPath = 'BackupTestDB';
  const backupPath = './test-backups';

  // Clean up any existing test data
  if (existsSync(testDbPath)) rmSync(testDbPath, { recursive: true, force: true });
  if (existsSync(backupPath)) rmSync(backupPath, { recursive: true, force: true });

  const db = new Tero({
    Directory: testDbPath,
    cacheSize: 10
  });

  // Create test data
  await db.create('test1');
  await db.create('test2');
  await db.update('test1', { name: 'Test User 1', data: { value: 100 } });
  await db.update('test2', { name: 'Test User 2', data: { value: 200 } });

  // Test 1: Basic backup configuration
  await test('Configure local archive backup', async () => {
    db.configureAdvancedBackup({
      format: 'archive',
      localPath: backupPath,
      retention: '7d'
    });
  });

  // Test 2: Perform archive backup
  await test('Perform archive backup', async () => {
    const result = await db.performAdvancedBackup();
    if (!result.success) throw new Error('Backup failed');
    if (result.metadata.fileCount !== 2) throw new Error('Wrong file count');
    if (result.metadata.format !== 'archive') throw new Error('Wrong format');
  });

  // Test 3: Configure individual backup
  await test('Configure individual files backup', async () => {
    db.configureAdvancedBackup({
      format: 'individual',
      localPath: backupPath,
      retention: '30d',
      includeMetadata: true
    });
  });

  // Test 4: Perform individual backup
  await test('Perform individual backup', async () => {
    const result = await db.performAdvancedBackup();
    if (!result.success) throw new Error('Backup failed');
    if (result.metadata.format !== 'individual') throw new Error('Wrong format');
  });

  // Test 5: Invalid configuration handling
  await test('Handle invalid backup configuration', async () => {
    try {
      db.configureAdvancedBackup({
        format: 'archive',
        cloudStorage: {
          provider: 'aws-s3',
          region: 'invalid-region',
          bucket: '', // Empty bucket should cause initialization to fail
          accessKeyId: '',
          secretAccessKey: ''
        }
      });

      // Try to test connection which should fail
      const result = await db.testCloudConnection();
      if (result.success) {
        throw new Error('Should have failed with invalid config');
      }
    } catch (error) {
      // This is expected - invalid config should cause issues
      if (error.message === 'Should have failed with invalid config') throw error;
    }
  });

  // Test 6: Scheduled backup
  await test('Schedule backup', async () => {
    db.configureAdvancedBackup({
      format: 'archive',
      localPath: backupPath,
      retention: '7d'
    });

    const scheduleId = db.scheduleBackup({ interval: '1h', retention: '7d' });
    if (!scheduleId) throw new Error('Schedule ID not returned');

    const scheduled = db.getScheduledBackups();
    if (scheduled.length === 0) throw new Error('No scheduled backups found');

    const cancelled = db.cancelScheduledBackup(scheduleId);
    if (!cancelled) throw new Error('Failed to cancel scheduled backup');
  });

  // Test 7: Multiple scheduled backups
  await test('Multiple scheduled backups', async () => {
    // Clear any existing scheduled backups first
    const existingScheduled = db.getScheduledBackups();
    for (const backup of existingScheduled) {
      db.cancelScheduledBackup(backup.id);
    }

    // Wait a moment for cleanup
    await new Promise(resolve => setTimeout(resolve, 100));

    const id1 = db.scheduleBackup({ interval: '1h' });
    const id2 = db.scheduleBackup({ interval: '6h' });

    // Wait a moment for the schedules to be registered
    await new Promise(resolve => setTimeout(resolve, 100));

    const scheduled = db.getScheduledBackups();
    if (scheduled.length < 2) throw new Error(`Expected at least 2 scheduled backups, got ${scheduled.length}`);

    const cancelled1 = db.cancelScheduledBackup(id1);
    const cancelled2 = db.cancelScheduledBackup(id2);

    if (!cancelled1 || !cancelled2) throw new Error('Failed to cancel scheduled backups');
  });

  // Test 8: Backup without configuration
  await test('Backup without configuration error', async () => {
    const freshDb = new Tero({ Directory: 'TempDB' });

    try {
      await freshDb.performAdvancedBackup();
      throw new Error('Should have thrown error');
    } catch (error) {
      if (!error.message.includes('not configured')) throw error;
    }

    freshDb.destroy();
  });

  // Test 9: Test cloud connection without config
  await test('Test cloud connection without config', async () => {
    const result = await db.testCloudConnection();
    if (result.success) throw new Error('Should fail without cloud config');
    if (!result.message.includes('not configured')) throw new Error('Wrong error message');
  });

  // Test 10: Invalid interval/retention formats
  await test('Invalid interval format handling', async () => {
    try {
      db.scheduleBackup({ interval: 'invalid' });
      throw new Error('Should have thrown error for invalid interval');
    } catch (error) {
      if (!error.message.includes('Invalid interval')) throw error;
    }
  });

  // Test 11: Backup empty database
  await test('Backup empty database', async () => {
    const emptyDb = new Tero({ Directory: 'EmptyTestDB' });
    emptyDb.configureAdvancedBackup({
      format: 'archive',
      localPath: backupPath
    });

    const result = await emptyDb.performAdvancedBackup();
    if (result.success) throw new Error('Should fail for empty database');

    emptyDb.destroy();
  });

  // Test 12: Backup metadata validation
  await test('Backup metadata validation', async () => {
    const result = await db.performAdvancedBackup();

    const metadata = result.metadata;
    if (!metadata.timestamp) throw new Error('Missing timestamp');
    if (!metadata.format) throw new Error('Missing format');
    if (typeof metadata.fileCount !== 'number') throw new Error('Invalid fileCount');
    if (typeof metadata.totalSize !== 'number') throw new Error('Invalid totalSize');
  });

  // Test 13: Destroy functionality
  await test('Database destroy functionality', async () => {
    const scheduled = db.getScheduledBackups();
    const initialCount = scheduled.length;

    db.destroy();

    // Should clear cache and cancel scheduled backups
    const stats = db.getCacheStats();
    if (stats.size !== 0) throw new Error('Cache not cleared');
  });

  // Cleanup
  console.log('\n🧹 Cleaning up test files...');
  try {
    if (existsSync(testDbPath)) rmSync(testDbPath, { recursive: true, force: true });
    if (existsSync(backupPath)) rmSync(backupPath, { recursive: true, force: true });
    if (existsSync('EmptyTestDB')) rmSync('EmptyTestDB', { recursive: true, force: true });
    if (existsSync('TempDB')) rmSync('TempDB', { recursive: true, force: true });
  } catch (cleanupError) {
    console.warn('⚠️ Cleanup warning:', cleanupError.message);
  }

  // Summary
  console.log(`\n📊 Backup Test Results:`);
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`📈 Success Rate: ${((passed / (passed + failed)) * 100).toFixed(1)}%`);

  if (failed === 0) {
    console.log('\n🎉 All backup tests passed! Advanced backup system is ready for production.');
  } else {
    console.log('\n⚠️ Some backup tests failed. Please review the issues.');
    process.exit(1);
  }
}

runBackupTests().catch(console.error);