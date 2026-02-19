import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: [true, 'Username is required'],
    unique: true,
    trim: true,
    minlength: [3, 'Username must be at least 3 characters long'],
    maxlength: [30, 'Username cannot exceed 30 characters']
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please enter a valid email']
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [6, 'Password must be at least 6 characters long'],
    select: false // Don't include password in queries by default
  },
  firstName: {
    type: String,
    required: [true, 'First name is required'],
    trim: true,
    maxlength: [50, 'First name cannot exceed 50 characters']
  },
  lastName: {
    type: String,
    required: [true, 'Last name is required'],
    trim: true,
    maxlength: [50, 'Last name cannot exceed 50 characters']
  },
  // profilePicture: {
  //   type: String,
  //   default: ''
  // },
  isActive: {
    type: Boolean,
    default: true
  },
  lastLogin: {
    type: Date,
    default: Date.now
  },
  role: {
    type: String,
    enum: ['user', 'admin'],
    default: 'user'
  },
  isPaid: {
    type: Boolean,
    default: false
  },
  // Subscription & Pricing Fields
  plan: {
    type: String,
    enum: ['FREE', 'STARTER', 'VALUE', 'UNLIMITED'],
    default: 'FREE'
  },
  credits: {
    type: Number,
    default: 0,
    min: 0
  },
  subscriptionExpiry: {
    type: Date,
    default: null
  },
  interviewsTaken: {
    type: Number,
    default: 0
  },
  monthlyInterviewsUsed: {
    type: Number,
    default: 0
  },
  monthlyResetDate: {
    type: Date,
    default: null // Will be set to 30 days from subscription start
  },
  analyticsEnabled: {
    type: Boolean,
    default: false
  },
  targetJobs: [{
    role: { type: String, required: true, trim: true, maxlength: 100 },
    company: { type: String, trim: true, maxlength: 100, default: '' },
    location: { type: String, trim: true, maxlength: 100, default: '' },
    skills: [{ type: String, trim: true }],
    notes: { type: String, trim: true, maxlength: 500, default: '' },
    createdAt: { type: Date, default: Date.now }
  }]
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Virtual for full name
userSchema.virtual('fullName').get(function() {
  return `${this.firstName} ${this.lastName}`;
});

// Indexes are automatically created by unique: true in schema

// Pre-save middleware to hash password
userSchema.pre('save', async function(next) {
  // Only hash the password if it has been modified (or is new)
  if (!this.isModified('password')) return next();

  try {
    // Hash password with cost of 12
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Instance method to check password
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Instance method to get public profile
userSchema.methods.getPublicProfile = function() {
  const userObject = this.toObject();
  delete userObject.password;
  return userObject;
};

// Instance method to check if subscription is active
userSchema.methods.isSubscriptionActive = function() {
  if (this.plan === 'FREE') return false;
  if (!this.subscriptionExpiry) return false;
  return new Date() < new Date(this.subscriptionExpiry);
};

// Instance method to check if user can take interview
userSchema.methods.canTakeInterview = function() {
  return this.credits > 0;
};

// Instance method to deduct interview credit
userSchema.methods.deductCredit = async function() {
  if (this.credits <= 0) {
    throw new Error('Insufficient credits to start interview');
  }
  this.credits -= 1;
  this.interviewsTaken += 1;
  
  // Increment monthly usage for subscription plans
  if (this.plan === 'VALUE' || this.plan === 'UNLIMITED') {
    this.monthlyInterviewsUsed += 1;
  }
  
  await this.save();
};

// Instance method to reset monthly credits if subscription period has expired
userSchema.methods.resetMonthlyCreditsIfNeeded = async function() {
  if (!this.monthlyResetDate || new Date() >= new Date(this.monthlyResetDate)) {
    // Reset monthly usage and set new reset date
    this.monthlyInterviewsUsed = 0;
    this.monthlyResetDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days from now
    
    // Reset credits based on plan
    if (this.plan === 'VALUE') {
      this.credits = 15;
    } else if (this.plan === 'UNLIMITED') {
      this.credits = 100;
    }
    
    await this.save();
  }
};

// Static method to find user by credentials
userSchema.statics.findByCredentials = async function(email, password) {
  const user = await this.findOne({ email }).select('+password');
  
  if (!user) {
    throw new Error('Invalid login credentials');
  }

  const isMatch = await user.comparePassword(password);
  
  if (!isMatch) {
    throw new Error('Invalid login credentials');
  }

  return user;
};

const User = mongoose.model('User', userSchema);

export default User; 