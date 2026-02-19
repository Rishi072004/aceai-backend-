import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Payment from './models/Payment.js';
import User from './models/User.js';

dotenv.config({ path: '.env' });

async function testPaymentCreation() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected');

    // Find a test user
    const user = await User.findOne({ email: 'payment-test@aceai.com' });
    if (!user) {
      console.log('❌ User not found');
      process.exit(1);
    }

    console.log(`✅ Found user: ${user.email}`);

    // Try creating a payment record
    const payment = new Payment({
      userId: user._id,
      orderId: `order_test_${Date.now()}`,
      plan: 'STARTER',
      amount: 25,
      currency: 'INR',
      creditsGranted: 2,
      status: 'pending',
      subscriptionExpiry: null
    });

    console.log('💾 Saving payment...');
    await payment.save();
    console.log('✅ Payment saved successfully');
    console.log(JSON.stringify(payment, null, 2));

    await mongoose.connection.close();
    console.log('✅ Connection closed');
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error);
    process.exit(1);
  }
}

testPaymentCreation();
