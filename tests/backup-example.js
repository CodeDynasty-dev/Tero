import { Tero } from '../dist/index.js';

async function advancedBackupExample() {
  console.log('🚀 Advanced Backup System Demo\n');

  try {
    // Initialize database
    const db = new Tero({
      Directory: 'BackupTestDB',
      cacheSize: 50
    });

    // Create some test data
    console.log('📝 Creating test data...');
    await db.create('users');
    await db.create('products');
    await db.create('orders');

    await db.update('users', {
      user1: { name: 'John Doe', email: 'john@example.com', age: 30 },
      user2: { name: 'Jane Smith', email: 'jane@example.com', age: 25 }
    });

    await db.update('products', {
      laptop: { name: 'Gaming Laptop', price: 1299, stock: 15 },
      mouse: { name: 'Wireless Mouse', price: 49, stock: 100 }
    });

    await db.update('orders', {
      order1: { userId: 'user1', productId: 'laptop', quantity: 1, total: 1299 },
      order2: { userId: 'user2', productId: 'mouse', quantity: 2, total: 98 }
    });

    console.log('✅ Test data created\n');

    // Example 1: Local Archive Backup
    console.log('📦 Example 1: Local Archive Backup');
    db.configureAdvancedBackup({
      format: 'archive',
      localPath: './backups',
      retention: '7d',
      compression: true,
      includeMetadata: true
    });

    const archiveResult = await db.performAdvancedBackup();
    console.log('Archive backup result:', archiveResult);
    console.log('');

    // Example 2: Local Individual Files Backup
    console.log('📁 Example 2: Individual Files Backup');
    db.configureAdvancedBackup({
      format: 'individual',
      localPath: './backups',
      retention: '30d',
      includeMetadata: true
    });

    const individualResult = await db.performAdvancedBackup();
    console.log('Individual backup result:', individualResult);
    console.log('');

    // Example 3: AWS S3 Backup (commented out - requires real credentials)
    console.log('☁️ Example 3: AWS S3 Backup Configuration');
    console.log('(Commented out - requires real AWS credentials)');
    /*
    db.configureAdvancedBackup({
      format: 'archive',
      retention: '90d',
      cloudStorage: {
        provider: 'aws-s3',
        region: 'us-east-1',
        bucket: 'my-tero-backups',
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        pathPrefix: 'production/database-backups'
      }
    });

    const s3Result = await db.performAdvancedBackup();
    console.log('S3 backup result:', s3Result);
    */

    // Example 4: Cloudflare R2 Backup (commented out - requires real credentials)
    console.log('🌐 Example 4: Cloudflare R2 Backup Configuration');
    console.log('(Commented out - requires real R2 credentials)');
    /*
    db.configureAdvancedBackup({
      format: 'individual',
      retention: '1y',
      cloudStorage: {
        provider: 'cloudflare-r2',
        region: 'auto',
        bucket: 'my-r2-backups',
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
        endpoint: 'https://your-account-id.r2.cloudflarestorage.com',
        pathPrefix: 'tero/backups'
      }
    });

    const r2Result = await db.performAdvancedBackup();
    console.log('R2 backup result:', r2Result);
    */

    // Example 5: Scheduled Backups
    console.log('⏰ Example 5: Scheduled Backups');

    // Configure for scheduled backups
    db.configureAdvancedBackup({
      format: 'archive',
      localPath: './scheduled-backups',
      retention: '30d'
    });

    // Schedule hourly backups (for demo, we'll use a short interval)
    console.log('Setting up scheduled backup (every 10 seconds for demo)...');
    const scheduleId = db.scheduleBackup({
      interval: '1h', // In real usage: '1h', '6h', '1d', etc.
      retention: '30d'
    });

    console.log(`Scheduled backup ID: ${scheduleId}`);

    // Wait a bit to see the scheduled backup in action
    console.log('Waiting 3 seconds to demonstrate scheduled backup...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Show scheduled backups
    const scheduled = db.getScheduledBackups();
    console.log('Active scheduled backups:', scheduled);

    // Cancel the scheduled backup
    const cancelled = db.cancelScheduledBackup(scheduleId);
    console.log(`Scheduled backup cancelled: ${cancelled}`);
    console.log('');

    // Example 6: Test Cloud Connection (without real credentials)
    console.log('🔗 Example 6: Testing Cloud Connection');
    const connectionTest = await db.testCloudConnection();
    console.log('Cloud connection test:', connectionTest);
    console.log('');

    // Cleanup
    console.log('🧹 Cleaning up...');
    await db.delete('users');
    await db.delete('products');
    await db.delete('orders');

    // Destroy the database instance
    db.destroy();

    console.log('✅ Advanced backup demo completed successfully!');

  } catch (error) {
    console.error('❌ Demo failed:', error.message);
    console.error('Stack trace:', error.stack);
  }
}

// Configuration examples for different cloud providers
console.log(`
📋 Cloud Storage Configuration Examples:

🔸 AWS S3:
{
  provider: 'aws-s3',
  region: 'us-east-1',
  bucket: 'my-backups',
  accessKeyId: 'AKIA...',
  secretAccessKey: 'your-secret-key',
  pathPrefix: 'tero/prod'
}

🔸 Cloudflare R2:
{
  provider: 'cloudflare-r2',
  region: 'auto',
  bucket: 'my-r2-bucket',
  accessKeyId: 'your-r2-access-key',
  secretAccessKey: 'your-r2-secret-key',
  endpoint: 'https://account-id.r2.cloudflarestorage.com',
  pathPrefix: 'database-backups'
}

🔸 MinIO (Self-hosted S3):
{
  provider: 'aws-s3',
  region: 'us-east-1',
  bucket: 'backups',
  accessKeyId: 'minioadmin',
  secretAccessKey: 'minioadmin',
  endpoint: 'http://localhost:9000',
  pathPrefix: 'tero'
}

⏰ Interval Examples:
- '1h' = Every hour
- '6h' = Every 6 hours  
- '1d' = Daily
- '7d' = Weekly

📅 Retention Examples:
- '7d' = Keep for 7 days
- '30d' = Keep for 30 days
- '90d' = Keep for 3 months
- '1y' = Keep for 1 year
`);

advancedBackupExample();