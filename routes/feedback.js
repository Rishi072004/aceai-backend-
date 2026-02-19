import express from 'express';
import nodemailer from 'nodemailer';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';

dotenv.config();

const router = express.Router();

// Create transporter once using env vars
const transportOptions = {
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : undefined,
  secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
};

let transporter;
try {
  transporter = nodemailer.createTransport(transportOptions);
  // Verify transporter at startup to catch config problems early
  transporter.verify()
    .then(() => {
      console.log('Nodemailer transporter verified successfully');
    })
    .catch((err) => {
      console.error('Nodemailer transporter verification failed:', err);
    });
} catch (err) {
  console.error('Failed to create nodemailer transporter', err);
}

// Helper to attempt to resolve userId from Authorization header (optional)
const tryResolveUser = async (req) => {
  try {
    const auth = req.headers?.authorization;
    if (!auth) return null;
    const token = auth.split(' ')[1];
    if (!token) return null;
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded?.userId) return null;
    const user = await User.findById(decoded.userId).select('-password');
    return user || null;
  } catch (err) {
    return null;
  }
};

// POST /api/feedback
router.post('/', async (req, res) => {
  try {
    const { name, email, designation, feedback, planType, featureName } = req.body || {};

    // Basic validation
    if (!email || !email.trim()) {
      return res.status(400).json({ status: 'error', message: 'Email is required' });
    }
    if (!feedback || !feedback.trim()) {
      return res.status(400).json({ status: 'error', message: 'Feedback is required' });
    }

    const user = await tryResolveUser(req);

    const timestamp = new Date().toISOString();

    // Build structured email content
    const subject = `New Feedback${email ? ` from ${email}` : ''}`;

    const plainBody = [
      `New feedback received`,
      `---------------------`,
      `Timestamp: ${timestamp}`,
      ``,
      `Name: ${name || '—'}`,
      `Email: ${email}`,
      `Designation: ${designation || '—'}`,
      `Plan Type: ${planType || '—'}`,
      `Feature: ${featureName || '—'}`,
      `User ID: ${user?._id || 'anonymous'}`,
      `User Email (from token): ${user?.email || '—'}`,
      ``,
      `Feedback:`,
      `${feedback}`,
    ].join('\n');

    const htmlBody = `
      <h2>New feedback received</h2>
      <p><strong>Timestamp:</strong> ${timestamp}</p>
      <ul>
        <li><strong>Name:</strong> ${name || '&mdash;'}</li>
        <li><strong>Email:</strong> ${email}</li>
        <li><strong>Designation:</strong> ${designation || '&mdash;'}</li>
        <li><strong>Plan Type:</strong> ${planType || '&mdash;'}</li>
        <li><strong>Feature:</strong> ${featureName || '&mdash;'}</li>
        <li><strong>User ID:</strong> ${user?._id || 'anonymous'}</li>
        <li><strong>User Email (from token):</strong> ${user?.email || '&mdash;'}</li>
      </ul>
      <h3>Feedback</h3>
      <p>${(feedback || '').replace(/\n/g,'<br/>')}</p>
    `;

    // Send response early to avoid blocking; send the email asynchronously
    res.status(200).json({ status: 'success', message: 'Feedback received' });

    // If transporter is available and ADMIN_EMAIL is configured, send email in background
    if (transporter && process.env.ADMIN_EMAIL) {
      transporter.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: process.env.ADMIN_EMAIL,
        subject,
        text: plainBody,
        html: htmlBody,
      })
      .then(info => {
        console.log('Feedback email send response:', info);
        // nodemailer info can contain accepted/rejected arrays depending on transport
        if (info.accepted) console.log('Accepted recipients:', info.accepted);
        if (info.rejected) console.warn('Rejected recipients:', info.rejected);
        if (info.rejected && info.rejected.length) {
          console.warn('Some recipients were rejected; check SMTP credentials and ADMIN_EMAIL');
        }
      })
      .catch(err => {
        console.error('Failed to send feedback email:', err);
      });
    } else {
      if (!transporter) console.warn('Email not sent: transporter not configured');
      if (!process.env.ADMIN_EMAIL) console.warn('Email not sent: ADMIN_EMAIL not configured');
    }

  } catch (err) {
    console.error('Error in feedback route:', err);
    // If something went wrong after we've already responded, just log it
    if (!res.headersSent) {
      res.status(500).json({ status: 'error', message: 'Server error' });
    }
  }
});

export default router;

// Test-only endpoint to trigger a test email and show transporter status.
// Protected by TEST_EMAIL_KEY when set and disabled in production unless a key is provided.
router.get('/test-email', async (req, res) => {
  try {
    const providedKey = req.headers['x-test-key'] || req.query.key;

    if (process.env.NODE_ENV === 'production' && !process.env.TEST_EMAIL_KEY) {
      return res.status(403).json({ status: 'error', message: 'Test endpoint disabled in production' });
    }

    if (process.env.TEST_EMAIL_KEY && providedKey !== process.env.TEST_EMAIL_KEY) {
      return res.status(401).json({ status: 'error', message: 'Invalid test key' });
    }

    if (!transporter) {
      return res.status(500).json({ status: 'error', message: 'Email transporter not configured' });
    }

    // verify transporter before sending
    try {
      await transporter.verify();
    } catch (vErr) {
      console.error('Transporter verify failed on test:', vErr);
      return res.status(500).json({ status: 'error', message: 'Transporter verification failed', detail: vErr.message });
    }

    const testTimestamp = new Date().toISOString();
    const subject = `Test feedback email at ${testTimestamp}`;
    const text = `This is a test feedback email sent at ${testTimestamp}. If you receive this, transporter and SMTP settings are correct.`;

    const info = await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: process.env.ADMIN_EMAIL,
      subject,
      text,
    });

    console.log('Test email send info:', info);

    return res.status(200).json({ status: 'success', info });
  } catch (err) {
    console.error('Error sending test email:', err);
    return res.status(500).json({ status: 'error', message: 'Failed to send test email', detail: err.message });
  }
});
