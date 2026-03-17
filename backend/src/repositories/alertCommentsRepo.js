'use strict';

function toCommentDTO(row) {
  if (!row) return null;
  return {
    id:        String(row.id),
    postId:    String(row.post_id),
    author:    { id: String(row.author_id), username: row.username || null, avatarUrl: row.avatar_url || null },
    text:      row.text,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Insert comment + atomically increment post.comments_count inside a transaction.
 * Returns the new comment id.
 */
async function createComment(db, { postId, authorId, text }) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.query(
      'INSERT INTO alert_comments (post_id, author_id, text) VALUES (?, ?, ?)',
      [postId, authorId, text],
    );
    await conn.query(
      "UPDATE alert_posts SET comments_count = comments_count + 1 WHERE id = ? AND status = 'active'",
      [postId],
    );
    await conn.commit();
    return result.insertId;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function getCommentById(db, id) {
  const [rows] = await db.query(
    `SELECT c.*, u.username, u.avatar_url
       FROM alert_comments c
       LEFT JOIN users u ON u.id = c.author_id
      WHERE c.id = ?`,
    [id],
  );
  return rows[0] || null;
}

/**
 * Cursor-paginated comment list for a post (ascending order, oldest first).
 * Cursor is the last seen comment id (exclusive, for "load more" upward paging).
 */
async function getComments(db, { postId, limit = 50, cursor } = {}) {
  const conditions = ["c.post_id = ?", "c.status = 'active'"];
  const params     = [postId];

  if (cursor) {
    conditions.push('c.id > ?');
    params.push(cursor);
  }

  const cap = Math.min(limit, 100);
  params.push(cap + 1);

  const [rows] = await db.query(
    `SELECT c.*, u.username, u.avatar_url
       FROM alert_comments c
       LEFT JOIN users u ON u.id = c.author_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY c.id ASC
      LIMIT ?`,
    params,
  );

  const hasMore    = rows.length > cap;
  const items      = hasMore ? rows.slice(0, cap) : rows;
  const nextCursor = hasMore ? String(items[items.length - 1].id) : null;
  return { rows: items, nextCursor };
}

/**
 * Soft-delete comment + atomically decrement post.comments_count.
 * Returns true if the comment was found and deleted.
 */
async function softDeleteComment(db, commentId, postId) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    const [result] = await conn.query(
      "UPDATE alert_comments SET status = 'deleted' WHERE id = ? AND status = 'active'",
      [commentId],
    );
    if (result.affectedRows > 0) {
      await conn.query(
        'UPDATE alert_posts SET comments_count = GREATEST(comments_count - 1, 0) WHERE id = ?',
        [postId],
      );
    }
    await conn.commit();
    return result.affectedRows > 0;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = { createComment, getCommentById, getComments, softDeleteComment, toCommentDTO };
