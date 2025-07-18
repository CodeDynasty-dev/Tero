import { Tero } from '../dist/index.js';

async function schemaValidationExamples() {
    console.log('🚀 Schema Validation System Demo\n');

    try {
        // Initialize database
        const db = new Tero({
            Directory: 'SchemaTestDB',
            cacheSize: 50
        });

        // Example 1: Basic User Schema
        console.log('👤 Example 1: User Schema Definition');
        const userSchema = {
            name: {
                type: 'string',
                required: true,
                min: 2,
                max: 50
            },
            email: {
                type: 'string',
                required: true,
                format: 'email'
            },
            age: {
                type: 'number',
                min: 0,
                max: 150
            },
            isActive: {
                type: 'boolean',
                default: true
            },
            role: {
                type: 'string',
                enum: ['admin', 'user', 'moderator'],
                default: 'user'
            }
        };

        db.setSchema('users', userSchema);
        console.log('✅ User schema defined');

        // Valid user data
        const validUser = {
            name: 'John Doe',
            email: 'john@example.com',
            age: 30,
            role: 'admin'
        };

        const result1 = await db.createWithValidation('user1', validUser, {
            validate: true,
            schemaName: 'users'
        });
        console.log('Valid user creation result:', result1);

        // Invalid user data
        const invalidUser = {
            name: 'A', // Too short
            email: 'invalid-email', // Invalid format
            age: 200, // Too high
            role: 'superuser' // Not in enum
        };

        const result2 = await db.updateWithValidation('user2', invalidUser, {
            validate: true,
            schemaName: 'users',
            strict: false // Don't throw error, return validation result
        });
        console.log('Invalid user validation result:', result2);
        console.log('');

        // Example 2: Product Schema with Nested Objects
        console.log('📦 Example 2: Product Schema with Nested Objects');
        const productSchema = {
            name: {
                type: 'string',
                required: true,
                min: 1,
                max: 100
            },
            price: {
                type: 'number',
                required: true,
                min: 0
            },
            category: {
                type: 'string',
                enum: ['electronics', 'clothing', 'books', 'home'],
                required: true
            },
            specifications: {
                type: 'object',
                properties: {
                    weight: { type: 'number', min: 0 },
                    dimensions: {
                        type: 'object',
                        properties: {
                            length: { type: 'number', min: 0 },
                            width: { type: 'number', min: 0 },
                            height: { type: 'number', min: 0 }
                        }
                    },
                    color: { type: 'string' }
                }
            },
            tags: {
                type: 'array',
                items: { type: 'string' },
                max: 10
            },
            inStock: {
                type: 'boolean',
                default: true
            },
            createdAt: {
                type: 'date',
                default: new Date()
            }
        };

        db.setSchema('products', productSchema);
        console.log('✅ Product schema defined');

        const validProduct = {
            name: 'Gaming Laptop',
            price: 1299.99,
            category: 'electronics',
            specifications: {
                weight: 2.5,
                dimensions: {
                    length: 35,
                    width: 25,
                    height: 2
                },
                color: 'black'
            },
            tags: ['gaming', 'laptop', 'high-performance']
        };

        const productResult = await db.createWithValidation('product1', validProduct, {
            validate: true,
            schemaName: 'products'
        });
        console.log('Product creation result:', productResult.valid ? '✅ Valid' : '❌ Invalid');
        console.log('');

        // Example 3: Custom Validation Functions
        console.log('🔧 Example 3: Custom Validation Functions');
        const orderSchema = {
            orderId: {
                type: 'string',
                required: true,
                pattern: '^ORD-[0-9]{6}$' // Must match pattern ORD-123456
            },
            customerEmail: {
                type: 'string',
                required: true,
                format: 'email'
            },
            total: {
                type: 'number',
                required: true,
                min: 0,
                custom: (value) => {
                    // Custom validation: total must be a multiple of 0.01 (valid currency)
                    return (Math.round(value * 100) / 100) === value || 'Total must be a valid currency amount';
                }
            },
            items: {
                type: 'array',
                required: true,
                min: 1, // At least one item
                items: {
                    type: 'object',
                    properties: {
                        productId: { type: 'string', required: true },
                        quantity: { type: 'number', required: true, min: 1 },
                        price: { type: 'number', required: true, min: 0 }
                    }
                }
            },
            status: {
                type: 'string',
                enum: ['pending', 'processing', 'shipped', 'delivered', 'cancelled'],
                default: 'pending'
            }
        };

        db.setSchema('orders', orderSchema);
        console.log('✅ Order schema with custom validation defined');

        const validOrder = {
            orderId: 'ORD-123456',
            customerEmail: 'customer@example.com',
            total: 99.99,
            items: [
                { productId: 'PROD-001', quantity: 2, price: 49.99 }
            ]
        };

        const orderResult = await db.createWithValidation('order1', validOrder, {
            validate: true,
            schemaName: 'orders'
        });
        console.log('Order validation result:', orderResult.valid ? '✅ Valid' : '❌ Invalid');

        // Test invalid order
        const invalidOrder = {
            orderId: 'INVALID-ID', // Doesn't match pattern
            customerEmail: 'not-an-email',
            total: 99.999, // Invalid currency (3 decimal places)
            items: [] // Empty array (min: 1)
        };

        const invalidOrderResult = await db.updateWithValidation('order2', invalidOrder, {
            validate: true,
            schemaName: 'orders',
            strict: false
        });
        console.log('Invalid order errors:');
        invalidOrderResult.errors.forEach(error => {
            console.log(`  - ${error.field}: ${error.message}`);
        });
        console.log('');

        // Example 4: Schema Management
        console.log('📊 Example 4: Schema Management');

        // List all schemas
        const schemas = db.listSchemas();
        console.log('Defined schemas:', schemas);

        // Get schema statistics
        const stats = db.getSchemaStats();
        console.log('Schema statistics:', stats);

        // Export schemas
        const exportedSchemas = db.exportSchemas();
        console.log('Exported schemas keys:', Object.keys(exportedSchemas));

        // Validate data without updating
        const testData = { name: 'Test User', email: 'test@example.com', age: 25 };
        const validationOnly = db.validateData('users', testData);
        console.log('Validation only result:', validationOnly.valid ? '✅ Valid' : '❌ Invalid');
        console.log('');

        // Example 5: Optional vs Required Validation
        console.log('🔄 Example 5: Optional vs Required Validation');

        // Create without validation (traditional way)
        await db.create('flexible_doc');
        await db.update('flexible_doc', {
            anyField: 'any value',
            anotherField: 123,
            nested: { data: true }
        });
        console.log('✅ Document created without schema validation');

        // Update with validation (new way)
        const strictResult = await db.updateWithValidation('strict_user', {
            name: 'Jane Doe',
            email: 'jane@example.com',
            age: 28
        }, {
            validate: true,
            schemaName: 'users',
            strict: true // Will throw error if validation fails
        });
        console.log('✅ Strict validation passed');

        // Example 6: Default Values and Data Sanitization
        console.log('🧹 Example 6: Default Values and Data Sanitization');

        const partialUser = {
            name: 'Bob Smith',
            email: 'bob@example.com'
            // age and isActive not provided - should get defaults
        };

        const sanitizedResult = await db.createWithValidation('user_with_defaults', partialUser, {
            validate: true,
            schemaName: 'users'
        });

        console.log('Sanitized data with defaults:', sanitizedResult.data);
        console.log('');

        // Example 7: Array and Format Validation
        console.log('📋 Example 7: Advanced Format Validation');

        const contactSchema = {
            name: { type: 'string', required: true },
            phone: { type: 'string', format: 'phone' },
            website: { type: 'string', format: 'url' },
            id: { type: 'string', format: 'uuid' },
            birthDate: { type: 'string', format: 'date' },
            lastLogin: { type: 'date' },
            ipAddress: { type: 'string', format: 'ip' },
            socialMedia: {
                type: 'array',
                items: { type: 'string', format: 'url' },
                max: 5
            }
        };

        db.setSchema('contacts', contactSchema);

        const contactData = {
            name: 'Alice Johnson',
            phone: '+1-555-123-4567',
            website: 'https://alice.example.com',
            id: '123e4567-e89b-12d3-a456-426614174000',
            birthDate: '1990-05-15',
            lastLogin: new Date(),
            ipAddress: '192.168.1.1',
            socialMedia: [
                'https://twitter.com/alice',
                'https://linkedin.com/in/alice'
            ]
        };

        const contactResult = await db.createWithValidation('contact1', contactData, {
            validate: true,
            schemaName: 'contacts'
        });
        console.log('Contact validation result:', contactResult.valid ? '✅ Valid' : '❌ Invalid');

        // Cleanup
        console.log('\n🧹 Cleaning up...');
        await db.delete('user1');
        await db.delete('product1');
        await db.delete('order1');
        await db.delete('flexible_doc');
        await db.delete('strict_user');
        await db.delete('user_with_defaults');
        await db.delete('contact1');

        db.destroy();
        console.log('✅ Schema validation demo completed successfully!');

    } catch (error) {
        console.error('❌ Demo failed:', error.message);
        console.error('Stack trace:', error.stack);
    }
}

