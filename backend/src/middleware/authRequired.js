'use strict';

const jwt = require('jsonwebtoken');

if (!process.env.JWT_SECRET) {
  throw new Error('FATAL: JWT_SECRET environment variable must be set');
}
const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Middleware: require valid Bearer JWT.
 * Sets req.user = { id, username, role }.
 * Returns 401 if token is missing or invalid.
 */
function authRequired(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token  = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

  if (!token) {
    return res.status(401).json({ success: false, error: 'Authentication required' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload.sub || !payload.username) {
      return res.status(401).json({ success: false, error: 'Invalid token: missing required claims' });
    }
    req.user = {
      id:       Number(payload.sub),
      username: payload.username,
      role:     payload.role || 'user',
    };
    next();
  } catch (err) {
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
      if (payload.sub && payload.username) {
        req.user = {
          id:       Number(payload.sub),
          username: payload.username,
          role:     payload.role || 'user',
        };
      }
    } catch (_) { /* invalid or expired — treat as unauthenticated */ }
  }
  next();
}

module.exports = { authRequired, optionalAuth };
