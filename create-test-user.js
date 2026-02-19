import mongoose from 'mongoose';
import dotenv from 'dotenv';
import User from './models/User.js';

dotenv.config({ path: '.env' });

async function createTestUser() {
  try {
    console.log('🔗 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected\n');

    // Check if test user exists
    let testUser = await User.findOne({ email: 'payment-test@aceai.com' });
    
    if (testUser) {
      console.log('ℹ️ Test user already exists');
    } else {
      console.log('👤 Creating test user...');
      testUser = new User({
        username: 'payment-test',
        email: 'payment-test@aceai.com',
        password: 'Test@12345',
        firstName: 'Payment',
        lastName: 'Test',
        role: 'user'
      });
      await testUser.save();
      console.log('✅ Test user created');
    }

    console.log('\n📋 Test User Credentials:');
    console.log(`   Email: ${testUser.email}`);
    console.log(`   Password: Test@12345`);
    console.log(`   ID: ${testUser._id}`);

    await mongoose.connection.close();
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

createTestUser();