// Configuration examples
console.log(`
📋 Schema Definition Examples:

🔸 Basic Field Types:
{
  name: { type: 'string', required: true },
  age: { type: 'number', min: 0, max: 150 },
  active: { type: 'boolean', default: true },
  tags: { type: 'array', items: { type: 'string' } },
  metadata: { type: 'object' },
  createdAt: { type: 'date' },
  anything: { type: 'any' }
}

🔸 String Formats:
{
  email: { type: 'string', format: 'email' },
  website: { type: 'string', format: 'url' },
  userId: { type: 'string', format: 'uuid' },
  birthDate: { type: 'string', format: 'date' },
  phone: { type: 'string', format: 'phone' },
  ipAddr: { type: 'string', format: 'ip' }
}

🔸 Advanced Validation:
{
  status: { 
    type: 'string', 
    enum: ['active', 'inactive', 'pending'] 
  },
  code: { 
    type: 'string', 
    pattern: '^[A-Z]{3}-[0-9]{4}$' 
  },
  score: {
    type: 'number',
    custom: (value) => value % 1 === 0 || 'Must be integer'
  }
}

🔸 Nested Objects:
{
  address: {
    type: 'object',
    properties: {
      street: { type: 'string', required: true },
      city: { type: 'string', required: true },
      zipCode: { type: 'string', pattern: '^[0-9]{5}$' }
    }
  }
}

💡 Usage Methods:
- db.setSchema(name, schema)     // Define schema
- db.validateData(name, data)    // Validate only
- db.updateWithValidation(...)   // Update with validation
- db.createWithValidation(...)   // Create with validation
- db.getSchema(name)             // Get schema definition
- db.listSchemas()               // List all schemas
- db.removeSchema(name)          // Remove schema

🔧 Validation Options:
- validate: true                 // Enable validation
- schemaName: 'users'           // Specify schema name
- strict: true                  // Throw error on validation failure
- strict: false                 // Return validation result
`);

schemaValidationExamples();