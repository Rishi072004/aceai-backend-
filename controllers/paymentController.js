import Razorpay from 'razorpay';
import crypto from 'crypto';
import User from '../models/User.js';
import Payment from '../models/Payment.js';
import { asyncHandler } from '../middleware/errorHandler.js';

// Lazily initialize Razorpay to avoid startup crash when keys are missing
let razorpay = null;
const getRazorpay = () => {
  if (razorpay) return razorpay;
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) return null;
  razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
  return razorpay;
};

// Define pricing plans
const PRICING_PLANS = {
  STARTER: {
    name: 'Starter',
    price: 5000, // in paise (₹50)
    currency: 'INR',
    creditsGranted: 2, // Two interviews in Starter pack
    description: '2 interview credits (25 mins each)',
    recurring: false,
    available: true
  },
  VALUE: {
    name: 'Value for Money',
    price: 29900, // in paise (₹299)
    currency: 'INR',
    creditsGranted: 15,
    description: '15 interview credits/month (50 mins, ~30 questions each)',
    recurring: true,
    subscriptionDays: 30,
    analyticsEnabled: true,
    available: true
  },
  UNLIMITED: {
    name: 'Unlimited',
    price: 89900, // in paise (₹899)
    currency: 'INR',
    creditsGranted: 100,
    description: 'Unlimited interviews (soft-capped 100/month)',
    recurring: true,
    subscriptionDays: 30,
    analyticsEnabled: true,
    available: false // Hidden/deprecated plan retained for legacy records
  }
};

// Helper: determine if we are in a non-production environment
const isNonProduction = process.env.NODE_ENV !== 'production';

// @desc    Check payment gateway configuration (Debug endpoint)
// @route   GET /api/payments/config
// @access  Private
export const checkConfig = asyncHandler(async (req, res) => {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  
  res.status(200).json({
    status: 'success',
    data: {
      razorpayConfigured: !!(keyId && keySecret),
      keyIdExists: !!keyId,
      keySecretExists: !!keySecret,
      testMode: keyId?.includes('test') || false,
      mongoConnected: true
    }
  });
});

// @desc    Get all pricing plans
// @route   GET /api/payments/plans
// @access  Public
export const getPlans = asyncHandler(async (req, res) => {
  const plans = Object.entries(PRICING_PLANS)
    .filter(([, value]) => value.available !== false)
    .map(([key, value]) => ({
      id: key,
      ...value,
      priceInRupees: value.price / 100
    }));

  res.status(200).json({
    status: 'success',
    data: {
      plans
    }
  });
});

