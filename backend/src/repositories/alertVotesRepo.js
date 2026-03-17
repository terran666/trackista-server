'use strict';

/**
 * Upsert / toggle / remove a vote for a post inside a single transaction.
 *
 * Behaviour:
 *   - vote === null  → remove any existing vote
 *   - vote === same  → toggle off (remove)
 *   - vote different → update to new type
 *   - no existing    → insert
 *
 * After the operation the likes_count / dislikes_count are re-synced from
 * alert_votes (source of truth) to avoid counter drift from concurrent writes.
 *
 * Returns { likesCount, dislikesCount, vote } or null if the post was not found.
 */
async function processVote(db, { postId, userId, vote }) {
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();

    // Lock post row to prevent concurrent counter updates
    const [[post]] = await conn.query(
      "SELECT id FROM alert_posts WHERE id = ? AND status = 'active' FOR UPDATE",
      [postId],
    );
    if (!post) {
      await conn.rollback();
      return null;
    }

    // Current user vote
    const [[existing]] = await conn.query(
      'SELECT vote_type FROM alert_votes WHERE post_id = ? AND user_id = ?',
      [postId, userId],
    );
    let currentVote = existing ? existing.vote_type : null;

    if (vote === null) {
      // Explicit remove
      if (currentVote) {
        await conn.query('DELETE FROM alert_votes WHERE post_id = ? AND user_id = ?', [postId, userId]);
        currentVote = null;
      }
    } else if (!currentVote) {
      // No prior vote — insert
      await conn.query(
        'INSERT INTO alert_votes (post_id, user_id, vote_type) VALUES (?, ?, ?)',
        [postId, userId, vote],
      );
      currentVote = vote;
    } else if (currentVote === vote) {
      // Same vote again — toggle off
      await conn.query('DELETE FROM alert_votes WHERE post_id = ? AND user_id = ?', [postId, userId]);
      currentVote = null;
    } else {
      // Different vote type — update
      await conn.query(
        'UPDATE alert_votes SET vote_type = ? WHERE post_id = ? AND user_id = ?',
        [vote, postId, userId],
      );
      currentVote = vote;
    }

    // Re-sync counters from source of truth
    const [[counts]] = await conn.query(
      `SELECT
         SUM(vote_type = 'like')    AS likes,
         SUM(vote_type = 'dislike') AS dislikes
       FROM alert_votes WHERE post_id = ?`,
      [postId],
    );
    const likes    = parseInt(counts.likes    || 0, 10);
    const dislikes = parseInt(counts.dislikes || 0, 10);
    await conn.query(
      'UPDATE alert_posts SET likes_count = ?, dislikes_count = ? WHERE id = ?',
      [likes, dislikes, postId],
    );

    await conn.commit();
    return { likesCount: likes, dislikesCount: dislikes, vote: currentVote };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function getUserVote(db, postId, userId) {
  const [[row]] = await db.query(
    'SELECT vote_type FROM alert_votes WHERE post_id = ? AND user_id = ?',
    [postId, userId],
  );
  return row ? row.vote_type : null;
}

module.exports = { processVote, getUserVote };
