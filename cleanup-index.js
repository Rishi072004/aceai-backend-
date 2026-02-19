import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config({ path: '.env' });

async function cleanup() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    const db = mongoose.connection.db;
    
    // Drop the problematic unique index on paymentId
    try {
      await db.collection('payments').dropIndex('paymentId_1');
      console.log('✅ Dropped paymentId_1 index');
    } catch (err) {
      if (err.codeName === 'IndexNotFound') {
        console.log('ℹ️  paymentId_1 index not found (already dropped or never existed)');
      } else {
        throw err;
      }
    }

    // Count duplicate null values
    const nullPayments = await db.collection('payments').countDocuments({ paymentId: null });
    console.log(`📊 Pending payments (paymentId: null): ${nullPayments}`);

    // List all indexes on the payments collection
    const indexes = await db.collection('payments').listIndexes().toArray();
    console.log('\n📋 Current indexes on payments collection:');
    indexes.forEach(idx => {
      console.log(`  - ${JSON.stringify(idx.key)}`);
    });

    await mongoose.connection.close();
    console.log('\n✅ Cleanup completed successfully');
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

cleanup();
