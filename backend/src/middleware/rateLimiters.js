'use strict';

/**
 * Redis-based sliding-window rate limiter using INCR + EXPIRE.
 *
 * @param {{ max: number, windowSec: number, keyPrefix: string }} opts
 * @returns {function(redis): function(req, res, next)}
 */
function createRateLimiter({ max, windowSec, keyPrefix }) {
  return function makeMiddleware(redis) {
    return async function rateLimiter(req, res, next) {
      const userId = req.user?.id || 'anon';
      const ip     = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || 'unknown';
      const key    = `rl:${keyPrefix}:${ip}:${userId}`;

      try {
        const count = await redis.incr(key);
        if (count === 1) {
          await redis.expire(key, windowSec);
        }
        if (count > max) {
          const ttl = await redis.ttl(key);
          res.set('Retry-After', String(Math.max(ttl, 1)));
          return res.status(429).json({
            success:       false,
            error:         'Too many requests. Please slow down.',
            retryAfterSec: Math.max(ttl, 1),
          });
        }
        next();
      } catch (err) {
        // Fail open: if Redis is down don't block requests
        console.error(`[rate-limiter] Redis error key=${key}: ${err.message}`);
        next();
      }
    };
  };
}

// Pre-configured limiters — limits are tunable via env vars (useful for dev/test).
// Defaults are production-safe; override in .env for looser dev limits.
//   RATE_LIMIT_POST_MAX=10        RATE_LIMIT_POST_WINDOW_SEC=3600
//   RATE_LIMIT_COMMENT_MAX=30     RATE_LIMIT_COMMENT_WINDOW_SEC=3600
//   RATE_LIMIT_VOTE_MAX=200       RATE_LIMIT_VOTE_WINDOW_SEC=3600
//   RATE_LIMIT_AUTH_MAX=10        RATE_LIMIT_AUTH_WINDOW_SEC=60
const createPostLimiter    = createRateLimiter({ max: parseInt(process.env.RATE_LIMIT_POST_MAX    || '10',  10) || 10,   windowSec: parseInt(process.env.RATE_LIMIT_POST_WINDOW_SEC    || '3600', 10) || 3600, keyPrefix: 'post' });
const createCommentLimiter = createRateLimiter({ max: parseInt(process.env.RATE_LIMIT_COMMENT_MAX || '30',  10) || 30,   windowSec: parseInt(process.env.RATE_LIMIT_COMMENT_WINDOW_SEC || '3600', 10) || 3600, keyPrefix: 'comment' });
const createVoteLimiter    = createRateLimiter({ max: parseInt(process.env.RATE_LIMIT_VOTE_MAX    || '200', 10) || 200,  windowSec: parseInt(process.env.RATE_LIMIT_VOTE_WINDOW_SEC    || '3600', 10) || 3600, keyPrefix: 'vote' });
const createAuthLimiter    = createRateLimiter({ max: parseInt(process.env.RATE_LIMIT_AUTH_MAX    || '10',  10) || 10,   windowSec: parseInt(process.env.RATE_LIMIT_AUTH_WINDOW_SEC    || '60',   10) || 60,   keyPrefix: 'auth' });

module.exports = { createPostLimiter, createCommentLimiter, createVoteLimiter, createAuthLimiter };
