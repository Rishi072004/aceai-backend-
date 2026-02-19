import mongoose from 'mongoose';
import crypto from 'crypto';

const paymentSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  orderId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  paymentId: {
    type: String,
    default: null,
    sparse: true,
    index: true
  },
  signature: {
    type: String,
    default: null
  },
  plan: {
    type: String,
    enum: ['STARTER', 'VALUE', 'UNLIMITED'],
    required: true
  },
  amount: {
    type: Number,
    required: true
  },
  currency: {
    type: String,
    default: 'INR'
  },
  creditsGranted: {
    type: Number,
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'authorized', 'captured', 'failed', 'refunded'],
    default: 'pending'
  },
  razorpayResponse: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  subscriptionExpiry: {
    type: Date,
    default: null
  },
  notes: {
    type: String,
    trim: true,
    default: ''
  }
}, {
  timestamps: true
});

// Indexes for better query performance
paymentSchema.index({ userId: 1, createdAt: -1 });
paymentSchema.index({ status: 1 });
paymentSchema.index({ plan: 1 });

// Instance method to verify payment signature
paymentSchema.methods.verifySignature = function(secret) {
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(`${this.orderId}|${this.paymentId}`)
    .digest('hex');

  return expectedSignature === this.signature;
};

// Static method to find payment by order ID
paymentSchema.statics.findByOrderId = function(orderId) {
  return this.findOne({ orderId });
};

const Payment = mongoose.model('Payment', paymentSchema);

export default Payment;
