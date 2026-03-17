'use strict';

/**
 * Social feed posts router — mounted at /api/posts.
 *
 * NOTE: Intentionally uses /api/posts (not /api/alerts) to avoid route
 * conflicts with the existing market-impulse alerts endpoints
 * (/api/alerts/recent, /api/alerts/watchlist, /api/alerts/:symbol).
 */

const { Router } = require('express');

const { authRequired, optionalAuth }                         = require('../middleware/authRequired');
const { upload, handleUploadError }                          = require('../middleware/uploadMiddleware');
const { createPostLimiter, createCommentLimiter, createVoteLimiter } = require('../middleware/rateLimiters');
const { validateCreatePost, validateComment, validateVote }  = require('../validators/alertValidators');
const storage      = require('../services/alertStorageService');
const postsRepo    = require('../repositories/alertPostsRepo');
const commentsRepo = require('../repositories/alertCommentsRepo');
const votesRepo    = require('../repositories/alertVotesRepo');

function createPostsRouter(db, redis) {
  const router = Router();

  const postLimit    = createPostLimiter(redis);
  const commentLimit = createCommentLimiter(redis);
  const voteLimit    = createVoteLimiter(redis);

  // ── POST /api/posts ──────────────────────────────────────────────
  // Create a new alert post with a screenshot image.
  router.post(
    '/',
    authRequired,
    postLimit,
    upload.single('image'),
    handleUploadError,
    async (req, res) => {
      // ── DEBUG: log incoming multipart payload ──────────────────
      console.log('[posts-debug] POST /api/posts body:', JSON.stringify(req.body));
      console.log('[posts-debug] POST /api/posts file:', req.file
        ? { fieldname: req.file.fieldname, originalname: req.file.originalname, mimetype: req.file.mimetype, size: req.file.size }
        : '(no file)');
      // ──────────────────────────────────────────────────────────

      const { errors, parsed } = validateCreatePost(req.body, req.file);
      if (errors.length) {
        console.log('[posts-debug] POST /api/posts validation errors:', errors);
        return res.status(400).json({ success: false, errors });
      }

      let storageResult;
      try {
        storageResult = await storage.uploadAlertImage(req.file.buffer, req.user.id);
      } catch (err) {
        if (err.code === 'UNSUPPORTED_MEDIA_TYPE') {
          return res.status(415).json({ success: false, error: err.message });
        }
        console.error('[posts] image upload failed:', err.message);
        return res.status(500).json({ success: false, error: 'Image upload failed' });
      }

      try {
        const postId = await postsRepo.createPost(db, {
          authorId:    req.user.id,
          imageUrl:    storageResult.url,
          imageKey:    storageResult.key,
          imageWidth:  storageResult.width,
          imageHeight: storageResult.height,
          ...parsed,
        });

        const row = await postsRepo.getPostWithViewerVote(db, postId, req.user.id);
        console.log(`[posts] created post id=${postId} by user=${req.user.id} symbol=${parsed.symbol}`);
        return res.status(201).json({ success: true, post: postsRepo.toPostDTO(row, req.user.id) });
      } catch (err) {
        // Clean up the uploaded file if DB insert fails
        storage.deleteAlertImage(storageResult.key).catch(() => {});
        console.error('[posts] DB insert failed:', err.message);
        return res.status(500).json({ success: false, error: 'Internal server error' });
      }
    },
  );

  // ── GET /api/posts ───────────────────────────────────────────────
  // Feed with cursor-based pagination and optional filters.
  router.get('/', optionalAuth, async (req, res) => {
    const limit     = Math.min(parseInt(req.query.limit    || '20', 10), 50);
    const cursor    = req.query.cursor    || null;
    const symbol    = req.query.symbol    ? String(req.query.symbol).toUpperCase() : undefined;
    const authorId  = req.query.authorId  || undefined;
    const timeframe = req.query.timeframe || undefined;
    const market    = req.query.market    || undefined;

    try {
      const { rows, nextCursor } = await postsRepo.getFeed(db, {
        limit, cursor, symbol, authorId, timeframe, market,
        viewerUserId: req.user?.id,
      });
      const items = rows.map(r => postsRepo.toPostDTO(r, req.user?.id));
      return res.json({ success: true, count: items.length, items, nextCursor });
    } catch (err) {
      console.error('[posts] getFeed error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ── GET /api/posts/:id ───────────────────────────────────────────
  router.get('/:id', optionalAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid post id' });
    }

    try {
      const row = await postsRepo.getPostWithViewerVote(db, id, req.user?.id);
      if (!row) return res.status(404).json({ success: false, error: 'Post not found' });

      if (row.status !== 'active') {
        const isMod = req.user?.role === 'moderator' || req.user?.role === 'admin';
        if (!isMod) return res.status(404).json({ success: false, error: 'Post not found' });
      }

      postsRepo.incrementViews(db, id).catch(() => {}); // fire-and-forget
      return res.json({ success: true, post: postsRepo.toPostDTO(row, req.user?.id) });
    } catch (err) {
      console.error('[posts] getPost error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ── DELETE /api/posts/:id ────────────────────────────────────────
  router.delete('/:id', authRequired, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid post id' });
    }

    try {
      const row = await postsRepo.getPostById(db, id);
      if (!row || row.status === 'deleted') {
        return res.status(404).json({ success: false, error: 'Post not found' });
      }

      const isOwner = String(row.author_id) === String(req.user.id);
      const isMod   = req.user.role === 'moderator' || req.user.role === 'admin';
      if (!isOwner && !isMod) {
        console.warn(`[posts] delete forbidden: user=${req.user.id} tried post=${id} by author=${row.author_id}`);
        return res.status(403).json({ success: false, error: 'Forbidden' });
      }

      await postsRepo.softDeletePost(db, id);
      console.log(`[posts] soft-deleted post id=${id} by user=${req.user.id}`);
      return res.json({ success: true });
    } catch (err) {
      console.error('[posts] deletePost error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ── POST /api/posts/:id/vote ─────────────────────────────────────
  router.post('/:id/vote', authRequired, voteLimit, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid post id' });
    }

    const { errors, parsed } = validateVote(req.body);
    if (errors.length) return res.status(400).json({ success: false, errors });

    try {
      const result = await votesRepo.processVote(db, { postId: id, userId: req.user.id, vote: parsed.vote });
      if (!result) return res.status(404).json({ success: false, error: 'Post not found' });

      return res.json({
        success: true,
        stats:       { likesCount: result.likesCount, dislikesCount: result.dislikesCount },
        viewerState: { vote: result.vote },
      });
    } catch (err) {
      console.error('[posts] vote error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ── GET /api/posts/:id/comments ──────────────────────────────────
  router.get('/:id/comments', optionalAuth, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid post id' });
    }

    const limit  = Math.min(parseInt(req.query.limit || '50', 10), 100);
    const cursor = req.query.cursor || null;

    try {
      const { rows, nextCursor } = await commentsRepo.getComments(db, { postId: id, limit, cursor });
      const items = rows.map(commentsRepo.toCommentDTO);
      return res.json({ success: true, count: items.length, items, nextCursor });
    } catch (err) {
      console.error('[posts] getComments error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ── POST /api/posts/:id/comments ─────────────────────────────────
  router.post('/:id/comments', authRequired, commentLimit, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid post id' });
    }

    const { errors, parsed } = validateComment(req.body);
    if (errors.length) return res.status(400).json({ success: false, errors });

    try {
      const [[post]] = await db.query(
        "SELECT id FROM alert_posts WHERE id = ? AND status = 'active'",
        [id],
      );
      if (!post) return res.status(404).json({ success: false, error: 'Post not found' });

      const commentId  = await commentsRepo.createComment(db, { postId: id, authorId: req.user.id, text: parsed.text });
      const commentRow = await commentsRepo.getCommentById(db, commentId);

      console.log(`[posts] comment id=${commentId} on post=${id} by user=${req.user.id}`);
      return res.status(201).json({ success: true, comment: commentsRepo.toCommentDTO(commentRow) });
    } catch (err) {
      console.error('[posts] createComment error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ── DELETE /api/posts/comments/:commentId ────────────────────────
  // Note: placed BEFORE /:id routes, but Express evaluates in registration order.
  // The /comments/:commentId path is distinct enough not to conflict.
  router.delete('/comments/:commentId', authRequired, async (req, res) => {
    const commentId = parseInt(req.params.commentId, 10);
    if (!Number.isInteger(commentId) || commentId <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid comment id' });
    }

    try {
      const row = await commentsRepo.getCommentById(db, commentId);
      if (!row || row.status === 'deleted') {
        return res.status(404).json({ success: false, error: 'Comment not found' });
      }

      const isAuthor  = String(row.author_id) === String(req.user.id);
      const isMod     = req.user.role === 'moderator' || req.user.role === 'admin';

      // Post owner may also remove comments on their own post
      const [[postRow]] = await db.query('SELECT author_id FROM alert_posts WHERE id = ?', [row.post_id]);
      const isPostOwner = postRow && String(postRow.author_id) === String(req.user.id);

      if (!isAuthor && !isMod && !isPostOwner) {
        console.warn(`[posts] delete comment forbidden: user=${req.user.id} comment=${commentId}`);
        return res.status(403).json({ success: false, error: 'Forbidden' });
      }

      const deleted = await commentsRepo.softDeleteComment(db, commentId, row.post_id);
      if (!deleted) return res.status(404).json({ success: false, error: 'Comment not found' });

      console.log(`[posts] soft-deleted comment id=${commentId} by user=${req.user.id}`);
      return res.json({ success: true });
    } catch (err) {
      console.error('[posts] deleteComment error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  return router;
}

module.exports = { createPostsRouter };
