import { existsSync } from 'fs';
import { readdir } from 'fs/promises';

async function verifyBuild() {
    console.log('🔍 Verifying Tero Build...\n');

    // Check if dist directory exists
    if (!existsSync('./dist')) {
        console.log('❌ dist directory not found');
        process.exit(1);
    }

    // Check if all required files exist
    const requiredFiles = [
        'dist/index.js',
        'dist/backup.js',
        'dist/transaction.js',
        'dist/schema.js',
        'dist/fn.js'
    ];

    let allFilesExist = true;
    for (const file of requiredFiles) {
        if (existsSync(file)) {
            console.log(`✅ ${file}`);
        } else {
            console.log(`❌ ${file} - MISSING`);
            allFilesExist = false;
        }
    }

    if (!allFilesExist) {
        console.log('\n❌ Build verification failed - missing files');
        process.exit(1);
    }

    // Check if test files exist
    console.log('\n📋 Checking test files...');
    const testFiles = await readdir('./tests');
    const requiredTests = ['test.js', 'backup-test.js', 'transaction-test.js', 'schema-test.js'];

    for (const testFile of requiredTests) {
        if (testFiles.includes(testFile)) {
            console.log(`✅ tests/${testFile}`);
        } else {
            console.log(`❌ tests/${testFile} - MISSING`);
            allFilesExist = false;
        }
    }

    if (!allFilesExist) {
        console.log('\n❌ Test verification failed - missing test files');
        process.exit(1);
    }

    console.log('\n🎉 Build verification successful!');
    console.log('📦 All required files are present');
    console.log('🧪 All test files are available');
    console.log('✅ Tero is ready for testing and deployment');
}

verifyBuild().catch(error => {
    console.error('❌ Verification failed:', error);
    process.exit(1);
});