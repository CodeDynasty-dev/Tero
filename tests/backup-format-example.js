import { Tero } from '../dist/index.js';

async function backupFormatExamples() {
  console.log('📦 Backup Format Options Demo\n');

  try {
    // Initialize database
    const db = new Tero({
      Directory: 'BackupFormatTestDB',
      cacheSize: 50
    });

    // Create some test data
    console.log('📝 Creating test data...');
    await db.create('users');
    await db.create('products');
    await db.create('orders');
    await db.create('settings');

    await db.update('users', {
      user1: { name: 'Alice Johnson', email: 'alice@example.com', role: 'admin' },
      user2: { name: 'Bob Smith', email: 'bob@example.com', role: 'user' },
      user3: { name: 'Charlie Brown', email: 'charlie@example.com', role: 'moderator' }
    });

    await db.update('products', {
      laptop: { name: 'Gaming Laptop', price: 1299, category: 'electronics', stock: 15 },
      mouse: { name: 'Wireless Mouse', price: 49, category: 'electronics', stock: 100 },
      book: { name: 'JavaScript Guide', price: 29, category: 'books', stock: 50 }
    });

    await db.update('orders', {
      order1: { userId: 'user1', items: ['laptop'], total: 1299, status: 'completed' },
      order2: { userId: 'user2', items: ['mouse', 'book'], total: 78, status: 'pending' }
    });

    await db.update('settings', {
      theme: 'dark',
      notifications: true,
      language: 'en',
      timezone: 'UTC'
    });

    console.log('✅ Test data created (4 JSON files)\n');

    // Option 1: Archive Format (ZIP/TAR.GZ) - Recommended for most cases
    console.log('🗜️  OPTION 1: ARCHIVE FORMAT (Single ZIP/TAR.GZ File)');
    console.log('='.repeat(60));

    db.configureAdvancedBackup({
      format: 'archive', // Single compressed file
      localPath: './backups/archive-format',
      retention: '30d',
      compression: true, // Enable compression
      includeMetadata: true
    });

    console.log('📋 Archive Backup Configuration:');
    console.log('  - Format: Single tar.gz file');
    console.log('  - Compression: Enabled');
    console.log('  - All JSON files bundled together');
    console.log('  - Smaller storage footprint');
    console.log('  - Faster for large datasets');
    console.log('  - Better for cloud storage');

    const archiveResult = await db.performAdvancedBackup();
    console.log('\n📦 Archive Backup Result:');
    console.log(`  - Success: ${archiveResult.success}`);
    console.log(`  - Format: ${archiveResult.metadata.format}`);
    console.log(`  - Files included: ${archiveResult.metadata.fileCount}`);
    console.log(`  - Total size: ${(archiveResult.metadata.totalSize / 1024).toFixed(2)} KB`);
    console.log(`  - Checksum: ${archiveResult.metadata.checksum.substring(0, 16)}...`);
    console.log('');

    // Option 2: Individual Format - Better for selective restore
    console.log('📁 OPTION 2: INDIVIDUAL FORMAT (Separate JSON Files)');
    console.log('='.repeat(60));

    db.configureAdvancedBackup({
      format: 'individual', // Separate files
      localPath: './backups/individual-format',
      retention: '30d',
      compression: false, // Individual files are not compressed
      includeMetadata: true // Include .meta files for each JSON
    });

    console.log('📋 Individual Backup Configuration:');
    console.log('  - Format: Separate JSON files');
    console.log('  - Each file backed up individually');
    console.log('  - Includes metadata files (.meta)');
    console.log('  - Better for selective restore');
    console.log('  - Easier to inspect individual files');
    console.log('  - Good for development/debugging');

    const individualResult = await db.performAdvancedBackup();
    console.log('\n📁 Individual Backup Result:');
    console.log(`  - Success: ${individualResult.success}`);
    console.log(`  - Format: ${individualResult.metadata.format}`);
    console.log(`  - Files backed up: ${individualResult.metadata.fileCount}`);
    console.log(`  - Total size: ${(individualResult.metadata.totalSize / 1024).toFixed(2)} KB`);
    console.log('');

    // Comparison and Recommendations
    console.log('⚖️  FORMAT COMPARISON & RECOMMENDATIONS');
    console.log('='.repeat(60));

    console.log('\n🗜️  ARCHIVE FORMAT (tar.gz) - RECOMMENDED FOR:');
    console.log('  ✅ Production environments');
    console.log('  ✅ Cloud storage (S3, R2)');
    console.log('  ✅ Large datasets (100+ files)');
    console.log('  ✅ Automated backups');
    console.log('  ✅ Long-term storage');
    console.log('  ✅ Bandwidth-limited environments');
    console.log('  ✅ When storage space is a concern');

    console.log('\n📁 INDIVIDUAL FORMAT - RECOMMENDED FOR:');
    console.log('  ✅ Development environments');
    console.log('  ✅ Debugging and inspection');
    console.log('  ✅ Selective file restoration');
    console.log('  ✅ Small datasets (< 50 files)');
    console.log('  ✅ When you need to examine specific files');
    console.log('  ✅ Integration with other tools');
    console.log('  ✅ Version control systems');

    // Advanced Configuration Examples
    console.log('\n🔧 ADVANCED CONFIGURATION EXAMPLES');
    console.log('='.repeat(60));

    console.log('\n💾 Local Archive Backup:');
    console.log(`db.configureAdvancedBackup({
  format: 'archive',           // Single compressed file
  localPath: './backups',      // Local directory
  retention: '90d',            // Keep for 90 days
  compression: true,           // Enable compression
  includeMetadata: true        // Include backup metadata
});`);

    console.log('\n☁️  Cloud Archive Backup (AWS S3):');
    console.log(`db.configureAdvancedBackup({
  format: 'archive',           // Recommended for cloud
  retention: '1y',             // Keep for 1 year
  cloudStorage: {
    provider: 'aws-s3',
    region: 'us-east-1',
    bucket: 'my-app-backups',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    pathPrefix: 'database-backups'
  }
});`);

    console.log('\n📂 Local Individual Backup:');
    console.log(`db.configureAdvancedBackup({
  format: 'individual',        // Separate files
  localPath: './dev-backups',  // Development directory
  retention: '7d',             // Keep for 7 days
  includeMetadata: true        // Include .meta files
});`);

    console.log('\n🌐 Cloud Individual Backup (Cloudflare R2):');
    console.log(`db.configureAdvancedBackup({
  format: 'individual',        // For selective access
  retention: '30d',
  cloudStorage: {
    provider: 'cloudflare-r2',
    region: 'auto',
    bucket: 'dev-backups',
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    endpoint: 'https://account-id.r2.cloudflarestorage.com'
  }
});`);

    // Performance Comparison
    console.log('\n📊 PERFORMANCE CHARACTERISTICS');
    console.log('='.repeat(60));

    console.log('\n🗜️  Archive Format Performance:');
    console.log(`  - Backup Speed: Fast (single operation)`);
    console.log(`  - Storage Size: ~60-80% smaller (compressed)`);
    console.log(`  - Upload Speed: Faster (single file)`);
    console.log(`  - Restore Speed: Fast (extract all)`);
    console.log(`  - Selective Restore: Slower (extract all first)`);

    console.log('\n📁 Individual Format Performance:');
    console.log(`  - Backup Speed: Moderate (multiple operations)`);
    console.log(`  - Storage Size: Larger (uncompressed)`);
    console.log(`  - Upload Speed: Slower (multiple files)`);
    console.log(`  - Restore Speed: Moderate (copy files)`);
    console.log(`  - Selective Restore: Very Fast (single file)`);

    // Use Case Examples
    console.log('\n🎯 REAL-WORLD USE CASES');
    console.log('='.repeat(60));

    console.log('\n🏢 Enterprise Production:');
    console.log('  - Format: archive');
    console.log('  - Schedule: Every 6 hours');
    console.log('  - Retention: 90 days');
    console.log('  - Storage: AWS S3 with lifecycle policies');

    console.log('\n🚀 Startup/Small Business:');
    console.log('  - Format: archive');
    console.log('  - Schedule: Daily');
    console.log('  - Retention: 30 days');
    console.log('  - Storage: Cloudflare R2 (cost-effective)');

    console.log('\n👨‍💻 Development Environment:');
    console.log('  - Format: individual');
    console.log('  - Schedule: Before major changes');
    console.log('  - Retention: 7 days');
    console.log('  - Storage: Local filesystem');

    console.log('\n🧪 Testing/Staging:');
    console.log('  - Format: individual');
    console.log('  - Schedule: Before deployments');
    console.log('  - Retention: 14 days');
    console.log('  - Storage: Local + occasional cloud sync');

    // Cleanup
    console.log('\n🧹 Cleaning up...');
    await db.delete('users');
    await db.delete('products');
    await db.delete('orders');
    await db.delete('settings');

    db.destroy();
    console.log('✅ Backup format demo completed successfully!');

  } catch (error) {
    console.error('❌ Demo failed:', error.message);
    console.error('Stack trace:', error.stack);
  }
}

