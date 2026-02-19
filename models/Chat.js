import mongoose from 'mongoose';

const messageSchema = new mongoose.Schema({
  role: {
    type: String,
    enum: ['user', 'assistant'],
    required: true
  },
  content: {
    type: String,
    required: true,
    trim: true
  },
  timestamp: {
    type: Date,
    default: Date.now
  },
  metadata: {
    type: Map,
    of: String,
    default: {}
  }
});

const chatSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  resumeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Resume',
    default: null,
    index: true
  },
  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: [200, 'Chat title cannot exceed 200 characters']
  },
  description: {
    type: String,
    trim: true,
    maxlength: [2000, 'Chat description cannot exceed 2000 characters'],
    default: ''
  },
  messages: [messageSchema],
  status: {
    type: String,
    enum: ['active', 'completed', 'archived'],
    default: 'active'
  },
  interviewType: {
    type: String,
    enum: ['technical', 'behavioral', 'general', 'custom'],
    default: 'general'
  },
  difficulty: {
    type: String,
    enum: ['beginner', 'intermediate', 'advanced', 'expert'],
    default: 'intermediate'
  },
  duration: {
    type: Number, // in minutes
    default: 0
  },
  score: {
    type: Number,
    min: 0,
    max: 100,
    default: 0
  },
  feedback: {
    overallScore: {
      type: Number,
      min: 0,
      max: 10,
      default: 0
    },
    summary: {
      type: String,
      default: ''
    },
    strengths: [{
      type: String
    }],
    improvements: [{
      type: String
    }],
    communication: {
      score: { type: Number, min: 0, max: 10 },
      feedback: String
    },
    technicalKnowledge: {
      score: { type: Number, min: 0, max: 10 },
      feedback: String
    },
    problemSolving: {
      score: { type: Number, min: 0, max: 10 },
      feedback: String
    },
    professionalism: {
      score: { type: Number, min: 0, max: 10 },
      feedback: String
    },
    recommendation: {
      type: String,
      default: ''
    },
    generatedAt: {
      type: Date,
      default: null
    }
  },
  tags: [{
    type: String,
    trim: true
  }],
  settings: {
    type: Map,
    of: mongoose.Schema.Types.Mixed,
    default: {}
  },
  isPublic: {
    type: Boolean,
    default: false
  },
  lastActivity: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Virtual for message count
chatSchema.virtual('messageCount').get(function() {
  return this.messages.length;
});

// Virtual for duration in human readable format
chatSchema.virtual('durationFormatted').get(function() {
  if (this.duration < 60) {
    return `${this.duration} minutes`;
  }
  const hours = Math.floor(this.duration / 60);
  const minutes = this.duration % 60;
  return `${hours}h ${minutes}m`;
});

// Indexes for better query performance
chatSchema.index({ userId: 1, createdAt: -1 });
chatSchema.index({ status: 1 });
chatSchema.index({ interviewType: 1 });
chatSchema.index({ tags: 1 });

// Pre-save middleware to update lastActivity
chatSchema.pre('save', function(next) {
  this.lastActivity = new Date();
  next();
});

// Instance method to add message
chatSchema.methods.addMessage = function(role, content, metadata = {}) {
  this.messages.push({
    role,
    content,
    metadata
  });
  this.lastActivity = new Date();
  return this.save();
};

// Instance method to get recent messages
chatSchema.methods.getRecentMessages = function(limit = 10) {
  return this.messages.slice(-limit);
};

// Instance method to calculate duration
chatSchema.methods.calculateDuration = function() {
  if (this.messages.length < 2) return 0;
  
  const firstMessage = this.messages[0];
  const lastMessage = this.messages[this.messages.length - 1];
  
  const duration = (lastMessage.timestamp - firstMessage.timestamp) / (1000 * 60); // Convert to minutes
  return Math.round(duration);
};

// Static method to find chats by user
chatSchema.statics.findByUser = function(userId, options = {}) {
  const query = { userId };
  
  if (options.status) query.status = options.status;
  if (options.interviewType) query.interviewType = options.interviewType;
  
  return this.find(query)
    .sort({ lastActivity: -1 })
    .limit(options.limit || 50);
};

// Static method to get chat statistics
chatSchema.statics.getUserStats = async function(userId) {
  const stats = await this.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(userId) } },
    {
      $group: {
        _id: null,
        totalChats: { $sum: 1 },
        totalMessages: { $sum: { $size: '$messages' } },
        avgScore: { $avg: '$score' },
        totalDuration: { $sum: '$duration' }
      }
    }
  ]);
  
  return stats[0] || {
    totalChats: 0,
    totalMessages: 0,
    avgScore: 0,
    totalDuration: 0
  };
};

const Chat = mongoose.model('Chat', chatSchema);

export default Chat; 