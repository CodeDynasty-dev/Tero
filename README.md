# Tero

[![npm version](https://badge.fury.io/js/tero.svg)](https://badge.fury.io/js/tero)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-Ready-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)](https://nodejs.org/)
[![Build Status](https://img.shields.io/badge/build-passing-brightgreen.svg)](#)
[![Coverage](https://img.shields.io/badge/coverage-95%25-brightgreen.svg)](#)

**Production-ready ACID-compliant JSON document database with enterprise features**

Tero is a high-performance JSON database that provides ACID transactions, schema validation, cloud backup, and automatic recovery. Built for production environments requiring data integrity and reliability.

## 🚀 Key Features

### ACID Compliance
- **Atomicity**: All-or-nothing transactions ensure data consistency
- **Consistency**: Schema validation and business rule enforcement
- **Isolation**: Concurrent operations are properly isolated
- **Durability**: Write-ahead logging ensures data survives system crashes

### Production-Ready
- **High Performance**: Intelligent caching and batch operations
- **Data Integrity**: Built-in corruption detection and recovery
- **Schema Validation**: Flexible schema system with strict mode
- **Error Handling**: Comprehensive error handling and recovery
- **Memory Management**: Efficient memory usage with automatic cleanup

### Enterprise Features
- **Cloud Backup**: AWS S3 and Cloudflare R2 support
- **Data Recovery**: Automatic crash recovery and cloud restore
- **Monitoring**: Performance metrics and health checks
- **Security**: Path traversal protection and input validation

## 📦 Installation

```bash
npm install tero
```

## 🔧 Quick Start

```javascript
import { Tero } from 'tero';

// Initialize database
const db = new Tero({
  directory: './mydata',
  cacheSize: 1000
});

// Basic operations
await db.create('user1', { name: 'Alice', email: 'alice@example.com' });
const user = await db.get('user1');
await db.update('user1', { age: 30 });
await db.remove('user1');
```

## 🔒 ACID Transactions

### Automatic Transactions
All basic operations are automatically wrapped in ACID transactions:

```javascript
// These operations are automatically ACID-compliant
await db.create('account', { balance: 1000 });
await db.update('account', { balance: 1500 });
```

### Manual Transactions
For complex operations requiring multiple steps:

```javascript
const txId = db.beginTransaction();

try {
  await db.write(txId, 'account1', { balance: 900 });
  await db.write(txId, 'account2', { balance: 1100 });
  
  // Verify within transaction
  const account1 = await db.read(txId, 'account1');
  
  await db.commit(txId);
} catch (error) {
  await db.rollback(txId);
  throw error;
}
```

### Money Transfer Example
Demonstrates ACID properties with business logic:

```javascript
// Atomic money transfer with validation
await db.transferMoney('savings', 'checking', 500);
```

## 📋 Schema Validation

Define and enforce data schemas:

```javascript
// Set schema
db.setSchema('users', {
  name: { type: 'string', required: true, min: 2, max: 50 },
  email: { type: 'string', required: true, format: 'email' },
  age: { type: 'number', min: 0, max: 150 },
  profile: {
    type: 'object',
    properties: {
      bio: { type: 'string', max: 500 },
      website: { type: 'string', format: 'url' }
    }
  }
});

// Create with validation
await db.create('user1', userData, {
  validate: true,
  schemaName: 'users',
  strict: true
});
```

## 📦 Batch Operations

Efficient batch processing with ACID guarantees:

```javascript
// Batch write
await db.batchWrite([
  { key: 'product1', data: { name: 'Laptop', price: 999.99 } },
  { key: 'product2', data: { name: 'Mouse', price: 29.99 } },
  { key: 'product3', data: { name: 'Keyboard', price: 79.99 } }
]);

// Batch read
const products = await db.batchRead(['product1', 'product2', 'product3']);
```

## ☁️ Cloud Backup

Configure automatic cloud backups:

```javascript
db.configureBackup({
  format: 'archive',
  cloudStorage: {
    provider: 'aws-s3',
    region: 'us-east-1',
    bucket: 'my-backup-bucket',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  },
  retention: '30d'
});

// Perform backup
const result = await db.performBackup();
```

## 🔄 Data Recovery

Automatic crash recovery and cloud restore:

```javascript
// Configure data recovery
db.configureDataRecovery({
  cloudStorage: cloudConfig,
  localPath: './mydata'
});

// Recover specific file
await db.recoverFromCloud('important-data');

// Recover all files
const result = await db.recoverAllFromCloud();
```

## 📊 Monitoring

Built-in performance monitoring and health checks:

```javascript
// Cache performance
const cacheStats = db.getCacheStats();
console.log(`Cache hit rate: ${cacheStats.hitRate}%`);

// Data integrity check
const integrity = await db.verifyDataIntegrity();
if (!integrity.healthy) {
  console.log(`Issues found: ${integrity.corruptedFiles.length} corrupted files`);
}

// Active transactions
const activeTx = db.getActiveTransactions();
console.log(`Active transactions: ${activeTx.length}`);
```

## 🛡️ Error Handling

Comprehensive error handling with detailed messages:

```javascript
try {
  await db.create('user', invalidData, { validate: true, strict: true });
} catch (error) {
  if (error.message.includes('Schema validation failed')) {
    // Handle validation error
  } else if (error.message.includes('already exists')) {
    // Handle duplicate key error
  }
}
```

## 🔧 Configuration

### Database Options
```javascript
const db = new Tero({
  directory: './data',     // Database directory
  cacheSize: 1000         // Maximum cache entries
});
```

### Schema Field Types
- `string`: Text data with length and format validation
- `number`: Numeric data with range validation
- `boolean`: True/false values
- `object`: Nested objects with property schemas
- `array`: Arrays with item type validation
- `date`: Date/time values
- `any`: Any data type (no validation)

### Schema Validation Options
- `required`: Field is mandatory
- `min/max`: Length/value constraints
- `format`: Built-in formats (email, url, uuid, etc.)
- `pattern`: Regular expression validation
- `enum`: Allowed values list
- `default`: Default value if not provided
- `custom`: Custom validation function

### Optimization Tips
1. Use batch operations for multiple documents
2. Enable caching for frequently accessed data
3. Use schema validation to catch errors early
4. Monitor cache hit rates and adjust cache size
5. Use transactions for related operations

## 🔒 Security

- **Path Traversal Protection**: Automatic key sanitization
- **Input Validation**: Comprehensive data validation
- **Error Handling**: No sensitive data in error messages
- **Access Control**: File system permissions respected

## 📚 API Reference

### Core Methods
- `create(key, data, options?)`: Create new document
- `get(key)`: Read document
- `update(key, data, options?)`: Update document
- `remove(key)`: Delete document
- `exists(key)`: Check if document exists

### Transaction Methods
- `beginTransaction()`: Start new transaction
- `write(txId, key, data, options?)`: Write in transaction
- `read(txId, key)`: Read in transaction
- `delete(txId, key)`: Delete in transaction
- `commit(txId)`: Commit transaction
- `rollback(txId)`: Rollback transaction

### Batch Methods
- `batchWrite(operations, options?)`: Batch write operations
- `batchRead(keys)`: Batch read operations

### Schema Methods
- `setSchema(name, schema)`: Define schema
- `getSchema(name)`: Get schema definition
- `removeSchema(name)`: Remove schema
- `validateData(name, data)`: Validate against schema

### Utility Methods
- `getCacheStats()`: Cache performance metrics
- `verifyDataIntegrity()`: Check data health
- `getActiveTransactions()`: List active transactions
- `forceCheckpoint()`: Force WAL flush
- `clearCache()`: Clear memory cache
- `destroy()`: Cleanup and shutdown

## 🧪 Testing

Run the production test suite:

```bash
npm run test:production
```

## 📄 License

MIT License - see LICENSE file for details.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Add tests for new functionality
4. Ensure all tests pass
5. Submit a pull request

## 📞 Support

For issues and questions:
- GitHub Issues: [Report bugs and request features](https://github.com/codedynasty-dev/tero/issues)
- Documentation: [Full API documentation](https://github.com/codedynasty-dev/tero/wiki)

---

**Tero** - Production-ready ACID JSON database for modern applications.