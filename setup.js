import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import User from './models/User.js';

// Load environment variables
dotenv.config({ path: '.env' });

const setupDatabase = async () => {
  try {
    console.log('🔧 Setting up Interview Bot Backend...\n');

    // Connect to MongoDB
    console.log('📡 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB successfully\n');

    // Check if admin user exists
    const adminExists = await User.findOne({ email: 'admin@aceai.com' });
    
    if (!adminExists) {
      console.log('👤 Creating admin user...');
      
      // Create admin user
      const adminUser = new User({
        username: 'admin',
        email: 'admin@aceai.com',
        password: 'AdminPass123',
        firstName: 'Admin',
        lastName: 'User',
        role: 'admin'
      });

      await adminUser.save();
      console.log('✅ Admin user created successfully');
      console.log('   Email: admin@aceai.com');
      console.log('   Password: AdminPass123\n');
    } else {
      console.log('ℹ️  Admin user already exists\n');
    }

    // Check if demo user exists
    const demoExists = await User.findOne({ email: 'demo@aceai.com' });
    
    if (!demoExists) {
      console.log('👤 Creating demo user...');
      
      // Create demo user
      const demoUser = new User({
        username: 'demo',
        email: 'demo@aceai.com',
        password: 'DemoPass123',
        firstName: 'Demo',
        lastName: 'User',
        role: 'user'
      });

      await demoUser.save();
      console.log('✅ Demo user created successfully');
      console.log('   Email: demo@aceai.com');
      console.log('   Password: DemoPass123\n');
    } else {
      console.log('ℹ️  Demo user already exists\n');
    }

    console.log('🎉 Setup completed successfully!');
    console.log('\n📋 Next steps:');
    console.log('1. Start the backend server: npm run dev');
    console.log('2. Start the frontend: cd ../interview-bot-ai-main && npm run dev');
    console.log('3. Open http://localhost:5173 in your browser');
    console.log('4. Use the demo credentials to test the application\n');

    console.log('🔐 Default Users:');
    console.log('   Admin: admin@aceai.com / AdminPass123');
    console.log('   Demo:  demo@aceai.com / DemoPass123\n');

  } catch (error) {
    console.error('❌ Setup failed:', error.message);
    process.exit(1);
  } finally {
    await mongoose.connection.close();
    console.log('🔌 Database connection closed');
  }
};

// Run setup if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  setupDatabase();
}

export { setupDatabase };