import express from 'express';
import Chat from '../models/Chat.js';
import { authenticateToken, requireRole } from '../middleware/auth.js';
import { validateChatCreation, validateMessage } from '../middleware/validation.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import User from '../models/User.js';

const router = express.Router();

// @desc    Create a new chat
// @route   POST /api/chats
// @access  Private
router.post('/', authenticateToken, validateChatCreation, asyncHandler(async (req, res) => {
  const { title, description, interviewType, difficulty, tags, messages, duration } = req.body;
  const userId = req.user._id;
  const user = req.user;

  console.log('POST /api/chats - User ID:', userId);
  console.log('User object:', req.user);
  console.log('Request body:', req.body);

  // Ensure monthly subscriptions reset before consuming a credit
  try {
    await user.resetMonthlyCreditsIfNeeded();
  } catch (err) {
    console.error('Failed to reset monthly credits:', err);
    return res.status(500).json({
      status: 'error',
      message: 'Could not prepare account for new interview. Please try again.'
    });
  }

  if (!user.canTakeInterview()) {
    return res.status(402).json({
      status: 'error',
      message: 'You have insufficient credits. Please upgrade to continue.'
    });
  }

  try {
    await user.deductCredit();
    if (user.plan === 'VALUE') {
      console.log(`🎟️ [VALUE] Consumed 1 interview credit for chat creation (user=${userId})`);
    }
  } catch (err) {
    console.error('Error consuming credit for chat creation:', err);
    return res.status(400).json({
      status: 'error',
      message: err.message || 'Failed to consume interview credit.'
    });
  }

  const chatData = {
    userId,
    title,
    description,
    interviewType,
    difficulty,
    tags
  };

  // Add messages and duration if provided
  if (messages) {
    chatData.messages = messages;
  }
  if (duration !== undefined) {
    chatData.duration = duration;
  }

  console.log('Chat data to save:', chatData);

  const chat = new Chat(chatData);

  await chat.save();

  console.log('Chat saved successfully with ID:', chat._id);

  res.status(201).json({
    status: 'success',
    message: 'Chat created successfully',
    data: {
      chat: {
        id: chat._id,
        title: chat.title,
        description: chat.description,
        status: chat.status,
        interviewType: chat.interviewType,
        difficulty: chat.difficulty,
        tags: chat.tags,
        messageCount: chat.messageCount,
        duration: chat.duration,
        createdAt: chat.createdAt
      },
      user: user.getPublicProfile()
    }
  });
}));

// @desc    Get all chats for the authenticated user
// @route   GET /api/chats
// @access  Private
router.get('/', authenticateToken, asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const { page = 1, limit = 10, status, interviewType, difficulty } = req.query;

  console.log('GET /api/chats - User ID:', userId);
  console.log('User object:', req.user);

  const query = { userId };
  if (status) query.status = status;
  if (interviewType) query.interviewType = interviewType;
  if (difficulty) query.difficulty = difficulty;

  console.log('Query:', query);

  const skip = (page - 1) * limit;

  const chats = await Chat.find(query)
    .sort({ lastActivity: -1 })
    .skip(skip)
    .limit(parseInt(limit));

  const totalChats = await Chat.countDocuments(query);

  console.log('Found chats:', chats.length);
  console.log('Total chats for user:', totalChats);

  res.status(200).json({
    status: 'success',
    data: {
      chats: chats.map(chat => ({
        id: chat._id,
        title: chat.title,
        description: chat.description,
        status: chat.status,
        interviewType: chat.interviewType,
        difficulty: chat.difficulty,
        score: chat.score,
        feedback: chat.feedback, // expose feedback for history view
        duration: chat.duration,
        messageCount: chat.messageCount,
        lastActivity: chat.lastActivity,
        createdAt: chat.createdAt
      })),
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(totalChats / limit),
        totalChats,
        hasNext: page * limit < totalChats,
        hasPrev: page > 1
      }
    }
  });
}));

// @desc    Get a specific chat by ID
// @route   GET /api/chats/:id
// @access  Private
router.get('/:id', authenticateToken, asyncHandler(async (req, res) => {
  const chat = await Chat.findOne({
    _id: req.params.id,
    userId: req.user._id
  });

  if (!chat) {
    return res.status(404).json({
      status: 'error',
      message: 'Chat not found'
    });
  }

  res.status(200).json({
    status: 'success',
    data: {
      chat: {
        id: chat._id,
        title: chat.title,
        description: chat.description,
        status: chat.status,
        interviewType: chat.interviewType,
        difficulty: chat.difficulty,
        score: chat.score,
        duration: chat.duration,
        feedback: chat.feedback,
        tags: chat.tags,
        settings: chat.settings,
        messages: chat.messages,
        messageCount: chat.messageCount,
        lastActivity: chat.lastActivity,
        createdAt: chat.createdAt
      }
    }
  });
}));

