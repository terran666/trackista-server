'use strict';

const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const { Router } = require('express');

const { createAuthLimiter } = require('../middleware/rateLimiters');
const { authRequired }      = require('../middleware/authRequired');

const JWT_SECRET    = process.env.JWT_SECRET     || 'trackista-dev-secret-change-in-production';
const JWT_EXPIRY    = process.env.JWT_EXPIRY      || '30d';
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);

const USERNAME_RE = /^[a-zA-Z0-9_.\-]{3,64}$/;

function createAuthRouter(db, redis) {
  const router    = Router();
  const authLimit = createAuthLimiter(redis);

  // ── POST /api/auth/register ─────────────────────────────────────
  router.post('/register', authLimit, async (req, res) => {
    const username = (req.body.username || '').trim();
    const password = (req.body.password || '').trim();

    if (!username || !USERNAME_RE.test(username)) {
      return res.status(400).json({ success: false, error: 'username must be 3–64 chars (letters, digits, _, ., -)' });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ success: false, error: 'password must be at least 6 characters' });
    }

    try {
      const [[existing]] = await db.query('SELECT id FROM users WHERE username = ?', [username]);
      if (existing) {
        return res.status(409).json({ success: false, error: 'Username already taken' });
      }

      const hash   = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const [result] = await db.query(
        'INSERT INTO users (username, password_hash) VALUES (?, ?)',
        [username, hash],
      );
      const userId = result.insertId;
      const token  = jwt.sign({ sub: userId, username, role: 'user' }, JWT_SECRET, { expiresIn: JWT_EXPIRY });

      console.log(`[auth] registered user id=${userId} username=${username}`);
      return res.status(201).json({
        success: true,
        token,
        user: { id: String(userId), username, role: 'user', avatarUrl: null },
      });
    } catch (err) {
      console.error('[auth] register error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ── POST /api/auth/login ────────────────────────────────────────
  router.post('/login', authLimit, async (req, res) => {
    const username = (req.body.username || '').trim();
    const password = (req.body.password || '').trim();

    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'username and password are required' });
    }

    try {
      const [[user]] = await db.query(
        'SELECT id, username, password_hash, role, avatar_url FROM users WHERE username = ?',
        [username],
      );
      // Constant-time failure path — compare against a dummy hash to avoid timing attacks
      const dummyHash = '$2a$10$AAAAAAAAAAAAAAAAAAAAAA..AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      const match = user
        ? await bcrypt.compare(password, user.password_hash)
        : await bcrypt.compare(password, dummyHash).then(() => false);

      if (!user || !match) {
        return res.status(401).json({ success: false, error: 'Invalid credentials' });
      }

      const token = jwt.sign(
        { sub: user.id, username: user.username, role: user.role },
        JWT_SECRET,
        { expiresIn: JWT_EXPIRY },
      );

      console.log(`[auth] login user id=${user.id} username=${user.username}`);
      return res.json({
        success: true,
        token,
        user: { id: String(user.id), username: user.username, role: user.role, avatarUrl: user.avatar_url || null },
      });
    } catch (err) {
      console.error('[auth] login error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ── GET /api/auth/me ────────────────────────────────────────────
  router.get('/me', authRequired, async (req, res) => {
    try {
      const [[user]] = await db.query(
        'SELECT id, username, role, avatar_url FROM users WHERE id = ?',
        [req.user.id],
      );
      if (!user) return res.status(404).json({ success: false, error: 'User not found' });
      return res.json({
        success: true,
        user: { id: String(user.id), username: user.username, role: user.role, avatarUrl: user.avatar_url || null },
      });
    } catch (err) {
      console.error('[auth] me error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { createAuthRouter };
