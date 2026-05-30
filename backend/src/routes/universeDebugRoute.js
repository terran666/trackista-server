'use strict';

/**
 * GET /api/density/universe-debug
 *
 * Returns the current density universe split into:
 *   included — symbols that passed all filters (from density:symbols:ranked)
 *   excluded — symbols that were filtered out (from density:universe:excluded)
 *              written by the collector; may be absent if collector hasn't run yet.
 *
 * Each excluded entry carries:
 *   { symbol, reason, volatility1hPct, volatility4hPct, volatility24hPct, updatedAt }
 * Reasons: STABLE_BLACKLIST | LOW_VOLATILITY
 */
function createUniverseDebugHandler(redis) {
  return async (req, res) => {
    try {
      const [rankedRaw, excludedRaw] = await Promise.all([
        redis.get('density:symbols:ranked'),
        redis.get('density:universe:excluded'),
      ]);

      const ranked   = rankedRaw   ? JSON.parse(rankedRaw)   : null;
      const excluded = excludedRaw ? JSON.parse(excludedRaw) : null;

      return res.json({
        updatedAt:       ranked?.updatedAt  ?? null,
        includedCount:   ranked?.symbols?.length ?? 0,
        excludedCount:   excluded?.excluded?.length ?? 0,
        included:        ranked?.symbols    ?? [],
        excluded:        excluded?.excluded ?? [],
      });
    } catch (err) {
      console.error('[universeDebugRoute] error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  };
}

module.exports = { createUniverseDebugHandler };