// @desc    Update a chat
// @route   PUT /api/chats/:id
// @access  Private
router.put('/:id', authenticateToken, validateChatCreation, asyncHandler(async (req, res) => {
  const { title, description, interviewType, difficulty, tags, status, score, feedback, messages, duration } = req.body;

  const updateData = {
    title,
    description,
    interviewType,
    difficulty,
    tags,
    status,
    score,
    feedback
  };

  // Add messages and duration if provided
  if (messages) {
    updateData.messages = messages;
  }
  if (duration !== undefined) {
    updateData.duration = duration;
  }

  const chat = await Chat.findOneAndUpdate(
    {
      _id: req.params.id,
      userId: req.user._id
    },
    updateData,
    { new: true, runValidators: true }
  );

  if (!chat) {
    return res.status(404).json({
      status: 'error',
      message: 'Chat not found'
    });
  }

  res.status(200).json({
    status: 'success',
    message: 'Chat updated successfully',
    data: {
      chat: {
        id: chat._id,
        title: chat.title,
        description: chat.description,
        status: chat.status,
        interviewType: chat.interviewType,
        difficulty: chat.difficulty,
        score: chat.score,
        feedback: chat.feedback,
        tags: chat.tags,
        messageCount: chat.messageCount,
        duration: chat.duration,
        lastActivity: chat.lastActivity
      }
    }
  });
}));

// @desc    Delete a chat
// @route   DELETE /api/chats/:id
// @access  Private
router.delete('/:id', authenticateToken, asyncHandler(async (req, res) => {
  const chat = await Chat.findOneAndDelete({
    _id: req.params.id,
    userId: req.user._id
  });

  if (!chat) {
    return res.status(404).json({
      status: 'error',
      message: 'Chat not found'
    });
  }

  res.status(200).json({
    status: 'success',
    message: 'Chat deleted successfully'
  });
}));

// @desc    Add a message to a chat
// @route   POST /api/chats/:id/messages
// @access  Private
router.post('/:id/messages', authenticateToken, validateMessage, asyncHandler(async (req, res) => {
  const { content, role, metadata } = req.body;

  const chat = await Chat.findOne({
    _id: req.params.id,
    userId: req.user._id
  });

  if (!chat) {
    return res.status(404).json({
      status: 'error',
      message: 'Chat not found'
    });
  }

  // Add message to chat
  await chat.addMessage(role, content, metadata);

  // Calculate duration if this is the second message
  if (chat.messages.length === 2) {
    chat.duration = chat.calculateDuration();
    await chat.save();
  }

  res.status(200).json({
    status: 'success',
    message: 'Message added successfully',
    data: {
      message: {
        role,
        content,
        timestamp: new Date(),
        metadata
      },
      chat: {
        id: chat._id,
        messageCount: chat.messageCount,
        duration: chat.duration,
        lastActivity: chat.lastActivity
      }
    }
  });
}));

// @desc    Get messages from a chat
// @route   GET /api/chats/:id/messages
// @access  Private
router.get('/:id/messages', authenticateToken, asyncHandler(async (req, res) => {
  const { limit = 50, before } = req.query;

  const chat = await Chat.findOne({
    _id: req.params.id,
    userId: req.user._id
  });

  if (!chat) {
    return res.status(404).json({
      status: 'error',
      message: 'Chat not found'
    });
  }

  let messages = chat.messages;

  // Filter messages before a specific timestamp if provided
  if (before) {
    const beforeDate = new Date(before);
    messages = messages.filter(msg => msg.timestamp < beforeDate);
  }

  // Limit the number of messages
  messages = messages.slice(-parseInt(limit));

  res.status(200).json({
    status: 'success',
    data: {
      messages: messages.map(msg => ({
        id: msg._id,
        role: msg.role,
        content: msg.content,
        timestamp: msg.timestamp,
        metadata: msg.metadata
      })),
      chat: {
        id: chat._id,
        title: chat.title,
        messageCount: chat.messageCount
      }
    }
  });
}));

// @desc    Get chat statistics
// @route   GET /api/chats/stats
// @access  Private
router.get('/stats', authenticateToken, asyncHandler(async (req, res) => {
  const userId = req.user._id;

  const stats = await Chat.getUserStats(userId);

  // Get recent chats
  const recentChats = await Chat.findByUser(userId, { limit: 5 });

  // Get chat distribution by type
  const typeStats = await Chat.aggregate([
    { $match: { userId: userId } },
    {
      $group: {
        _id: '$interviewType',
        count: { $sum: 1 },
        avgScore: { $avg: '$score' }
      }
    }
  ]);

  res.status(200).json({
    status: 'success',
    data: {
      stats: {
        totalChats: stats.totalChats,
        totalMessages: stats.totalMessages,
        averageScore: Math.round(stats.avgScore || 0),
        totalDuration: stats.totalDuration,
        typeDistribution: typeStats.map(type => ({
          type: type._id,
          count: type.count,
          avgScore: Math.round(type.avgScore || 0)
        })),
        recentChats: recentChats.map(chat => ({
          id: chat._id,
          title: chat.title,
          status: chat.status,
          lastActivity: chat.lastActivity,
          messageCount: chat.messageCount
        }))
      }
    }
  });
}));

