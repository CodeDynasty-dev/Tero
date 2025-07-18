import { Tero } from '../dist/index.js';

async function example() {
  try {
    // Initialize the database
    const db = new Tero({
      Directory: 'MyDatabase',
      cacheSize: 50
    });

    console.log('✅ Database initialized successfully');

    // Create a new document
    await db.create('user1');
    console.log('✅ Document created');

    // Update the document
    await db.update('user1', {
      name: 'John Doe',
      email: 'john@example.com',
      age: 30
    });
    console.log('✅ Document updated');

    // Retrieve the document
    const user = await db.get('user1');
    console.log('✅ Retrieved user:', user);

    // Check if document exists
    const exists = db.exists('user1');
    console.log('✅ Document exists:', exists);

    // Get cache statistics
    const stats = db.getCacheStats();
    console.log('✅ Cache stats:', stats);

    // Create backup
    await db.backup();
    console.log('✅ Backup created successfully');

    // Clean up
    await db.delete('user1');
    console.log('✅ Document deleted');

  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

example();