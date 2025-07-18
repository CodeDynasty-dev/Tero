import { readdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

async function runTests() {
    console.log('🚀 Tero Test Suite');
    console.log('='.repeat(60));
    console.log(`📅 Started at: ${new Date().toISOString()}`);
    console.log('');

    const testsDir = './tests';
    let totalTests = 0;
    let passedTests = 0;
    let failedTests = 0;

    try {
        if (!existsSync(testsDir)) {
            console.log(`⚠️ Tests directory '${testsDir}' not found`);
            return;
        }

        const files = await readdir(testsDir);

        // Filter for test files
        const testFiles = files.filter(file =>
            file.endsWith('-test.js') ||
            file === 'test.js'
        );

        if (testFiles.length === 0) {
            console.log('⚠️ No test files found');
            return;
        }

        console.log(`📋 Found ${testFiles.length} test files:`);
        testFiles.forEach(file => {
            console.log(`  - ${file}`);
        });
        console.log('');

        totalTests = testFiles.length;

        // Import and run each test file
        for (const testFile of testFiles) {
            const testPath = join(testsDir, testFile);
            const testName = testFile.replace('.js', '');

            console.log(`🧪 Running ${testName}...`);

            try {
                // Import the test file
                const testModule = await import(`./${testPath}`);
                console.log(`✅ ${testName} completed`);
                passedTests++;
            } catch (error) {
                console.log(`❌ ${testName} failed: ${error.message}`);
                failedTests++;
            }
        }

        // Print summary
        console.log('\n' + '='.repeat(60));
        console.log('📊 TEST SUMMARY');
        console.log('='.repeat(60));
        console.log(`📋 Total tests: ${totalTests}`);
        console.log(`✅ Passed: ${passedTests}`);
        console.log(`❌ Failed: ${failedTests}`);
        console.log(`📈 Success rate: ${((passedTests / totalTests) * 100).toFixed(1)}%`);

        if (failedTests === 0) {
            console.log('\n🎉 All tests completed successfully!');
        } else {
            console.log(`\n⚠️  ${failedTests} test(s) had issues.`);
            process.exit(1);
        }

    } catch (error) {
        console.error('❌ Test runner failed:', error);
        process.exit(1);
    }
}

runTests();