// @desc    Debug endpoint - Get all chats in database (Admin only)
// @route   GET /api/chats/debug/all
// @access  Private/Admin
router.get('/debug/all', authenticateToken, requireRole(['admin']), asyncHandler(async (req, res) => {
  try {
    // Get all chats with user information
    const allChats = await Chat.find({}).populate('userId', 'username email firstName lastName');
    
    // Group by user
    const chatsByUser = {};
    allChats.forEach(chat => {
      const userId = chat.userId._id.toString();
      if (!chatsByUser[userId]) {
        chatsByUser[userId] = {
          user: {
            id: chat.userId._id,
            username: chat.userId.username,
            email: chat.userId.email,
            name: `${chat.userId.firstName} ${chat.userId.lastName}`
          },
          chats: []
        };
      }
      chatsByUser[userId].chats.push({
        id: chat._id,
        title: chat.title,
        messageCount: chat.messageCount,
        createdAt: chat.createdAt
      });
    });

    res.status(200).json({
      status: 'success',
      data: {
        totalChats: allChats.length,
        totalUsers: Object.keys(chatsByUser).length,
        chatsByUser: Object.values(chatsByUser)
      }
    });
  } catch (error) {
    console.error('Debug endpoint error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to get debug information',
      error: error.message
    });
  }
}));

// @desc    Get public chats (Admin only)
// @route   GET /api/chats/public
// @access  Private/Admin
router.get('/public', authenticateToken, requireRole(['admin']), asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, interviewType, difficulty } = req.query;

  const query = { isPublic: true };
  if (interviewType) query.interviewType = interviewType;
  if (difficulty) query.difficulty = difficulty;

  const skip = (page - 1) * limit;

  const chats = await Chat.find(query)
    .populate('userId', 'username firstName lastName')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(parseInt(limit));

  const totalChats = await Chat.countDocuments(query);

  res.status(200).json({
    status: 'success',
    data: {
      chats: chats.map(chat => ({
        id: chat._id,
        title: chat.title,
        description: chat.description,
        status: chat.status,
        interviewType: chat.interviewType,
        difficulty: chat.difficulty,
        score: chat.score,
        messageCount: chat.messageCount,
        user: {
          id: chat.userId._id,
          username: chat.userId.username,
          fullName: chat.userId.fullName
        },
        createdAt: chat.createdAt
      })),
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(totalChats / limit),
        totalChats,
        hasNext: page * limit < totalChats,
        hasPrev: page > 1
      }
    }
  });
}));

// @desc    Make a chat public/private
// @route   PUT /api/chats/:id/visibility
// @access  Private
router.put('/:id/visibility', authenticateToken, asyncHandler(async (req, res) => {
  const { isPublic } = req.body;

  const chat = await Chat.findOneAndUpdate(
    {
      _id: req.params.id,
      userId: req.user._id
    },
    { isPublic },
    { new: true, runValidators: true }
  );

  if (!chat) {
    return res.status(404).json({
      status: 'error',
      message: 'Chat not found'
    });
  }

  res.status(200).json({
    status: 'success',
    message: `Chat made ${isPublic ? 'public' : 'private'} successfully`,
    data: {
      chat: {
        id: chat._id,
        title: chat.title,
        isPublic: chat.isPublic
      }
    }
  });
}));

// @desc    Save feedback to a chat
// @route   PUT /api/chats/:id/feedback
// @access  Private
router.put('/:id/feedback', authenticateToken, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { feedback } = req.body;
  const userId = req.user._id;

  console.log('📊 Saving feedback to chat:', id);
  console.log('📝 Feedback data:', feedback);

  // Find and update chat
  const chat = await Chat.findOneAndUpdate(
    {
      _id: id,
      userId: userId
    },
    {
      feedback: {
        overallScore: feedback.overallScore || 0,
        summary: feedback.summary || '',
        strengths: feedback.strengths || [],
        improvements: feedback.improvements || [],
        communication: feedback.communication || {},
        technicalKnowledge: feedback.technicalKnowledge || {},
        problemSolving: feedback.problemSolving || {},
        professionalism: feedback.professionalism || {},
        recommendation: feedback.recommendation || '',
        generatedAt: new Date()
      },
      status: 'completed',
      score: Math.round(feedback.overallScore * 10) // Convert to percentage
    },
    { new: true, runValidators: true }
  );

  if (!chat) {
    return res.status(404).json({
      status: 'error',
      message: 'Chat not found or unauthorized'
    });
  }

  console.log('✅ Feedback saved successfully');

  res.status(200).json({
    status: 'success',
    message: 'Feedback saved successfully',
    data: {
      chat: {
        id: chat._id,
        title: chat.title,
        feedback: chat.feedback
      }
    }
  });
}));

export default router; 