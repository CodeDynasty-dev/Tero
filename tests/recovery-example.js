import { Tero } from '../dist/index.js';

async function dataRecoveryExamples() {
    console.log('🚀 Tero Data Recovery System Demo\n');

    try {
        // Initialize Tero database
        const db = new Tero({
            Directory: 'RecoveryTestDB',
            cacheSize: 50
        });

        // Create some test data
        console.log('📝 Creating test data...');
        await db.create('users');
        await db.create('products');
        await db.create('orders');

        await db.update('users', {
            user1: { name: 'Alice Johnson', email: 'alice@example.com', role: 'admin' },
            user2: { name: 'Bob Smith', email: 'bob@example.com', role: 'user' }
        });

        await db.update('products', {
            laptop: { name: 'Gaming Laptop', price: 1299, stock: 15 },
            mouse: { name: 'Wireless Mouse', price: 49, stock: 100 }
        });

        await db.update('orders', {
            order1: { userId: 'user1', items: ['laptop'], total: 1299, status: 'completed' }
        });

        console.log('✅ Test data created\n');

        // Example 1: Configure Data Recovery with Cloud Storage
        console.log('☁️ Example 1: Configure Data Recovery');
        console.log('='.repeat(60));

        // Note: In real usage, you would use actual cloud credentials
        console.log('Configuration example (commented out - requires real credentials):');
        console.log(`
db.configureDataRecovery({
  cloudStorage: {
    provider: 'aws-s3',
    region: 'us-east-1',
    bucket: 'my-tero-backups',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    pathPrefix: 'tero-data'
  },
  localPath: './RecoveryTestDB',
  autoRecover: true,
  recoveryTimeout: 30000
});`);

        /*
        // Uncomment and configure with real credentials for actual testing
        db.configureDataRecovery({
          cloudStorage: {
            provider: 'aws-s3',
            region: 'us-east-1',
            bucket: 'your-bucket-name',
            accessKeyId: process.env.AWS_ACCESS_KEY_ID,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            pathPrefix: 'tero-data'
          },
          localPath: './RecoveryTestDB',
          autoRecover: true
        });
        */

        console.log('✅ Data recovery configuration example shown\n');

        // Example 2: Demonstrate getWithRecovery (Cloud as Source of Truth)
        console.log('🔍 Example 2: Cloud as Source of Truth');
        console.log('='.repeat(60));

        console.log('This demonstrates how Tero can automatically recover data from cloud when local files are missing:');

        console.log(`
// Normal get - returns false if file doesn't exist locally
const localData = await db.get('missing-file');
console.log('Local data:', localData); // false

// Get with cloud recovery - checks cloud storage if local file missing
const dataWithRecovery = await db.getWithRecovery('missing-file', {
  fallbackToCloud: true,
  autoRecover: true
});

if (dataWithRecovery) {
  console.log('✅ Data recovered from cloud:', dataWithRecovery);
} else {
  console.log('⚠️ Data not found in cloud either');
}
`);

        // Example 3: Check File Availability
        console.log('📊 Example 3: Check File Availability');
        console.log('='.repeat(60));

        console.log('Check where files exist (local vs cloud):');
        console.log(`
const availability = await db.existsWithCloudCheck('users');
console.log('File availability:', {
  local: availability.local,      // true/false - exists locally
  cloud: availability.cloud,      // true/false - exists in cloud
  canRecover: availability.canRecover  // true if in cloud but not local
});
`);

        // Example 4: Recovery Operations
        console.log('🔄 Example 4: Recovery Operations');
        console.log('='.repeat(60));

        console.log('Various recovery operations:');
        console.log(`
// Recover a specific file from cloud
const recovered = await db.recoverFromCloud('users');
console.log('Single file recovery:', recovered);

// Recover all missing files from cloud
const allRecovered = await db.recoverAllFromCloud();
console.log('Bulk recovery result:', {
  success: allRecovered.success,
  recovered: allRecovered.recovered.length,
  failed: allRecovered.failed.length,
  duration: allRecovered.duration + 'ms'
});

// Recover from archive backup
const archiveRecovered = await db.recoverFromArchive();
console.log('Archive recovery:', archiveRecovered.success);
`);

        // Example 5: Recovery Information
        console.log('📈 Example 5: Recovery Information');
        console.log('='.repeat(60));

        console.log('Get recovery status and information:');
        console.log(`
const recoveryInfo = await db.getRecoveryInfo();
console.log('Recovery Info:', {
  cloudFiles: recoveryInfo.cloudFiles,
  localFiles: recoveryInfo.localFiles,
  missingLocally: recoveryInfo.missingLocally,
  canRecover: recoveryInfo.availableForRecovery.length
});

// List available cloud backups
const cloudBackups = await db.listCloudBackups();
console.log('Available backups:', cloudBackups);
`);

        // Example 6: Production Workflow
        console.log('🏭 Example 6: Production Workflow');
        console.log('='.repeat(60));

        console.log('Typical production workflow with cloud recovery:');
        console.log(`
// 1. Configure both backup and recovery on startup
db.configureAdvancedBackup({
  format: 'individual',  // Better for selective recovery
  cloudStorage: { /* same config as recovery */ },
  retention: '90d'
});

db.configureDataRecovery({
  cloudStorage: { /* same config as backup */ },
  localPath: './data',
  autoRecover: true
});

// 2. Schedule regular backups
db.scheduleBackup({ interval: '6h', retention: '90d' });

// 3. Use getWithRecovery for critical data access
async function getCriticalData(key) {
  return await db.getWithRecovery(key, {
    fallbackToCloud: true,
    autoRecover: true
  });
}

// 4. Monitor recovery status
setInterval(async () => {
  const info = await db.getRecoveryInfo();
  if (info.missingLocally.length > 0) {
    console.log('⚠️ Missing files detected:', info.missingLocally);
    // Optionally trigger recovery
    await db.recoverAllFromCloud();
  }
}, 300000); // Check every 5 minutes
`);

        // Example 7: Disaster Recovery Scenarios
        console.log('🚨 Example 7: Disaster Recovery Scenarios');
        console.log('='.repeat(60));

        console.log('Handle different disaster recovery scenarios:');
        console.log(`
// Scenario 1: Complete local data loss
async function recoverFromCompleteDataLoss() {
  console.log('🚨 Complete data loss detected, starting recovery...');
  
  // Try to recover from most recent archive first
  const archiveResult = await db.recoverFromArchive();
  
  if (archiveResult.success) {
    console.log('✅ Recovered from archive backup');
    return true;
  }
  
  // Fallback to individual file recovery
  const individualResult = await db.recoverAllFromCloud();
  
  if (individualResult.success) {
    console.log('✅ Recovered individual files');
    return true;
  }
  
  console.log('❌ Recovery failed - no data available in cloud');
  return false;
}

// Scenario 2: Partial data loss
async function recoverMissingFiles() {
  const info = await db.getRecoveryInfo();
  
  if (info.missingLocally.length > 0) {
    console.log(\`🔄 Recovering \${info.missingLocally.length} missing files...\`);
    
    for (const key of info.missingLocally) {
      const recovered = await db.recoverFromCloud(key);
      console.log(\`\${recovered ? '✅' : '❌'} \${key}\`);
    }
  }
}

// Scenario 3: Verify data integrity after recovery
async function verifyRecoveredData() {
  const criticalKeys = ['users', 'products', 'orders'];
  
  for (const key of criticalKeys) {
    const data = await db.getWithRecovery(key, { fallbackToCloud: true });
    
    if (data) {
      console.log(\`✅ \${key}: Data available\`);
      // Optionally validate data structure/content
    } else {
      console.log(\`❌ \${key}: Data not recoverable\`);
    }
  }
}
`);

        // Example 8: Configuration Examples for Different Cloud Providers
        console.log('🌐 Example 8: Cloud Provider Configurations');
        console.log('='.repeat(60));

        console.log('Configuration examples for different cloud providers:');
        console.log(`
// AWS S3 Configuration
db.configureDataRecovery({
  cloudStorage: {
    provider: 'aws-s3',
    region: 'us-east-1',
    bucket: 'my-tero-backups',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    pathPrefix: 'production/tero-data'
  },
  localPath: './data',
  autoRecover: true,
  recoveryTimeout: 30000
});

// Cloudflare R2 Configuration
db.configureDataRecovery({
  cloudStorage: {
    provider: 'cloudflare-r2',
    region: 'auto',
    bucket: 'tero-backups',
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    endpoint: 'https://account-id.r2.cloudflarestorage.com',
    pathPrefix: 'tero-recovery'
  },
  localPath: './data',
  autoRecover: true
});

// MinIO (Self-hosted S3) Configuration
db.configureDataRecovery({
  cloudStorage: {
    provider: 'aws-s3',
    region: 'us-east-1',
    bucket: 'tero-backups',
    accessKeyId: 'minioadmin',
    secretAccessKey: 'minioadmin',
    endpoint: 'http://localhost:9000',
    pathPrefix: 'tero-data'
  },
  localPath: './data',
  autoRecover: true
});
`);

        // Cleanup
        console.log('\n🧹 Cleaning up...');
        await db.delete('users');
        await db.delete('products');
        await db.delete('orders');

        db.destroy();
        console.log('✅ Data recovery demo completed successfully!');

    } catch (error) {
        console.error('❌ Demo failed:', error.message);
        console.error('Stack trace:', error.stack);
    }
}