// @desc    Create a Razorpay order
// @route   POST /api/payments/create-order
// @access  Private
export const createOrder = asyncHandler(async (req, res) => {
  const { planId } = req.body;
  const userId = req.user._id;

  // Validate plan
  if (!PRICING_PLANS[planId]) {
    return res.status(400).json({
      status: 'error',
      message: 'Invalid plan selected'
    });
  }

  const plan = PRICING_PLANS[planId];

  if (plan.available === false) {
    return res.status(400).json({
      status: 'error',
      message: 'This plan is not available for purchase'
    });
  }

   // Prevent purchasing another pack while credits remain
  const user = await User.findById(userId);
  if (!user) {
    return res.status(404).json({
      status: 'error',
      message: 'User not found'
    });
  }

  if (user.credits > 0) {
    return res.status(400).json({
      status: 'error',
      message: 'You still have interview credits. Please use them before buying another pack.'
    });
  }

  // In non-production environments, default to a fake payment flow
  // so you can test credits/interviews without a live gateway.
  // Set ENABLE_FAKE_PAYMENTS="false" to force real Razorpay even in dev.
  const enableFakePayments = isNonProduction && process.env.ENABLE_FAKE_PAYMENTS !== 'false';

  if (enableFakePayments) {
    try {
      // Simulate a successful payment by directly granting credits
      user.credits += plan.creditsGranted;
      user.plan = planId;
      user.analyticsEnabled = plan.analyticsEnabled || false;

      if (plan.recurring) {
        const expiry = new Date(Date.now() + plan.subscriptionDays * 24 * 60 * 60 * 1000);
        user.subscriptionExpiry = expiry;
        user.monthlyResetDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      }

      // Record a synthetic payment entry for history/consistency
      const payment = new Payment({
        userId,
        orderId: `dev_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        paymentId: `dev_payment_${Date.now()}`,
        signature: 'dev-signature',
        plan: planId,
        amount: plan.price / 100,
        currency: plan.currency,
        creditsGranted: plan.creditsGranted,
        status: 'captured',
        notes: 'Fake payment granted in development mode'
      });

      await Promise.all([user.save(), payment.save()]);

      return res.status(200).json({
        status: 'success',
        message: 'Fake payment successful (development mode)',
        data: {
          devMode: true,
          user: user.getPublicProfile(),
          payment: {
            orderId: payment.orderId,
            paymentId: payment.paymentId,
            status: payment.status,
            creditsGranted: payment.creditsGranted
          }
        }
      });
    } catch (error) {
      console.error('Fake payment error:', error);
      return res.status(500).json({
        status: 'error',
        message: 'Failed to process fake payment in development mode'
      });
    }
  }

  try {
    // Ensure Razorpay client is configured
    const rp = getRazorpay();
    if (!rp) {
      console.error('Razorpay keys not configured in environment');
      return res.status(500).json({
        status: 'error',
        message: 'Payment gateway not configured. Contact admin.'
      });
    }

    // Create Razorpay order
    // Build a short receipt (max 40 chars) to satisfy Razorpay validation
    const shortUser = userId.toString().slice(-8);
    const shortTs = Date.now().toString().slice(-6);
    let receipt = `order_${shortUser}_${shortTs}`;
    if (receipt.length > 40) receipt = receipt.slice(0, 40);

    const order = await rp.orders.create({
      amount: plan.price, // Amount in paise
      currency: plan.currency,
      receipt,
      notes: {
        userId: userId.toString(),
        planId,
        planName: plan.name
      }
    });

    // Save payment record in database
    const payment = new Payment({
      userId,
      orderId: order.id,
      plan: planId,
      amount: plan.price / 100, // Convert to rupees for storage
      currency: plan.currency,
      creditsGranted: plan.creditsGranted,
      status: 'pending',
      subscriptionExpiry: plan.recurring ? new Date(Date.now() + plan.subscriptionDays * 24 * 60 * 60 * 1000) : null
    });

    await payment.save();

    res.status(200).json({
      status: 'success',
      data: {
        order: {
          id: order.id,
          amount: order.amount,
          currency: order.currency,
          receipt: order.receipt
        },
        razorpayKeyId: process.env.RAZORPAY_KEY_ID || null
      }
    });
  } catch (error) {
    console.error('Razorpay order creation error:', error);
    console.error('Error details:', {
      message: error.message,
      code: error.code,
      statusCode: error.statusCode,
      stack: error.stack
    });
    // Serialize error properties for safer JSON transport
    const serializedError = {};
    Object.getOwnPropertyNames(error).forEach((k) => {
      try { serializedError[k] = error[k]; } catch (e) { serializedError[k] = String(error[k]); }
    });

    res.status(500).json({
      status: 'error',
      message: 'Failed to create payment order',
      details: {
        message: error.message,
        code: error.code,
        statusCode: error.statusCode,
        raw: serializedError,
        ...(process.env.NODE_ENV === 'development' && { stack: error.stack })
      }
    });
  }
});

// @desc    Verify payment and grant credits
// @route   POST /api/payments/verify
// @access  Private
export const verifyPayment = asyncHandler(async (req, res) => {
  const { orderId, paymentId, signature } = req.body;
  const userId = req.user._id;

  // Validate required fields
  if (!orderId || !paymentId || !signature) {
    return res.status(400).json({
      status: 'error',
      message: 'Missing required payment verification fields'
    });
  }

  try {
    // Verify signature using HMAC SHA256
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    if (expectedSignature !== signature) {
      console.error('Signature mismatch:', { expectedSignature, providedSignature: signature });
      return res.status(400).json({
        status: 'error',
        message: 'Payment verification failed - Invalid signature'
      });
    }

    // Find payment record
    const payment = await Payment.findOne({ orderId });

    if (!payment) {
      return res.status(404).json({
        status: 'error',
        message: 'Payment record not found'
      });
    }

    if (payment.userId.toString() !== userId.toString()) {
      return res.status(403).json({
        status: 'error',
        message: 'Unauthorized: This payment does not belong to you'
      });
    }

    // Check if already verified
    if (payment.status === 'captured') {
      return res.status(200).json({
        status: 'success',
        message: 'Payment already verified',
        data: { payment }
      });
    }

    // Fetch payment details from Razorpay to verify
    try {
      const razorpayPayment = await razorpay.payments.fetch(paymentId);
      
      if (razorpayPayment.status !== 'captured') {
        return res.status(400).json({
          status: 'error',
          message: 'Payment not captured by Razorpay'
        });
      }

      // Update payment record
      payment.paymentId = paymentId;
      payment.signature = signature;
      payment.status = 'captured';
      payment.razorpayResponse = razorpayPayment;
      
      const user = await User.findById(userId);
      user.credits += payment.creditsGranted;
      user.plan = payment.plan;
      user.analyticsEnabled = PRICING_PLANS[payment.plan].analyticsEnabled || false;
      
      if (PRICING_PLANS[payment.plan].recurring) {
        user.subscriptionExpiry = payment.subscriptionExpiry;
        user.monthlyResetDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      }
      
      await Promise.all([user.save(), payment.save()]);

      res.status(200).json({
        status: 'success',
        message: 'Payment verified and credits added successfully',
        data: {
          user: user.getPublicProfile(),
          payment: {
            orderId: payment.orderId,
            paymentId: payment.paymentId,
            status: payment.status,
            creditsGranted: payment.creditsGranted
          }
        }
      });
    } catch (razorpayError) {
      console.error('Razorpay fetch error:', razorpayError);
      // Still consider it success if signature is valid, as Razorpay can be temporarily unavailable
      const user = await User.findById(userId);
      user.credits += payment.creditsGranted;
      user.plan = payment.plan;
      user.analyticsEnabled = PRICING_PLANS[payment.plan].analyticsEnabled || false;
      
      if (PRICING_PLANS[payment.plan].recurring) {
        user.subscriptionExpiry = payment.subscriptionExpiry;
        user.monthlyResetDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      }

      payment.paymentId = paymentId;
      payment.signature = signature;
      payment.status = 'captured';
      await Promise.all([user.save(), payment.save()]);

      res.status(200).json({
        status: 'success',
        message: 'Payment verified (signature valid) and credits added',
        data: {
          user: user.getPublicProfile(),
          payment: {
            orderId: payment.orderId,
            paymentId: payment.paymentId,
            status: payment.status,
            creditsGranted: payment.creditsGranted
          }
        }
      });
    }
  } catch (error) {
    console.error('Payment verification error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Payment verification failed'
    });
  }
});

// @desc    Get user's subscription status
// @route   GET /api/payments/subscription
// @access  Private
export const getSubscriptionStatus = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  const user = await User.findById(userId);

  if (!user) {
    return res.status(404).json({
      status: 'error',
      message: 'User not found'
    });
  }

  const subscriptionStatus = {
    plan: user.plan,
    credits: user.credits,
    analyticsEnabled: user.analyticsEnabled,
    interviewsTaken: user.interviewsTaken,
    monthlyInterviewsUsed: user.monthlyInterviewsUsed,
    subscriptionExpiry: user.subscriptionExpiry,
    isSubscriptionActive: user.isSubscriptionActive(),
    canTakeInterview: user.canTakeInterview()
  };

  res.status(200).json({
    status: 'success',
    data: {
      subscription: subscriptionStatus
    }
  });
});

// @desc    Get payment history
// @route   GET /api/payments/history
// @access  Private
export const getPaymentHistory = asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const { page = 1, limit = 10 } = req.query;

  const skip = (page - 1) * limit;

  const payments = await Payment.find({ userId })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(parseInt(limit));

  const total = await Payment.countDocuments({ userId });

  res.status(200).json({
    status: 'success',
    data: {
      payments,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      }
    }
  });
});

// @desc    Consume one Starter credit when starting an interview
// @route   POST /api/payments/consume-starter
// @access  Private
export const consumeStarterCredit = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  const user = await User.findById(userId);

  if (!user) {
    return res.status(404).json({
      status: 'error',
      message: 'User not found'
    });
  }

  if (user.plan !== 'STARTER') {
    return res.status(400).json({
      status: 'error',
      message: 'Starter plan required to consume Starter credit'
    });
  }

  try {
    await user.deductCredit();

    return res.status(200).json({
      status: 'success',
      message: 'Starter credit consumed successfully',
      data: {
        user: user.getPublicProfile()
      }
    });
  } catch (error) {
    console.error('Error consuming Starter credit:', error);
    return res.status(400).json({
      status: 'error',
      message: error.message || 'Failed to consume Starter credit'
    });
  }
});
