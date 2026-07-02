import { exec } from 'child_process';
import { readdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { promisify } from 'util';

const execAsync = promisify(exec);

class TestRunner {
    constructor() {
        this.testsDir = './local_tests';
        this.totalTests = 0;
        this.passedTests = 0;
        this.failedTests = 0;
        this.results = [];
    }

    async runCommand(command) {
        try {
            const { stdout, stderr } = await execAsync(command, {
                timeout: 120000, // 2 minute timeout
                maxBuffer: 1024 * 1024 // 1MB buffer
            });
            return {
                success: true,
                stdout,
                stderr
            };
        } catch (error) {
            return {
                success: false,
                stdout: error.stdout || '',
                stderr: error.stderr || error.message,
                code: error.code
            };
        }
    }

    async getTestFiles() {
        try {
            if (!existsSync(this.testsDir)) {
                console.log(`⚠️ Tests directory '${this.testsDir}' not found`);
                return [];
            }

            const files = await readdir(this.testsDir);

            // Filter for test files (files ending with -test.js)
            const testFiles = files.filter(file =>
                file.endsWith('-test.js') ||
                file === 'test.js'
            );

            // Sort test files to run core tests first
            const sortedTests = testFiles.sort((a, b) => {
                const priority = {
                    'test.js': 1,
                    'acid-test.js': 2,
                    'backup-test.js': 3,
                    'transaction-test.js': 4,
                    'schema-test.js': 5
                };

                return (priority[a] || 999) - (priority[b] || 999);
            });

            return sortedTests.map(file => join(this.testsDir, file));
        } catch (error) {
            console.error('❌ Error reading test directory:', error.message);
            return [];
        }
    }

    async runSingleTest(testFile) {
        const testName = testFile.replace('./tests/', '').replace('.js', '');
        console.log(`\n🧪 Running ${testName}...`);
        console.log('='.repeat(60));

        const startTime = Date.now();

        try {
            const result = await this.runCommand(`node ${testFile}`);
            const duration = Date.now() - startTime;

            if (result.success) {
                console.log(`✅ ${testName} PASSED (${duration}ms)`);
                this.passedTests++;
                this.results.push({
                    name: testName,
                    status: 'PASSED',
                    duration,
                    output: result.stdout
                });
            } else {
                console.log(`❌ ${testName} FAILED (${duration}ms)`);
                if (result.stderr) {
                    console.log('STDERR:', result.stderr);
                }
                this.failedTests++;
                this.results.push({
                    name: testName,
                    status: 'FAILED',
                    duration,
                    output: result.stdout,
                    error: result.stderr
                });
            }
        } catch (error) {
            const duration = Date.now() - startTime;
            console.log(`❌ ${testName} ERROR (${duration}ms)`);
            console.log('Error:', error.message);
            this.failedTests++;
            this.results.push({
                name: testName,
                status: 'ERROR',
                duration,
                error: error.message
            });
        }
    }

    async runAllTests() {
        console.log('🚀 Tero Test Suite');
        console.log('='.repeat(60));
        console.log(`📅 Started at: ${new Date().toISOString()}`);
        console.log('');

        // Check if dist directory exists (compiled files)
        if (!existsSync('./dist')) {
            console.log('🔨 Building project...');
            const buildResult = await this.runCommand('npx tsc');

            if (!buildResult.success) {
                console.log('❌ Build failed!');
                console.log('STDERR:', buildResult.stderr);
                process.exit(1);
            }
            console.log('✅ Build completed successfully');
        } else {
            console.log('✅ Using existing build files');
        }

        // Get all test files
        const testFiles = await this.getTestFiles();

        if (testFiles.length === 0) {
            console.log('⚠️ No test files found');
            return;
        }

        console.log(`📋 Found ${testFiles.length} test files:`);
        testFiles.forEach(file => {
            console.log(`  - ${file.replace('./tests/', '')}`);
        });

        this.totalTests = testFiles.length;
        const overallStartTime = Date.now();

        // Run each test file
        for (const testFile of testFiles) {
            await this.runSingleTest(testFile);
        }

        // Print summary
        const overallDuration = Date.now() - overallStartTime;
        this.printSummary(overallDuration);

        // Exit with appropriate code
        process.exit(this.failedTests > 0 ? 1 : 0);
    }

    printSummary(duration) {
        console.log('\n' + '='.repeat(60));
        console.log('📊 TEST SUMMARY');
        console.log('='.repeat(60));

        console.log(`📅 Completed at: ${new Date().toISOString()}`);
        console.log(`⏱️  Total duration: ${(duration / 1000).toFixed(2)}s`);
        console.log(`📋 Total tests: ${this.totalTests}`);
        console.log(`✅ Passed: ${this.passedTests}`);
        console.log(`❌ Failed: ${this.failedTests}`);
        console.log(`📈 Success rate: ${((this.passedTests / this.totalTests) * 100).toFixed(1)}%`);

        if (this.results.length > 0) {
            console.log('\n📋 Detailed Results:');
            this.results.forEach(result => {
                const status = result.status === 'PASSED' ? '✅' : '❌';
                console.log(`  ${status} ${result.name} (${result.duration}ms)`);
            });
        }

        if (this.failedTests > 0) {
            console.log('\n❌ FAILED TESTS:');
            this.results
                .filter(r => r.status !== 'PASSED')
                .forEach(result => {
                    console.log(`\n🔍 ${result.name}:`);
                    if (result.error) {
                        console.log(`   Error: ${result.error}`);
                    }
                });
        }

        if (this.failedTests === 0) {
            console.log('\n🎉 All tests passed! Tero is ready for production.');
        } else {
            console.log(`\n⚠️  ${this.failedTests} test(s) failed. Please review and fix the issues.`);
        }
    }
}

// Run the test suite
const runner = new TestRunner();
runner.runAllTests().catch(error => {
    console.error('❌ Test runner failed:', error);
    process.exit(1);
});