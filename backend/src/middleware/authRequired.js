'use strict';

const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'trackista-dev-secret-change-in-production';

/**
 * Middleware: require valid Bearer JWT.
 * Sets req.user = { id, username, role }.
 * Returns 401 if token is missing or invalid.
 */
function authRequired(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

  // ── DEBUG: log auth details for every request ──────────────────
  console.log(`[auth-debug] ${req.method} ${req.path}`);
  console.log(`[auth-debug]   authorization header: ${header ? JSON.stringify(header.slice(0, 40) + (header.length > 40 ? '...' : '')) : '(missing)'}`);
  console.log(`[auth-debug]   token extracted: ${token ? 'yes (' + token.length + ' chars)' : 'NO'}`);
  console.log(`[auth-debug]   content-type: ${req.headers['content-type'] || '(missing)'}`);
  console.log(`[auth-debug]   origin: ${req.headers['origin'] || '(missing)'}`);
  // ──────────────────────────────────────────────────────────────

  if (!token) {
    console.log('[auth-debug]   REJECT: no token in Authorization header');
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = {
      id:       Number(payload.sub),
      username: payload.username,
      role:     payload.role || 'user',
    };
    console.log(`[auth-debug]   OK: user id=${req.user.id} username=${req.user.username}`);
    next();
  } catch (err) {
    console.log(`[auth-debug]   REJECT: token invalid — ${err.message}`);
    return res.status(401).json({ success: false, error: 'Invalid or expired token' });
  }
}

/**
 * Middleware: optional auth.
 * Attaches req.user if a valid Bearer token is present, but does NOT block the request.
 */
function optionalAuth(req, _res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      req.user = {
        id:       Number(payload.sub),
        username: payload.username,
        role:     payload.role || 'user',
      };
    } catch (_) { /* ignore */ }
  }
  next();
}

module.exports = { authRequired, optionalAuth };
