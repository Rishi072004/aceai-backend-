import express from 'express';
import {
  checkConfig,
  getPlans,
  createOrder,
  verifyPayment,
  getSubscriptionStatus,
  getPaymentHistory,
  consumeStarterCredit
} from '../controllers/paymentController.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// @route   GET /api/payments/config
// @access  Private (debug)
router.get('/config', authenticateToken, checkConfig);

// @route   GET /api/payments/plans
// @access  Public
router.get('/plans', getPlans);

// @route   POST /api/payments/create-order
// @access  Private
router.post('/create-order', authenticateToken, createOrder);

// @route   POST /api/payments/verify
// @access  Private
router.post('/verify', authenticateToken, verifyPayment);

// @route   GET /api/payments/subscription
// @access  Private
router.get('/subscription', authenticateToken, getSubscriptionStatus);

// @route   GET /api/payments/history
// @access  Private
router.get('/history', authenticateToken, getPaymentHistory);

// @route   POST /api/payments/consume-starter
// @access  Private
router.post('/consume-starter', authenticateToken, consumeStarterCredit);

export default router;
