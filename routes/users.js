import express from 'express';
import User from '../models/User.js';
import Chat from '../models/Chat.js';
import { authenticateToken, requireRole } from '../middleware/auth.js';
import { validateProfileUpdate, validateTargetJob } from '../middleware/validation.js';
import { asyncHandler } from '../middleware/errorHandler.js';

const router = express.Router();

// @desc    Get user profile
// @route   GET /api/users/profile
// @access  Private
router.get('/profile', authenticateToken, asyncHandler(async (req, res) => {
  res.status(200).json({
    status: 'success',
    data: {
      user: req.user.getPublicProfile()
    }
  });
}));

// @desc    Update user profile
// @route   PUT /api/users/profile
// @access  Private
router.put('/profile', authenticateToken, validateProfileUpdate, asyncHandler(async (req, res) => {
  const { firstName, lastName, username, profilePicture } = req.body;
  const userId = req.user._id;

  // Check if username is being changed and if it's already taken
  if (username && username !== req.user.username) {
    const existingUser = await User.findOne({ username });
    if (existingUser) {
      return res.status(400).json({
        status: 'error',
        message: 'Username is already taken'
      });
    }
  }

  const updatedUser = await User.findByIdAndUpdate(
    userId,
    {
      firstName,
      lastName,
      username,
      profilePicture
    },
    { new: true, runValidators: true }
  ).select('-password');

  res.status(200).json({
    status: 'success',
    message: 'Profile updated successfully',
    data: {
      user: updatedUser.getPublicProfile()
    }
  });
}));

// @desc    Upgrade to paid (mock)
// @route   POST /api/users/upgrade
// @access  Private
router.post('/upgrade', authenticateToken, asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const user = await User.findByIdAndUpdate(
    userId,
    { isPaid: true },
    { new: true }
  );

  res.status(200).json({
    status: 'success',
    message: 'Account upgraded to paid',
    data: {
      user: user.getPublicProfile()
    }
  });
}));

// @desc    List target jobs
// @route   GET /api/users/jobs
// @access  Private
router.get('/jobs', authenticateToken, asyncHandler(async (req, res) => {
  const user = await User.findById(req.user._id).select('targetJobs');
  res.status(200).json({
    status: 'success',
    data: {
      jobs: (user?.targetJobs || []).map(job => ({
        id: job._id,
        role: job.role,
        company: job.company,
        location: job.location,
        skills: job.skills,
        notes: job.notes,
        createdAt: job.createdAt
      }))
    }
  });
}));

// @desc    Add a target job
// @route   POST /api/users/jobs
// @access  Private
router.post('/jobs', authenticateToken, validateTargetJob, asyncHandler(async (req, res) => {
  const { role, company = '', location = '', skills = [], notes = '' } = req.body;
  const user = await User.findById(req.user._id).select('targetJobs');
  const skillsArr = Array.isArray(skills) ? skills : (typeof skills === 'string' ? skills.split(',').map(s => s.trim()).filter(Boolean) : []);
  const job = { role, company, location, skills: skillsArr, notes };
  user.targetJobs.push(job);
  await user.save();
  const saved = user.targetJobs[user.targetJobs.length - 1];
  res.status(201).json({
    status: 'success',
    message: 'Target job added',
    data: { job: { id: saved._id, ...job, createdAt: saved.createdAt } }
  });
}));

// @desc    Update a target job
// @route   PUT /api/users/jobs/:jobId
// @access  Private
router.put('/jobs/:jobId', authenticateToken, validateTargetJob, asyncHandler(async (req, res) => {
  const { jobId } = req.params;
  const user = await User.findById(req.user._id).select('targetJobs');
  const job = user.targetJobs.id(jobId);
  if (!job) {
    return res.status(404).json({ status: 'error', message: 'Job not found' });
  }
  const { role, company, location, skills, notes } = req.body;
  if (role !== undefined) job.role = role;
  if (company !== undefined) job.company = company;
  if (location !== undefined) job.location = location;
  if (skills !== undefined) {
    job.skills = Array.isArray(skills) ? skills : (typeof skills === 'string' ? skills.split(',').map(s => s.trim()).filter(Boolean) : job.skills);
  }
  if (notes !== undefined) job.notes = notes;
  await user.save();
  res.status(200).json({ status: 'success', message: 'Target job updated' });
}));