// Key benefits summary
console.log(`
🎯 KEY BENEFITS OF TERO DATA RECOVERY:

✅ CLOUD AS SOURCE OF TRUTH:
   - Automatic fallback to cloud storage when local files missing
   - Seamless data recovery without application downtime
   - Ensures data availability even after local storage failure

✅ FLEXIBLE RECOVERY OPTIONS:
   - Single file recovery for specific missing data
   - Bulk recovery for multiple missing files
   - Archive recovery for complete disaster recovery

✅ PRODUCTION-READY FEATURES:
   - Configurable timeouts and retry mechanisms
   - Detailed recovery reporting and monitoring
   - Support for multiple cloud providers (AWS S3, Cloudflare R2, MinIO)

✅ DEVELOPER-FRIENDLY API:
   - Simple configuration with cloud credentials
   - Intuitive methods for different recovery scenarios
   - Comprehensive error handling and logging

✅ OPERATIONAL BENEFITS:
   - Reduced downtime during data loss incidents
   - Automated recovery processes
   - Clear visibility into data availability status
   - Seamless integration with existing backup workflows

🔧 USAGE PATTERNS:

1. STARTUP CONFIGURATION:
   Configure both backup and recovery with same cloud storage

2. CRITICAL DATA ACCESS:
   Use getWithRecovery() for important data that must be available

3. MONITORING:
   Regular checks for missing files and automatic recovery

4. DISASTER RECOVERY:
   Structured approach to handle complete or partial data loss

5. VERIFICATION:
   Post-recovery validation to ensure data integrity
`);

dataRecoveryExamples();