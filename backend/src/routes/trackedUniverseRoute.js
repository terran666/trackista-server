'use strict';

// ─── GET /api/tracked-universe ─────────────────────────────────────────────
// Returns the tracked symbol universe built by symbolsUniverseBuilder.
//
// Query params:
//   format=full|summary  (default: full)
// ──────────────────────────────────────────────────────────────────────────

function safeParse(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

/**
 * @param {import('ioredis').Redis} redis
 */
function createTrackedUniverseHandler(redis) {
  return async (req, res) => {
    const format = (req.query.format || 'full').toLowerCase();

    try {
      const [filteredRaw, metaRaw, futuresRaw, spotRaw] = await Promise.all([
        redis.get('tracked:universe:filtered'),
        redis.get('tracked:universe:meta'),
        redis.get('tracked:futures:symbols'),
        redis.get('tracked:spot:symbols'),
      ]);

      const filtered = safeParse(filteredRaw);
      const meta     = safeParse(metaRaw)     || {};
      const futures  = safeParse(futuresRaw);
      const spot     = safeParse(spotRaw);

      if (!filtered) {
        return res.json({
          success:   true,
          ready:     false,
          message:   'Universe not yet built — collector may still be starting up',
          futures:   [],
          spot:      [],
          symbols:   [],
          meta:      {},
          updatedAt: null,
        });
      }

      if (format === 'summary') {
        return res.json({
          success:        true,
          ready:          true,
          updatedAt:      filtered.updatedAt,
          futuresCount:   futures?.symbols?.length ?? 0,
          spotCount:      spot?.symbols?.length ?? 0,
          filteredCount:  filtered.count ?? filtered.symbols?.length ?? 0,
          filters:        filtered.filters ?? {},
          futuresSymbols: futures?.symbols ?? [],
          spotSymbols:    spot?.symbols    ?? [],
        });
      }

      // Full format includes per-symbol metadata
      const enrichedSymbols = (filtered.symbols || []).map(sym => {
        const m = meta[sym] || {};
        return {
          symbol:             sym,
          source:             m.source            ?? 'unknown',
          quoteVol24h:        m.quoteVol24h        ?? null,
          tradeCount24h:      m.tradeCount24h      ?? null,
          activityScore:      m.activityScore      ?? null,
          volumeUsdt60s:      m.volumeUsdt60s      ?? null,
          hasFutures:         m.hasFutures         ?? true,
          hasSpot:            m.hasSpot            ?? true,
          monitorFutures:     m.monitorFutures     ?? true,
          monitorSpot:        m.monitorSpot        ?? false,
          passesVolumeFilter: m.passesVolumeFilter ?? true,
          isForce:            m.isForce            ?? false,
          includedAt:         m.includedAt         ?? null,
          status:             'tracked',
        };
      });

      return res.json({
        success:   true,
        ready:     true,
        updatedAt: filtered.updatedAt,
        count:     enrichedSymbols.length,
        filters:   filtered.filters ?? {},
        symbols:   enrichedSymbols,
        futures: {
          count:   futures?.symbols?.length ?? 0,
          symbols: futures?.symbols         ?? [],
        },
        spot: {
          count:   spot?.symbols?.length ?? 0,
          symbols: spot?.symbols         ?? [],
        },
      });
    } catch (err) {
      console.error('[tracked-universe] error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  };
}

/**
 * GET /api/tracked-universe/summary — quick stats only
 */
function createTrackedUniverseSummaryHandler(redis) {
  return async (_req, res) => {
    try {
      const [filteredRaw, futuresRaw, spotRaw, futureDensityRaw] = await Promise.all([
        redis.get('tracked:universe:filtered'),
        redis.get('tracked:futures:symbols'),
        redis.get('tracked:spot:symbols'),
        redis.get('density:symbols:tracked:futures'),
      ]);

      const filtered      = safeParse(filteredRaw);
      const futures       = safeParse(futuresRaw);
      const spot          = safeParse(spotRaw);
      const futureDensity = safeParse(futureDensityRaw);

      return res.json({
        success:              true,
        ready:                !!filtered,
        universeUpdatedAt:    filtered?.updatedAt    ?? null,
        filteredCount:        filtered?.count        ?? 0,
        futuresTrackedCount:  futures?.symbols?.length  ?? 0,
        spotTrackedCount:     spot?.symbols?.length      ?? 0,
        densityFuturesCount:  futureDensity?.symbols?.length ?? 0,
        filters:              filtered?.filters      ?? {},
        futuresSymbols:       futures?.symbols        ?? [],
      });
    } catch (err) {
      console.error('[tracked-universe/summary] error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  };
}

module.exports = { createTrackedUniverseHandler, createTrackedUniverseSummaryHandler };
