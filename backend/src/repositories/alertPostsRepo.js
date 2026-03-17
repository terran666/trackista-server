'use strict';

/**
 * Build a normalized post DTO from a raw MySQL row (with joined user fields).
 * viewer_vote comes from a LEFT JOIN on alert_votes aliased as _viewer_vote.
 */
function toPostDTO(row, viewerUserId = null) {
  if (!row) return null;
  const isOwner = viewerUserId != null && String(row.author_id) === String(viewerUserId);
  const isMod   = row._viewer_role === 'moderator' || row._viewer_role === 'admin';
  return {
    id: String(row.id),
    author: row.author_id
      ? { id: String(row.author_id), username: row.username || null, avatarUrl: row.avatar_url || null }
      : null,
    imageUrl:    row.image_url,
    imageWidth:  row.image_width  || null,
    imageHeight: row.image_height || null,
    symbol:      row.symbol,
    market:      row.market,
    timeframe:   row.timeframe,
    note:        row.note,
    source:      row.source,
    chartContext: {
      exchangeName: row.exchange_name || null,
      layoutName:   row.layout_name   || null,
      chartPrice:   row.chart_price != null ? parseFloat(row.chart_price) : null,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stats: {
      likesCount:    row.likes_count    || 0,
      dislikesCount: row.dislikes_count || 0,
      commentsCount: row.comments_count || 0,
      viewsCount:    row.views_count    || 0,
    },
    viewerState: {
      vote:      row._viewer_vote || null,
      canDelete: isOwner || isMod,
      canEdit:   isOwner,
    },
  };
}

async function createPost(db, {
  authorId, imageUrl, imageKey, imageWidth, imageHeight,
  symbol, market, timeframe, note, source,
  exchangeName, layoutName, chartPrice,
}) {
  const [result] = await db.query(
    `INSERT INTO alert_posts
       (author_id, image_url, image_key, image_width, image_height,
        symbol, market, timeframe, note, source,
        exchange_name, layout_name, chart_price)
     VALUES (?, ?, ?, ?, ?,  ?, ?, ?, ?, ?,  ?, ?, ?)`,
    [authorId, imageUrl, imageKey, imageWidth, imageHeight,
     symbol, market, timeframe, note, source,
     exchangeName, layoutName, chartPrice],
  );
  return result.insertId;
}

async function getPostById(db, id) {
  const [rows] = await db.query(
    `SELECT p.*, u.username, u.avatar_url
       FROM alert_posts p
       LEFT JOIN users u ON u.id = p.author_id
      WHERE p.id = ?`,
    [id],
  );
  return rows[0] || null;
}

/**
 * Fetch post WITH the viewer's own vote attached (_viewer_vote field).
 */
async function getPostWithViewerVote(db, postId, viewerUserId) {
  const [rows] = await db.query(
    `SELECT p.*, u.username, u.avatar_url,
            v.vote_type AS _viewer_vote
       FROM alert_posts p
       LEFT JOIN users u ON u.id = p.author_id
       LEFT JOIN alert_votes v ON v.post_id = p.id AND v.user_id = ?
      WHERE p.id = ?`,
    [viewerUserId || 0, postId],
  );
  return rows[0] || null;
}

/**
 * Cursor-paginated feed. Returns up to `limit` rows and a `nextCursor` for the next page.
 * Cursor is the last seen post id (exclusive). Returns newer-first (id DESC).
 */
async function getFeed(db, { limit = 20, cursor, symbol, authorId, timeframe, market, viewerUserId } = {}) {
  const conditions = ["p.status = 'active'"];
  const params     = [viewerUserId || 0]; // first placeholder is viewer for vote join

  if (symbol)    { conditions.push('p.symbol = ?');    params.push(symbol.toUpperCase()); }
  if (authorId)  { conditions.push('p.author_id = ?'); params.push(authorId); }
  if (timeframe) { conditions.push('p.timeframe = ?'); params.push(timeframe); }
  if (market)    { conditions.push('p.market = ?');    params.push(market); }
  if (cursor)    { conditions.push('p.id < ?');        params.push(cursor); }

  const cap = Math.min(limit, 50);
  params.push(cap + 1);

  const [rows] = await db.query(
    `SELECT p.*, u.username, u.avatar_url,
            v.vote_type AS _viewer_vote
       FROM alert_posts p
       LEFT JOIN users u ON u.id = p.author_id
       LEFT JOIN alert_votes v ON v.post_id = p.id AND v.user_id = ?
      WHERE ${conditions.join(' AND ')}
      ORDER BY p.id DESC
      LIMIT ?`,
    params,
  );

  const hasMore    = rows.length > cap;
  const items      = hasMore ? rows.slice(0, cap) : rows;
  const nextCursor = hasMore ? String(items[items.length - 1].id) : null;
  return { rows: items, nextCursor };
}

async function softDeletePost(db, id) {
  await db.query("UPDATE alert_posts SET status = 'deleted' WHERE id = ?", [id]);
}

async function getPostImageKey(db, id) {
  const [rows] = await db.query('SELECT image_key FROM alert_posts WHERE id = ?', [id]);
  return rows[0]?.image_key || null;
}

/** Fire-and-forget view counter — intentionally not awaited by callers. */
async function incrementViews(db, id) {
  await db.query('UPDATE alert_posts SET views_count = views_count + 1 WHERE id = ?', [id]);
}

module.exports = {
  createPost,
  getPostById,
  getPostWithViewerVote,
  getFeed,
  softDeletePost,
  getPostImageKey,
  incrementViews,
  toPostDTO,
};
