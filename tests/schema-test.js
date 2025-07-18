import { Tero } from '../dist/index.js';
import { existsSync, rmSync } from 'fs';

async function runSchemaTests() {
    console.log('🧪 Running Schema Validation Tests...\n');

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
    const testDbPath = 'SchemaTestDB';

    // Clean up any existing test data
    if (existsSync(testDbPath)) rmSync(testDbPath, { recursive: true, force: true });

    const db = new Tero({
        Directory: testDbPath,
        cacheSize: 10
    });

    // Test 1: Basic schema definition
    await test('Define basic schema', async () => {
        const userSchema = {
            name: { type: 'string', required: true },
            age: { type: 'number', min: 0, max: 150 },
            email: { type: 'string', format: 'email' }
        };

        db.setSchema('users', userSchema);

        if (!db.hasSchema('users')) throw new Error('Schema not set');

        const retrievedSchema = db.getSchema('users');
        if (!retrievedSchema || !retrievedSchema.name) throw new Error('Schema not retrieved correctly');
    });

    // Test 2: Valid data validation
    await test('Validate valid data', async () => {
        const validData = {
            name: 'John Doe',
            age: 30,
            email: 'john@example.com'
        };

        const result = db.validateData('users', validData);
        if (!result.valid) throw new Error('Valid data should pass validation');
        if (result.errors.length > 0) throw new Error('Valid data should have no errors');
    });

    // Test 3: Invalid data validation
    await test('Validate invalid data', async () => {
        const invalidData = {
            name: '', // Empty required field
            age: -5, // Below minimum
            email: 'invalid-email' // Invalid format
        };

        const result = db.validateData('users', invalidData);
        if (result.valid) throw new Error('Invalid data should fail validation');
        if (result.errors.length === 0) throw new Error('Invalid data should have errors');
    });

    // Test 4: Required field validation
    await test('Required field validation', async () => {
        const missingRequired = {
            age: 25,
            email: 'test@example.com'
            // name is missing but required
        };

        const result = db.validateData('users', missingRequired);
        if (result.valid) throw new Error('Missing required field should fail validation');

        const nameError = result.errors.find(e => e.field === 'name');
        if (!nameError) throw new Error('Should have error for missing name field');
    });

    // Test 5: Default values
    await test('Default values application', async () => {
        const schemaWithDefaults = {
            name: { type: 'string', required: true },
            status: { type: 'string', default: 'active' },
            count: { type: 'number', default: 0 }
        };

        db.setSchema('items', schemaWithDefaults);

        const dataWithoutDefaults = { name: 'Test Item' };
        const result = db.validateData('items', dataWithoutDefaults);

        if (!result.valid) throw new Error('Data with defaults should be valid');
        if (result.data.status !== 'active') throw new Error('Default status not applied');
        if (result.data.count !== 0) throw new Error('Default count not applied');
    });

    // Test 6: Enum validation
    await test('Enum validation', async () => {
        const enumSchema = {
            role: {
                type: 'string',
                enum: ['admin', 'user', 'moderator'],
                required: true
            }
        };

        db.setSchema('roles', enumSchema);

        // Valid enum value
        const validEnum = { role: 'admin' };
        const validResult = db.validateData('roles', validEnum);
        if (!validResult.valid) throw new Error('Valid enum should pass');

        // Invalid enum value
        const invalidEnum = { role: 'superuser' };
        const invalidResult = db.validateData('roles', invalidEnum);
        if (invalidResult.valid) throw new Error('Invalid enum should fail');
    });

    // Test 7: Number range validation
    await test('Number range validation', async () => {
        const rangeSchema = {
            score: { type: 'number', min: 0, max: 100, required: true }
        };

        db.setSchema('scores', rangeSchema);

        // Valid range
        const validScore = { score: 85 };
        const validResult = db.validateData('scores', validScore);
        if (!validResult.valid) throw new Error('Valid range should pass');

        // Below minimum
        const belowMin = { score: -10 };
        const belowResult = db.validateData('scores', belowMin);
        if (belowResult.valid) throw new Error('Below minimum should fail');

        // Above maximum
        const aboveMax = { score: 150 };
        const aboveResult = db.validateData('scores', aboveMax);
        if (aboveResult.valid) throw new Error('Above maximum should fail');
    });

    // Test 8: String length validation
    await test('String length validation', async () => {
        const stringSchema = {
            username: {
                type: 'string',
                min: 3,
                max: 20,
                required: true
            }
        };

        db.setSchema('usernames', stringSchema);

        // Valid length
        const validLength = { username: 'johndoe' };
        const validResult = db.validateData('usernames', validLength);
        if (!validResult.valid) throw new Error('Valid length should pass');

        // Too short
        const tooShort = { username: 'jo' };
        const shortResult = db.validateData('usernames', tooShort);
        if (shortResult.valid) throw new Error('Too short should fail');

        // Too long
        const tooLong = { username: 'a'.repeat(25) };
        const longResult = db.validateData('usernames', tooLong);
        if (longResult.valid) throw new Error('Too long should fail');
    });

    // Test 9: Format validation
    await test('Format validation', async () => {
        const formatSchema = {
            email: { type: 'string', format: 'email' },
            website: { type: 'string', format: 'url' },
            userId: { type: 'string', format: 'uuid' }
        };

        db.setSchema('formats', formatSchema);

        // Valid formats
        const validFormats = {
            email: 'test@example.com',
            website: 'https://example.com',
            userId: '123e4567-e89b-12d3-a456-426614174000'
        };
        const validResult = db.validateData('formats', validFormats);
        if (!validResult.valid) throw new Error('Valid formats should pass');

        // Invalid email
        const invalidEmail = { email: 'invalid-email' };
        const emailResult = db.validateData('formats', invalidEmail);
        if (emailResult.valid) throw new Error('Invalid email should fail');

        // Invalid URL
        const invalidUrl = { website: 'not-a-url' };
        const urlResult = db.validateData('formats', invalidUrl);
        if (urlResult.valid) throw new Error('Invalid URL should fail');
    });

    // Test 10: Array validation
    await test('Array validation', async () => {
        const arraySchema = {
            tags: {
                type: 'array',
                items: { type: 'string' },
                min: 1,
                max: 5
            }
        };

        db.setSchema('arrays', arraySchema);

        // Valid array
        const validArray = { tags: ['tag1', 'tag2', 'tag3'] };
        const validResult = db.validateData('arrays', validArray);
        if (!validResult.valid) throw new Error('Valid array should pass');

        // Empty array (below minimum)
        const emptyArray = { tags: [] };
        const emptyResult = db.validateData('arrays', emptyArray);
        if (emptyResult.valid) throw new Error('Empty array should fail');

        // Too many items
        const tooManyItems = { tags: ['1', '2', '3', '4', '5', '6'] };
        const tooManyResult = db.validateData('arrays', tooManyItems);
        if (tooManyResult.valid) throw new Error('Too many items should fail');
    });

    // Test 11: Nested object validation
    await test('Nested object validation', async () => {
        const nestedSchema = {
            user: {
                type: 'object',
                properties: {
                    name: { type: 'string', required: true },
                    contact: {
                        type: 'object',
                        properties: {
                            email: { type: 'string', format: 'email', required: true },
                            phone: { type: 'string' }
                        }
                    }
                }
            }
        };

        db.setSchema('nested', nestedSchema);

        // Valid nested object
        const validNested = {
            user: {
                name: 'John Doe',
                contact: {
                    email: 'john@example.com',
                    phone: '555-1234'
                }
            }
        };
        const validResult = db.validateData('nested', validNested);
        if (!validResult.valid) throw new Error('Valid nested object should pass');

        // Invalid nested email
        const invalidNested = {
            user: {
                name: 'John Doe',
                contact: {
                    email: 'invalid-email'
                }
            }
        };
        const invalidResult = db.validateData('nested', invalidNested);
        if (invalidResult.valid) throw new Error('Invalid nested email should fail');
    });

    // Test 12: Custom validation function
    await test('Custom validation function', async () => {
        const customSchema = {
            evenNumber: {
                type: 'number',
                custom: (value) => value % 2 === 0 || 'Number must be even'
            }
        };

        db.setSchema('custom', customSchema);

        // Valid even number
        const evenNum = { evenNumber: 42 };
        const evenResult = db.validateData('custom', evenNum);
        if (!evenResult.valid) throw new Error('Even number should pass custom validation');

        // Invalid odd number
        const oddNum = { evenNumber: 43 };
        const oddResult = db.validateData('custom', oddNum);
        if (oddResult.valid) throw new Error('Odd number should fail custom validation');
    });

    // Test 13: Pattern validation
    await test('Pattern validation', async () => {
        const patternSchema = {
            productCode: {
                type: 'string',
                pattern: '^PROD-[0-9]{4}$'
            }
        };

        db.setSchema('patterns', patternSchema);

        // Valid pattern
        const validPattern = { productCode: 'PROD-1234' };
        const validResult = db.validateData('patterns', validPattern);
        if (!validResult.valid) throw new Error('Valid pattern should pass');

        // Invalid pattern
        const invalidPattern = { productCode: 'INVALID-CODE' };
        const invalidResult = db.validateData('patterns', invalidPattern);
        if (invalidResult.valid) throw new Error('Invalid pattern should fail');
    });

    // Test 14: Date validation
    await test('Date validation', async () => {
        const dateSchema = {
            createdAt: { type: 'date', required: true },
            updatedAt: { type: 'date' }
        };

        db.setSchema('dates', dateSchema);

        // Valid dates
        const validDates = {
            createdAt: new Date(),
            updatedAt: '2023-12-01T10:00:00Z'
        };
        const validResult = db.validateData('dates', validDates);
        if (!validResult.valid) throw new Error('Valid dates should pass');

        // Invalid date
        const invalidDate = { createdAt: 'not-a-date' };
        const invalidResult = db.validateData('dates', invalidDate);
        if (invalidResult.valid) throw new Error('Invalid date should fail');
    });

    // Test 15: Schema management operations
    await test('Schema management operations', async () => {
        // List schemas
        const schemas = db.listSchemas();
        if (!Array.isArray(schemas)) throw new Error('listSchemas should return array');
        if (schemas.length === 0) throw new Error('Should have schemas defined');

        // Get schema stats
        const stats = db.getSchemaStats();
        if (typeof stats.totalSchemas !== 'number') throw new Error('Invalid schema stats');
        if (stats.totalSchemas === 0) throw new Error('Should have schemas in stats');

        // Export schemas
        const exported = db.exportSchemas();
        if (typeof exported !== 'object') throw new Error('Export should return object');

        // Remove schema
        const removed = db.removeSchema('users');
        if (!removed) throw new Error('Should successfully remove schema');
        if (db.hasSchema('users')) throw new Error('Schema should be removed');
    });

    // Test 16: Integration with database operations
    await test('Integration with database operations', async () => {
        const integrationSchema = {
            title: { type: 'string', required: true, min: 1 },
            count: { type: 'number', default: 0 }
        };

        db.setSchema('integration', integrationSchema);

        // Create with validation
        const createResult = await db.createWithValidation('test_doc', {
            title: 'Test Document'
        }, {
            validate: true,
            schemaName: 'integration'
        });

        if (!createResult.valid) throw new Error('Create with validation should succeed');
        if (createResult.data.count !== 0) throw new Error('Default value not applied');

        // Update with validation
        const updateResult = await db.updateWithValidation('test_doc', {
            title: 'Updated Document',
            count: 5
        }, {
            validate: true,
            schemaName: 'integration'
        });

        if (!updateResult.valid) throw new Error('Update with validation should succeed');

        // Try invalid update
        const invalidUpdate = await db.updateWithValidation('test_doc', {
            title: '', // Empty required field
            count: -1
        }, {
            validate: true,
            schemaName: 'integration',
            strict: false
        });

        if (invalidUpdate.valid) throw new Error('Invalid update should fail validation');

        // Cleanup
        await db.delete('test_doc');
    });

    // Test 17: No schema validation (backward compatibility)
    await test('No schema validation (backward compatibility)', async () => {
        // Operations without schema should work normally
        await db.create('no_schema_doc');
        await db.update('no_schema_doc', {
            anyField: 'any value',
            anotherField: 123,
            nested: { data: true }
        });

        const data = await db.get('no_schema_doc');
        if (!data || data.anyField !== 'any value') throw new Error('Normal operations should work without schema');

        await db.delete('no_schema_doc');
    });

    // Cleanup
    console.log('\n🧹 Cleaning up test files...');
    try {
        db.destroy();
        if (existsSync(testDbPath)) rmSync(testDbPath, { recursive: true, force: true });
    } catch (cleanupError) {
        console.warn('⚠️ Cleanup warning:', cleanupError.message);
    }

    // Summary
    console.log(`\n📊 Schema Validation Test Results:`);
    console.log(`✅ Passed: ${passed}`);
    console.log(`❌ Failed: ${failed}`);
    console.log(`📈 Success Rate: ${((passed / (passed + failed)) * 100).toFixed(1)}%`);

    if (failed === 0) {
        console.log('\n🎉 All schema validation tests passed! Schema system is ready for production.');
    } else {
        console.log('\n⚠️ Some schema validation tests failed. Please review the issues.');
        process.exit(1);
    }
}

runSchemaTests().catch(console.error);