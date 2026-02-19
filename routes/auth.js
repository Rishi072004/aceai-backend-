import express from 'express';
import User from '../models/User.js';
import { authenticateToken, generateToken } from '../middleware/auth.js';
import { validateRegistration, validateLogin, validatePasswordChange } from '../middleware/validation.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { OAuth2Client } from 'google-auth-library';

const router = express.Router();
const googleClient = process.env.GOOGLE_CLIENT_ID ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID) : null;

// @desc    Register a new user
// @route   POST /api/auth/register
// @access  Public
router.post('/register', validateRegistration, asyncHandler(async (req, res) => {
  const { username, email, password, firstName, lastName } = req.body;
  console.log(req.body);
    // Check if user already exists
  const existingUser = await User.findOne({
    $or: [{ email }, { username }]
  });

  if (existingUser) {
    return res.status(400).json({
      status: 'error',
      message: 'User with this email or username already exists'
    });
  }

  // Create new user
  const user = new User({
    username,
    email,
    password,
    firstName,
    lastName
  });

  await user.save();

  // Generate token
  const token = generateToken(user._id);

  // Update last login
  user.lastLogin = new Date();
  await user.save();

  res.status(201).json({
    status: 'success',
    message: 'User registered successfully',
    data: {
      user: user.getPublicProfile(),
      token
    }
  });
}));

// @desc    Login user
// @route   POST /api/auth/login
// @access  Public
router.post('/login', validateLogin, asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  // Find user by credentials
  const user = await User.findByCredentials(email, password);

  // Generate token
  const token = generateToken(user._id);

  // Update last login
  user.lastLogin = new Date();
  await user.save();

  res.status(200).json({
    status: 'success',
    message: 'Login successful',
    data: {
      user: user.getPublicProfile(),
      token
    }
  });
}));

// @desc    Get current user
// @route   GET /api/auth/me
// @access  Private
router.get('/me', authenticateToken, asyncHandler(async (req, res) => {
  console.log('GET /api/auth/me - User ID:', req.user._id);
  console.log('User object:', req.user);
  
  res.status(200).json({
    status: 'success',
    data: {
      user: req.user.getPublicProfile()
    }
  });
}));

// @desc    Debug endpoint - Check authentication
// @route   GET /api/auth/debug
// @access  Private
router.get('/debug', authenticateToken, asyncHandler(async (req, res) => {
  console.log('=== AUTH DEBUG ===');
  console.log('User ID:', req.user._id);
  console.log('User email:', req.user.email);
  console.log('User object:', req.user);
  
  res.status(200).json({
    status: 'success',
    data: {
      message: 'Authentication working',
      user: {
        id: req.user._id,
        email: req.user.email,
        firstName: req.user.firstName,
        lastName: req.user.lastName
      }
    }
  });
}));

// @desc    Update user profile
// @route   PUT /api/auth/profile
// @access  Private
router.put('/profile', authenticateToken, asyncHandler(async (req, res) => {
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

// @desc    Change password
// @route   PUT /api/auth/change-password
// @access  Private
router.put('/change-password', authenticateToken, validatePasswordChange, asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  const userId = req.user._id;

  // Get user with password
  const user = await User.findById(userId).select('+password');

  // Verify current password
  const isMatch = await user.comparePassword(currentPassword);
  if (!isMatch) {
    return res.status(400).json({
      status: 'error',
      message: 'Current password is incorrect'
    });
  }

  // Update password
  user.password = newPassword;
  await user.save();

  res.status(200).json({
    status: 'success',
    message: 'Password changed successfully'
  });
}));

// @desc    Logout user (client-side token removal)
// @route   POST /api/auth/logout
// @access  Private
router.post('/logout', authenticateToken, asyncHandler(async (req, res) => {
  // In a stateless JWT setup, logout is handled client-side
  // But we can log the logout event
  res.status(200).json({
    status: 'success',
    message: 'Logged out successfully'
  });
}));

// @desc    Refresh token
// @route   POST /api/auth/refresh
// @access  Private
router.post('/refresh', authenticateToken, asyncHandler(async (req, res) => {
  const newToken = generateToken(req.user._id);

  res.status(200).json({
    status: 'success',
    message: 'Token refreshed successfully',
    data: {
      token: newToken
    }
  });
}));

// @desc    Login/Register with Google ID token
// @route   POST /api/auth/google
// @access  Public
router.post('/google', asyncHandler(async (req, res) => {
  try {
    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing Google ID token'
      });
    }

    if (!googleClient) {
      return res.status(500).json({
        status: 'error',
        message: 'Google client not configured'
      });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID
    });

    const payload = ticket.getPayload();
    if (!payload || !payload.email) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid Google token payload'
      });
    }

    const email = payload.email;
    const firstName = payload.given_name || 'User';
    const lastName = payload.family_name || 'Google';
    const profilePicture = payload.picture || '';

    let user = await User.findOne({ email });

    if (!user) {
      // Generate a username based on email local-part, ensure uniqueness
      const baseUsername = (email.split('@')[0] || 'user').replace(/[^a-zA-Z0-9_\.\-]/g, '').slice(0, 30) || 'user';
      let usernameCandidate = baseUsername;
      let suffix = 1;
      while (await User.findOne({ username: usernameCandidate })) {
        const nextCandidate = `${baseUsername}${suffix}`;
        usernameCandidate = nextCandidate.slice(0, 30);
        suffix += 1;
      }

      // Set a random password to satisfy schema requirements (not used for Google login)
      const randomPassword = `${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;

      user = new User({
        username: usernameCandidate,
        email,
        password: randomPassword,
        firstName,
        lastName,
        profilePicture
      });
      await user.save();
    }

    user.lastLogin = new Date();
    await user.save();

    const token = generateToken(user._id);

    res.status(200).json({
      status: 'success',
      message: 'Google login successful',
      data: {
        user: user.getPublicProfile(),
        token
      }
    });
  } catch (error) {
    return res.status(401).json({
      status: 'error',
      message: 'Google authentication failed'
    });
  }
}));

export default router; 