// @desc    Delete a target job
// @route   DELETE /api/users/jobs/:jobId
// @access  Private
router.delete('/jobs/:jobId', authenticateToken, asyncHandler(async (req, res) => {
  const { jobId } = req.params;
  const user = await User.findById(req.user._id).select('targetJobs');
  const job = user.targetJobs.id(jobId);
  if (!job) {
    return res.status(404).json({ status: 'error', message: 'Job not found' });
  }
  job.deleteOne();
  await user.save();
  res.status(200).json({ status: 'success', message: 'Target job deleted' });
}));

// @desc    Get user statistics
// @route   GET /api/users/stats
// @access  Private
router.get('/stats', authenticateToken, asyncHandler(async (req, res) => {
  const userId = req.user._id;

  // Get chat statistics
  const chatStats = await Chat.getUserStats(userId);

  // Get user's recent activity
  const recentChats = await Chat.findByUser(userId, { limit: 5 });

  res.status(200).json({
    status: 'success',
    data: {
      stats: {
        totalChats: chatStats.totalChats,
        totalMessages: chatStats.totalMessages,
        averageScore: Math.round(chatStats.avgScore || 0),
        totalDuration: chatStats.totalDuration,
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

// @desc    Get user's chat history
// @route   GET /api/users/chats
// @access  Private
router.get('/chats', authenticateToken, asyncHandler(async (req, res) => {
  const userId = req.user._id;
  const { page = 1, limit = 10, status, interviewType } = req.query;

  const options = {};
  if (status) options.status = status;
  if (interviewType) options.interviewType = interviewType;

  const skip = (page - 1) * limit;

  const chats = await Chat.findByUser(userId, options)
    .skip(skip)
    .limit(parseInt(limit));

  const totalChats = await Chat.countDocuments({ userId, ...options });

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

// @desc    Delete user account
// @route   DELETE /api/users/account
// @access  Private
router.delete('/account', authenticateToken, asyncHandler(async (req, res) => {
  const userId = req.user._id;

  // Delete all user's chats
  await Chat.deleteMany({ userId });

  // Delete user account
  await User.findByIdAndDelete(userId);

  res.status(200).json({
    status: 'success',
    message: 'Account deleted successfully'
  });
}));

// @desc    Get all users (Admin only)
// @route   GET /api/users
// @access  Private/Admin
router.get('/', authenticateToken, requireRole(['admin']), asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, search } = req.query;
  const skip = (page - 1) * limit;

  const query = {};
  if (search) {
    query.$or = [
      { username: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
      { firstName: { $regex: search, $options: 'i' } },
      { lastName: { $regex: search, $options: 'i' } }
    ];
  }

  const users = await User.find(query)
    .select('-password')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(parseInt(limit));

  const totalUsers = await User.countDocuments(query);

  res.status(200).json({
    status: 'success',
    data: {
      users: users.map(user => user.getPublicProfile()),
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(totalUsers / limit),
        totalUsers,
        hasNext: page * limit < totalUsers,
        hasPrev: page > 1
      }
    }
  });
}));

// @desc    Get user by ID (Admin only)
// @route   GET /api/users/:id
// @access  Private/Admin
router.get('/:id', authenticateToken, requireRole(['admin']), asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id).select('-password');

  if (!user) {
    return res.status(404).json({
      status: 'error',
      message: 'User not found'
    });
  }

  res.status(200).json({
    status: 'success',
    data: {
      user: user.getPublicProfile()
    }
  });
}));

// @desc    Update user role (Admin only)
// @route   PUT /api/users/:id/role
// @access  Private/Admin
router.put('/:id/role', authenticateToken, requireRole(['admin']), asyncHandler(async (req, res) => {
  const { role } = req.body;

  if (!['user', 'admin'].includes(role)) {
    return res.status(400).json({
      status: 'error',
      message: 'Invalid role'
    });
  }

  const user = await User.findByIdAndUpdate(
    req.params.id,
    { role },
    { new: true, runValidators: true }
  ).select('-password');

  if (!user) {
    return res.status(404).json({
      status: 'error',
      message: 'User not found'
    });
  }

  res.status(200).json({
    status: 'success',
    message: 'User role updated successfully',
    data: {
      user: user.getPublicProfile()
    }
  });
}));

export default router; 