// Quick reference guide
console.log(`
📚 QUICK REFERENCE GUIDE

🔧 Configuration Options:
┌─────────────────┬──────────────┬─────────────────────────────────┐
│ Option          │ Type         │ Description                     │
├─────────────────┼──────────────┼─────────────────────────────────┤
│ format          │ Required     │ 'archive' or 'individual'       │
│ localPath       │ Optional     │ Local backup directory          │
│ retention       │ Optional     │ '7d', '30d', '90d', '1y'        │
│ compression     │ Optional     │ Enable compression (archive)    │
│ includeMetadata │ Optional     │ Include .meta files             │
│ cloudStorage    │ Optional     │ Cloud storage configuration     │
└─────────────────┴──────────────┴─────────────────────────────────┘

⚡ Quick Setup Examples:

// Simple archive backup
db.configureAdvancedBackup({ format: 'archive' });

// Simple individual backup  
db.configureAdvancedBackup({ format: 'individual' });

// Production archive with cloud
db.configureAdvancedBackup({
  format: 'archive',
  retention: '90d',
  cloudStorage: { /* cloud config */ }
});

// Development individual with metadata
db.configureAdvancedBackup({
  format: 'individual',
  localPath: './dev-backups',
  includeMetadata: true
});

🎯 Decision Matrix:
- Need compression? → Use 'archive'
- Need selective restore? → Use 'individual'  
- Cloud storage? → Use 'archive'
- Development/debugging? → Use 'individual'
- Large dataset? → Use 'archive'
- Small dataset? → Either works fine
`);

backupFormatExamples();