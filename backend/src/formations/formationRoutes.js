'use strict';

/**
 * formationRoutes.js — REST surface for the Formations module.
 *
 *   GET /api/formations/scalping            — list active formations (filterable)
 *   GET /api/formations/debug/scalping      — per-symbol diagnostic
 *   GET /api/formations/debug/stats         — service stats
 *
 * The list endpoint deliberately does NOT use minScore/minProbability as a hard
 * filter — probability is for sorting/colour only.
 */

const express = require('express');
const {
  VISIBLE_STATUSES, STATUS_PRIORITY, FORMATION_STATUS,
} = require('./formationTypes');
const {
  normalizeTf,
  normalizeDirection,
  normalizePatternType,
  buildFormationsView,
} = require('./formationView');
const { buildFormationSourceAudit } = require('./sourceAudit');

function parseCsv(v) {
  if (!v) return null;
  return String(v).split(',').map(s => s.trim()).filter(Boolean);
}

function sortFormations(a, b) {
  if (b.probability !== a.probability) return b.probability - a.probability;     // probability DESC
  const pa = STATUS_PRIORITY[a.status] ?? 99;
  const pb = STATUS_PRIORITY[b.status] ?? 99;
  if (pa !== pb) return pa - pb;                                                 // status priority
  return (b.updatedAt || 0) - (a.updatedAt || 0);                               // updatedAt DESC
}

// Stable display order for the list endpoint: oldest first, so every card keeps
// its slot across ticks and freshly-detected formations are appended at the
// bottom (cards never jump as probability fluctuates). Tie-break on id so the
// order is fully deterministic.
function sortStable(a, b) {
  const ca = a.createdAt || 0;
  const cb = b.createdAt || 0;
  if (ca !== cb) return ca - cb;                                                 // createdAt ASC
  return String(a.id).localeCompare(String(b.id));                              // id tie-break
}

function createFormationRouter({ store }) {
  const router = express.Router();

  // GET /api/formations/scalping
  // Filters: strategy, tf, direction, market, pattern, uniqueSymbol, limit
  router.get('/', async (req, res) => {
    try {
      const tf = normalizeTf(req.query.tf || 'ALL');
      if (tf == null) {
        return res.status(400).json({ success: false, error: 'Invalid tf. Use ALL|1m|3m|5m|15m|30m|1h|4h|1d' });
      }
      const direction = normalizeDirection(req.query.direction || 'ALL');
      if (direction == null) {
        req.query.direction = 'ALL';
      }
      const pattern = normalizePatternType(req.query.pattern || req.query.patternType || 'ALL');
      if (pattern == null) {
        return res.status(400).json({ success: false, error: 'Invalid pattern. Use ALL|DOUBLE_TOP|DOUBLE_BOTTOM|SUPPORT_BREAKDOWN_SETUP|SUPPORT_BREAKDOWN|RESISTANCE_BREAKOUT_SETUP|RESISTANCE_BREAKOUT|SUPPORT_BOUNCE|RESISTANCE_REJECTION' });
      }

      const raw = await store.getActive();
      const view = buildFormationsView(raw, req.query);

      res.json({
        success:     true,
        strategy:    view.options.strategy,
        mode:        view.mode,
        count:       view.count,
        items:       view.items,
        data:        view.items,
        formations:  view.items,
        debug:       view.debug,
        generatedAt: Date.now(),
      });
    } catch (err) {
      console.error('[formations] list error:', err.message);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  return router;
}

function createFormationDebugRouter({ service, store }) {
  const router = express.Router();

  // GET /api/formations/debug?symbol=CUSDT&tf=15m&strategy=doubleExtreme
  router.get('/', async (req, res) => {
    try {
      const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase().trim() : null;
      if (!symbol) {
        return res.status(400).json({ success: false, error: 'symbol query param is required' });
      }

      const tf = req.query.tf ? String(req.query.tf).trim() : null;
      if (tf && normalizeTf(tf) == null) {
        return res.status(400).json({ success: false, error: 'Invalid tf. Use ALL|1m|3m|5m|15m|30m|1h|4h|1d' });
      }

      const strategy = String(req.query.strategy || 'doubleExtreme');
      if (strategy !== 'doubleExtreme' && strategy !== 'levelBased') {
        return res.status(400).json({ success: false, error: 'Only strategy=doubleExtreme or strategy=levelBased is currently supported' });
      }

      const [diag] = await service.diagnosePatterns([symbol], {
        tf: tf && tf !== 'ALL' ? tf : null,
      });

      if (!diag || (diag.totalExtremes ?? 0) === 0) {
        return res.json({
          success: true,
          symbol,
          tf: tf || 'ALL',
          extremes: {
            total: 0,
            priceNull: 0,
            priceValid: 0,
            filteredByStrengthTouches: 0,
            filteredByBarsDistance: 0,
            usedForPatterns: 0,
          },
          patterns: {
            doubleTop: { created: 0, rejected: 0, reasons: {} },
            doubleBottom: { created: 0, rejected: 0, reasons: {} },
          },
          debug: { byTf: {} },
        });
      }

      if (strategy === 'levelBased') {
        const lbSeq = Array.isArray(diag.debugByTf?._levelBased?.sequences)
          ? diag.debugByTf._levelBased.sequences
          : [];
        const lbSummary = lbSeq.find((x) => x && x.kind === 'summary') || {};
        const perTfRaw = lbSummary.perTf || {};
        const byTf = {};
        const tfOrder = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'];

        for (const key of tfOrder) {
          const item = perTfRaw[key] || {};
          byTf[key] = {
            tf: key,
            levelsFound: item.levelsFound ?? 0,
            extremesFound: item.extremesFound ?? 0,
            validLevels: item.validLevels ?? 0,
            validClusters: item.validClusters ?? 0,
            candidatesCreated: item.candidatesCreated ?? 0,
            rejectReasons: item.rejectReasons || {},
          };
        }

        const rejects = lbSeq
          .filter((x) => x && x.kind !== 'summary')
          .map((x) => ({
            tf: x.tf || null,
            rejectedReason: x.rejectReason || 'UNKNOWN',
            rejectStage: x.rejectStage || 'candidate_filter',
            sourceType: x.sourceType || 'level',
            candidateLevel: x.candidateLevel ?? x.price ?? null,
            candidateTf: x.candidateTf || x.tf || null,
            candidateSource: x.candidateSource || x.source || null,
            levelId: x.levelId || null,
            source: x.source || null,
            side: x.side || null,
            price: x.price ?? null,
          }));

        return res.json({
          success: true,
          symbol,
          tf: tf || 'ALL',
          strategy,
          levelBased: {
            totalLongCandidates: lbSummary.totalLongCandidates ?? 0,
            totalShortCandidates: lbSummary.totalShortCandidates ?? 0,
            longRejectedReasons: lbSummary.longRejectedReasons || {},
            shortRejectedReasons: lbSummary.shortRejectedReasons || {},
            warning: lbSummary.warning || null,
          },
          debug: {
            byTf,
            rejectLog: rejects,
          },
          candidatesFound: Array.isArray(diag.candidates) ? diag.candidates.length : 0,
          candidates: Array.isArray(diag.candidates) ? diag.candidates : [],
        });
      }

      const byTf = {};
      const dt = { created: 0, rejected: 0, reasons: {} };
      const db = { created: 0, rejected: 0, reasons: {} };
      let total = 0;
      let validPrice = 0;
      let rejectedPrice = 0;
      let rejectedQuality = 0;
      let filteredByBarsDistance = 0;
      let usedForPatterns = 0;

      const tfKeys = new Set([
        ...Object.keys(diag.debugByTf || {}),
        ...Object.keys(diag.statsByTf || {}),
      ]);

      for (const key of tfKeys) {
        const seq = diag.debugByTf?.[key]?.sequences || [];
        const stats = diag.statsByTf?.[key] || {};
        const item = {
          extremesTotal: stats.extremesTotal ?? 0,
          validPrice: stats.validPrice ?? 0,
          rejectedPrice: stats.rejectedPrice ?? 0,
          rejectedQuality: stats.rejectedQuality ?? 0,
          patternsCreated: stats.patternsCreated ?? 0,
          filteredByBarsDistance: stats.filteredByBarsDistance ?? 0,
        };
        byTf[key] = item;

        total += item.extremesTotal;
        validPrice += item.validPrice;
        rejectedPrice += item.rejectedPrice;
        rejectedQuality += item.rejectedQuality;
        filteredByBarsDistance += item.filteredByBarsDistance;
        usedForPatterns += Math.max(0, item.validPrice - item.rejectedQuality);

        for (const s of seq) {
          const target = s.patternType === 'DOUBLE_TOP' ? dt : db;
          if (s.accepted) {
            target.created++;
          } else {
            target.rejected++;
            if (s.rejectReason) {
              target.reasons[s.rejectReason] = (target.reasons[s.rejectReason] || 0) + 1;
            }
          }
        }
      }

      return res.json({
        success: true,
        symbol,
        tf: tf || 'ALL',
        extremes: {
          total,
          priceNull: rejectedPrice,
          priceValid: validPrice,
          filteredByStrengthTouches: rejectedQuality,
          filteredByBarsDistance,
          usedForPatterns,
        },
        patterns: {
          doubleTop: dt,
          doubleBottom: db,
        },
        debug: {
          byTf,
        },
      });
    } catch (err) {
      console.error('[formations] debug root error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // GET /api/formations/debug/scalping?limit=50
  //
  // Two modes:
  //   • ?symbols=BTCUSDT,...  → per-symbol diagnose (levels, signals, skips)
  //   • (no symbols)          → validation report over all active formations
  router.get('/scalping', async (req, res) => {
    try {
      const symbols = parseCsv(req.query.symbols);

      // ── Per-symbol diagnose mode ──────────────────────────────────────────
      if (symbols && symbols.length) {
        const upper = symbols.map(s => s.toUpperCase());
        const diagnostics = await service.diagnose(upper);
        return res.json({ success: true, diagnostics });
      }

      // ── Validation report mode ────────────────────────────────────────────
      const limit = Math.min(parseInt(req.query.limit || '50', 10) || 50, 1000);
      const stats = service.getStats();
      const all   = await store.getActive();

      // 6 / 7. Visible vs hidden — only DETECTED/APPROACHING/READY should show.
      const visible = all.filter(f => VISIBLE_STATUSES.has(f.status));
      const hidden  = all.filter(f => !VISIBLE_STATUSES.has(f.status));
      const statusBreakdown = {};
      for (const f of all) statusBreakdown[f.status] = (statusBreakdown[f.status] || 0) + 1;

      // 3. Top-N by probability.
      const top = visible.slice().sort(sortFormations).slice(0, Math.min(limit, 20));

      // 4. Duplicate levels — more than one formation on the same symbol+direction+level.
      const levelGroups = new Map();
      for (const f of visible) {
        const key = `${f.symbol}:${f.direction}:${f.level?.price}`;
        if (!levelGroups.has(key)) levelGroups.set(key, []);
        levelGroups.get(key).push(f.id);
      }
      const duplicateLevels = [...levelGroups.entries()]
        .filter(([, ids]) => ids.length > 1)
        .map(([key, ids]) => ({ key, count: ids.length, ids }));

      // 5. Too many formations per symbol — > maxPerDirection per side.
      const cap = service.getConfig ? service.getConfig().maxPerDirection : 3;
      const perSymbolDir = new Map();
      for (const f of visible) {
        const key = `${f.symbol}:${f.direction}`;
        perSymbolDir.set(key, (perSymbolDir.get(key) || 0) + 1);
      }
      const overLimitSymbols = [...perSymbolDir.entries()]
        .filter(([, n]) => n > cap)
        .map(([key, count]) => ({ key, count, cap }));

      // 8. reason[] presence — every formation must carry a non-empty reason array.
      const missingReason = visible
        .filter(f => !Array.isArray(f.reason) || f.reason.length === 0)
        .map(f => f.id);

      // 2. Created formations (per-symbol counts).
      const perSymbolCount = {};
      for (const f of visible) perSymbolCount[f.symbol] = (perSymbolCount[f.symbol] || 0) + 1;

      const checks = {
        lowLiquiditySkippedTotal: stats.skippedLowLiquidity,   // 1
        formationsCreatedTotal:   stats.created,               // 2
        formationsActiveVisible:  visible.length,              // 2
        topByProbability:         top.map(f => ({              // 3
          symbol: f.symbol, direction: f.direction, status: f.status,
          level: f.level?.price, distancePct: f.distancePct,
          probability: f.probability, levelStrength: f.levelStrength,
          confluenceScore: f.confluenceScore, confluenceStrategies: f.confluenceStrategies,
        })),
        duplicateLevels,                                       // 4
        duplicateLevelsOk:        duplicateLevels.length === 0,
        overLimitSymbols,                                      // 5
        perDirectionLimitOk:      overLimitSymbols.length === 0,
        hiddenLeakedToVisible:    hidden.filter(f => VISIBLE_STATUSES.has(f.status)).map(f => f.id), // 6
        onlyFutureStatusesShown:  visible.every(f => VISIBLE_STATUSES.has(f.status)),                // 6
        brokenStillActive:        all.filter(f =>                                                    // 7
          f.status === FORMATION_STATUS.COMPLETED ||
          f.status === FORMATION_STATUS.INVALIDATED ||
          f.status === FORMATION_STATUS.EXPIRED).map(f => f.id),
        brokenRemovedOk:          hidden.length === 0,
        missingReason,                                         // 8
        everyFormationHasReason:  missingReason.length === 0,
      };

      const allOk =
        checks.duplicateLevelsOk &&
        checks.perDirectionLimitOk &&
        checks.onlyFutureStatusesShown &&
        checks.brokenRemovedOk &&
        checks.everyFormationHasReason &&
        checks.hiddenLeakedToVisible.length === 0;

      res.json({
        success: true,
        validation: {
          allOk,
          totals: {
            active: all.length,
            visible: visible.length,
            hidden: hidden.length,
          },
          statusBreakdown,
          perSymbolCount,
          checks,
          stats,
        },
      });
    } catch (err) {
      console.error('[formations] debug error:', err.message);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // GET /api/formations/debug/stats
  router.get('/stats', async (_req, res) => {
    res.json({ success: true, stats: service.getStats() });
  });

  // GET /api/formations/debug/patterns
  // ?symbol=WLDUSDT&tf=1h&marketType=futures
  //
  // Shows what the pattern engine sees for a symbol:
  //   - extremes loaded + breakdown by tf
  //   - which High-Low-High / Low-High-Low sequences were checked
  //   - which patterns were accepted / rejected and why
  router.get('/patterns', async (req, res) => {
    try {
      const rawSymbols = parseCsv(req.query.symbols || req.query.symbol);
      if (!rawSymbols || !rawSymbols.length) {
        return res.status(400).json({ success: false, error: 'symbols (or symbol) query param is required' });
      }
      const symbols    = rawSymbols.map(s => s.toUpperCase());
      const tf         = req.query.tf         ? String(req.query.tf).trim()         : null;
      const marketType = req.query.marketType ? String(req.query.marketType).trim() : null;

      if (!service.diagnosePatterns) {
        return res.status(501).json({ success: false, error: 'Pattern engine is not enabled' });
      }

      const diagnostics = await service.diagnosePatterns(symbols, { tf, marketType });
      return res.json({ success: true, diagnostics, generatedAt: Date.now() });
    } catch (err) {
      console.error('[formations] debug/patterns error:', err.message);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // GET /api/formations/debug/page            — why is /formations empty?
  // GET /api/formations/debug/page?symbol=X   — per-symbol drill-down
  router.get('/page', async (req, res) => {
    try {
      const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase() : null;
      if (symbol) {
        return res.json(await buildPageSymbolReport(service, store, symbol));
      }
      return res.json(await buildPageReport(service, store));
    } catch (err) {
      console.error('[formations] debug/page error:', err.message);
      res.status(500).json({ ok: false, error: 'Internal server error' });
    }
  });

  // GET /api/formations/debug/source?symbol=BTCUSDT&tf=5m&marketType=futures
  // Stage 1: returns extreme-based source diagnostics (TZ §16 debug format).
  // Falls back to the legacy audit if diagnoseExtremes is not available.
  router.get('/source', async (req, res) => {
    try {
      const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase().trim() : null;
      if (!symbol) {
        return res.status(400).json({ success: false, error: 'symbol query param is required' });
      }

      const tf = req.query.tf ? String(req.query.tf).trim() : null;
      if (tf && normalizeTf(tf) == null) {
        return res.status(400).json({ success: false, error: 'Invalid tf. Use ALL|1m|3m|5m|15m|30m|1h|4h' });
      }

      const marketType = req.query.marketType ? String(req.query.marketType).trim() : 'futures';

      // Stage 1: use extremes-based diagnostics
      if (service.diagnoseExtremes) {
        const [diag] = await service.diagnoseExtremes([symbol], { tf: tf || null, marketType });
        return res.json({
          success: true,
          symbol,
          tf: tf || 'ALL',
          marketType,
          liquidity:   diag.liquidity,
          extremes:    diag.extremes,
          candidates:  diag.candidates,
          rejected:    diag.rejected,
          rejectBreakdown: diag.rejectBreakdown,
          generatedAt: Date.now(),
        });
      }

      // Legacy fallback
      const audit = await buildFormationSourceAudit(service, { symbol, tf, marketType });
      return res.json({
        success: true,
        symbol: audit.symbol,
        tf: audit.tf,
        marketType: audit.marketType,
        sourceDebug: audit.sourceDebug,
        testPageLevels: audit.testPageLevels,
        testPageExtremes: audit.testPageExtremes,
        candlesByTf: audit.candlesByTf,
        candlesReadinessByTf: audit.candlesReadinessByTf,
        levelsFoundByTf: audit.levelsFoundByTf,
        extremesFoundByTf: audit.extremesFoundByTf,
        validLevelsByTf: audit.validLevelsByTf,
        candidatesByTf: audit.candidatesByTf,
        rejectedByTf: audit.rejectedByTf,
        counts: audit.counts,
        quality: audit.quality,
        mismatches: audit.mismatches,
        decisionTrace: audit.decisionTrace,
        rootCauseByLevel: audit.rootCauseByLevel,
        generatedAt: audit.generatedAt,
      });
    } catch (err) {
      console.error('[formations] debug/source error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // GET /api/formations/debug/tf?symbol=BTCUSDT
  // Stage 1: per-timeframe extreme diagnostics.
  router.get('/tf', async (req, res) => {
    try {
      const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase().trim() : null;
      if (!symbol) {
        return res.status(400).json({ success: false, error: 'symbol query param is required' });
      }

      const tfOrder = ['1m', '5m', '15m', '30m', '1h', '4h'];

      // Stage 1: use extreme diagnostics per TF
      if (service.diagnoseExtremes) {
        const byTf = {};
        // Run per-tf diagnoses in parallel
        const results = await Promise.all(
          tfOrder.map(tf => service.diagnoseExtremes([symbol], { tf }).then(r => ({ tf, diag: r[0] || {} }))),
        );
        for (const { tf, diag } of results) {
          byTf[tf] = {
            extremes:   diag.extremes?.loaded  ?? 0,
            valid:      diag.extremes?.valid   ?? 0,
            rejected:   diag.extremes?.rejected ?? 0,
            candidates: diag.candidates?.length ?? 0,
            rejectBreakdown: diag.rejectBreakdown || {},
          };
        }
        return res.json({ success: true, symbol, byTf, generatedAt: Date.now() });
      }

      // Legacy fallback
      const [diag] = await service.diagnosePatterns([symbol], {});
      const byTf = {};
      const lbSeq = Array.isArray(diag?.debugByTf?._levelBased?.sequences)
        ? diag.debugByTf._levelBased.sequences
        : [];
      const lbSummary = lbSeq.find((x) => x && x.kind === 'summary') || {};
      const perTf = lbSummary.perTf || {};

      for (const tf of tfOrder) {
        const item = perTf[tf] || {};
        const rejectedMap = item.rejectReasons || {};
        byTf[tf] = {
          levels: item.levelsFound ?? 0,
          extremes: item.extremesFound ?? 0,
          candles: (diag?.candlesByTf?.[tf] ?? 0),
          candidates: item.candidatesCreated ?? 0,
          rejected: Object.keys(rejectedMap),
          rejectedByReason: rejectedMap,
        };
      }

      return res.json({ success: true, symbol, byTf });
    } catch (err) {
      console.error('[formations] debug/tf error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // GET /api/formations/debug/lifecycle?symbol=BTCUSDT&tf=15m
  router.get('/lifecycle', async (req, res) => {
    try {
      if (!service.getLifecycleDebug) {
        return res.status(501).json({ success: false, error: 'Lifecycle debug is not available' });
      }
      const symbol = req.query.symbol ? String(req.query.symbol).toUpperCase().trim() : null;
      const tf = req.query.tf ? String(req.query.tf).trim() : null;
      const payload = await service.getLifecycleDebug(symbol, tf);
      return res.json({ success: true, ...payload });
    } catch (err) {
      console.error('[formations] debug/lifecycle error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // GET /api/formations/debug/extremes
  // Summary of the most recent tick's extreme-formations pass.
  // Shows: trackedExtremes, candidatesCreated, accepted, rejected, rejectReasons,
  //        byTf (extremes/candidates/rejected/accepted per TF), sources, filter config.
  router.get('/extremes', async (req, res) => {
    try {
      const stats  = service.getExtremeStats ? service.getExtremeStats() : null;
      const config = service.getConfig ? service.getConfig() : {};
      const efCfg  = config.extremeFormations || {};

      const all          = await store.getActive();
      const extremeBased = all.filter(f => f.strategy === 'extremeBased');
      const byStatus     = {};
      const storeByTf    = {};
      const storeBySource = {};
      for (const f of extremeBased) {
        byStatus[f.status || 'UNKNOWN']            = (byStatus[f.status || 'UNKNOWN']            || 0) + 1;
        storeByTf[f.tf || 'unknown']               = (storeByTf[f.tf || 'unknown']               || 0) + 1;
        const src = String(f.extremeSource || 'unknown').toLowerCase();
        storeBySource[src]                         = (storeBySource[src]                         || 0) + 1;
      }
      const invalidPrice        = extremeBased.filter(f => !(Number(f.extremePrice) > 0)).length;
      const missingId           = extremeBased.filter(f => f.extremeId == null).length;
      const missingExtremeId    = extremeBased.filter(f => f.extremeId == null).length;
      const missingExtremePrice = extremeBased.filter(f => !(Number(f.extremePrice) > 0)).length;
      const missingExtremeType  = extremeBased.filter(f => !f.extremeType).length;
      // These are WARNINGS only — missing time/barIndex does not invalidate a formation
      const missingExtremeTime     = extremeBased.filter(f => f.extremeTime == null).length;
      const missingExtremeBarIndex = extremeBased.filter(f => f.extremeBarIndex == null).length;

      // Counters by source (Stage 1: extremes only)
      const formationsFromExtremes         = extremeBased.filter(f => f.extremeSource === 'extremes').length;
      const formationsFromVerticalExtremes = extremeBased.filter(f => f.extremeSource === 'vertical-extremes').length;
      const formationsFromSharpExtremes    = extremeBased.filter(f => f.extremeSource === 'sharp-extremes').length;

      // Orphaned: extremeId is set but the extreme no longer exists in trackedExtremesStore.
      // Useful for detecting stale formations that haven't been cleaned up by lifecycle yet.
      let orphaned = 0;
      try {
        const trackedExtremesStore = require('../services/trackedExtremesStore');
        const allExtremes = trackedExtremesStore.getAll({ marketType: config.marketType || 'futures' }) || [];
        const knownIds = new Set(allExtremes.map(e => String(e.id)));
        orphaned = extremeBased.filter(f => f.extremeId != null && !knownIds.has(String(f.extremeId))).length;
      } catch (_) { /* non-fatal */ }

      return res.json({
        success: true,
        lastTickStats: stats
          ? {
              ts:                    stats.ts,
              trackedExtremes:       stats.trackedExtremes,
              candidatesCreated:     stats.candidatesCreated,
              accepted:              stats.accepted,
              rejected:              stats.rejected,
              rejectReasons:         {
                ...(stats.rejectReasons || {}),
                // Liquidity filter failed (symbols skipped before extreme pass)
                ...(stats.liquidityFilterFailed != null
                  ? { LIQUIDITY_FILTER_FAILED: stats.liquidityFilterFailed }
                  : {}),
              },
              priceTooFarDistribution: stats.priceTooFarBuckets,
              byTf:                  stats.byTf,
              acceptedByTf:          stats.acceptedByTf,
              acceptedBySource:      stats.acceptedBySource,
              sources:               stats.sources,
              // Lifecycle removals (last tick)
              brokenLastTick:        stats.brokenLastTick    ?? 0,
              orphanedLastTick:      stats.orphanedLastTick  ?? 0,
              liquidityFilterFailed: stats.liquidityFilterFailed ?? 0,
            }
          : null,
        store: {
          // Core counters
          active:            extremeBased.length,   // formations from extremes engine
          totalActive:       all.length,
          extremeBasedCount: extremeBased.length,
          broken:            stats?.brokenLastTick  ?? 0,   // removed last tick as broken
          orphaned,                                          // extremeId not in tracked-extremes
          // Source breakdown (Stage 1: all should be extreme sources)
          formationsFromExtremes,
          formationsFromVerticalExtremes,
          formationsFromSharpExtremes,
          // Field completeness (invalid = hard block; missing* = warning only)
          invalidPriceCount:     invalidPrice,
          missingIdCount:        missingId,
          missingExtremeId,      // HARD reject if > 0
          missingExtremePrice,   // HARD reject if > 0
          missingExtremeType,    // HARD reject if > 0
          missingExtremeTime,        // WARNING only — does not block formation
          missingExtremeBarIndex,    // WARNING only — does not block formation
          fieldWarnings: {
            missingExtremeId,
            missingExtremePrice,
            missingExtremeType,
            missingExtremeTime,
            missingExtremeBarIndex,
          },
          byStatus,
          byTf:    storeByTf,
          bySource: storeBySource,
          active: extremeBased.slice(0, 50).map(f => {
            const ep = Number(f.extremePrice);
            const cp = Number(f.currentPrice);
            const bt = Number(efCfg.breakThresholdPct || 0.2);
            const rawType = String(f.extremeType || '').toUpperCase();
            const extType = (rawType === 'HIGH' || rawType === 'RESISTANCE') ? 'HIGH'
              : (rawType === 'LOW' || rawType === 'SUPPORT') ? 'LOW' : rawType;
            let isBroken = false;
            if (ep > 0 && cp > 0) {
              if (extType === 'LOW')  isBroken = cp < ep * (1 - bt / 100);
              if (extType === 'HIGH') isBroken = cp > ep * (1 + bt / 100);
            }
            return {
              id:              f.id,
              symbol:          f.symbol,
              tf:              f.tf,
              patternType:     f.patternType,
              direction:       f.direction,
              extremeId:       f.extremeId     ?? null,
              extremeSource:   f.extremeSource ?? null,
              extremeTf:       f.extremeTf     ?? null,
              extremeType:     extType         || null,
              extremePrice:    ep              || null,
              extremeTime:     f.extremeTime   ?? null,
              extremeBarIndex: f.extremeBarIndex ?? null,
              currentPrice:    cp              || null,
              distancePct:     f.distancePct   ?? null,
              score:           f.score         ?? null,
              visibleOnTestPage: f.visibleOnTestPage ?? null,
              isBroken,
              status:          f.status,
              updatedAt:       f.updatedAt,
            };
          }),
        },
        config: {
          extremeFormationsEnabled: config.extremeFormationsEnabled !== false,
          legacyEngineEnabled:      config.legacyEngineEnabled     ?? false,
          patternEngineEnabled:     config.patternEngineEnabled     ?? false,
          allowedSources:           ['extremes', 'vertical-extremes', 'sharp-extremes', 'tracked-extremes'],
          allowedTfs:               efCfg.allowedTfs               ?? ['1m', '5m', '15m', '30m', '1h', '4h'],
          setupDistancePct:         efCfg.setupDistancePct         ?? null,
          breakThresholdPct:        efCfg.breakThresholdPct        ?? null,
          maxActiveDistancePct:     efCfg.maxActiveDistancePct     ?? null,
          maxSymbols:               efCfg.maxSymbols               ?? null,
          maxFormations:            efCfg.maxFormations            ?? null,
          maxPatternAgeHours:       efCfg.maxPatternAgeHours       ?? null,
          liquidityFilter: {
            minVolume24hUsd: config.formationLiquidityFilter?.minVolume24hUsd ?? config.minVolume24h ?? 70_000_000,
            minTrades24h:    config.formationLiquidityFilter?.minTrades24h    ?? config.minTrades24h ?? 900_000,
            mode:            config.formationLiquidityFilter?.mode            ?? 'OR',
            enabled:         config.formationLiquidityFilter?.enabled         ?? true,
          },
        },
        generatedAt: Date.now(),
      });
    } catch (err) {
      console.error('[formations] debug/extremes error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // GET /api/formations/debug/rejects
  // Last 100 rejected extreme candidates (rolling ring buffer, newest first).
  // Useful for understanding what is blocking formation creation.
  router.get('/rejects', (req, res) => {
    try {
      const log = service.getRejectLog ? service.getRejectLog() : [];
      const rejectReasons = {};
      for (const r of log) rejectReasons[r.rejectReason] = (rejectReasons[r.rejectReason] || 0) + 1;
      return res.json({
        success:       true,
        count:         log.length,
        rejectReasons,
        rejects:       log,
        generatedAt:   Date.now(),
      });
    } catch (err) {
      console.error('[formations] debug/rejects error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // GET /api/formations/debug/store
  // Shows the current state of the Redis formation store.
  // Compares active-set count, by-strategy breakdown, and validates
  // extremePrice on all extreme-based items so you can tell if Redis has
  // formations but the view filter is hiding them (count=0 on the page).
  router.get('/store', async (req, res) => {
    try {
      const all = await store.getActive();
      const byStrategy  = {};
      const byStatus    = {};
      const bySymbolCnt = {};
      for (const f of all) {
        byStrategy[f.strategy  || 'unknown'] = (byStrategy[f.strategy   || 'unknown'] || 0) + 1;
        byStatus[f.status      || 'unknown'] = (byStatus[f.status       || 'unknown'] || 0) + 1;
        bySymbolCnt[f.symbol]                = (bySymbolCnt[f.symbol]                 || 0) + 1;
      }

      const extremeBased    = all.filter(f => f.strategy === 'extremeBased');
      const invalidPrice    = extremeBased.filter(f => !(Number(f.extremePrice) > 0));
      const missingStatus   = all.filter(f => !f.status);
      const sampleExtremes  = extremeBased.slice(0, 5).map(f => ({
        id:           f.id,
        symbol:       f.symbol,
        tf:           f.tf,
        patternType:  f.patternType,
        extremePrice: f.extremePrice,
        status:       f.status,
        updatedAt:    f.updatedAt,
      }));

      return res.json({
        success:           true,
        active:            all.length,
        extremeBased:      extremeBased.length,
        invalidPriceCount: invalidPrice.length,
        invalidPriceSample: invalidPrice.slice(0, 5).map(f => ({ id: f.id, symbol: f.symbol, extremePrice: f.extremePrice })),
        missingStatusCount: missingStatus.length,
        byStrategy,
        byStatus,
        symbolCount:       Object.keys(bySymbolCnt).length,
        sampleExtremes,
        generatedAt:       Date.now(),
      });
    } catch (err) {
      console.error('[formations] debug/store error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  return router;
}

// ─── /debug/page — global health report ─────────────────────────────────────

async function buildPageReport(service, store) {
  const stats = service.getStats();
  const now   = Date.now();
  const all   = await store.getActive();

  const visible = all.filter(f => VISIBLE_STATUSES.has(f.status));
  const hidden  = all.filter(f => !VISIBLE_STATUSES.has(f.status));

  const byStatus = {};
  for (const f of all) byStatus[f.status] = (byStatus[f.status] || 0) + 1;

  const tickAgeMs = stats.lastTickAt ? (now - new Date(stats.lastTickAt).getTime()) : null;

  const topItems = visible.slice().sort(sortFormations).slice(0, 10).map(f => ({
    symbol:      f.symbol,
    direction:   f.direction,
    status:      f.status,
    probability: f.probability,
    levelPrice:  f.level?.price,
    distancePct: f.distancePct,
    reasonCount: Array.isArray(f.reason) ? f.reason.length : 0,
  }));

  // ── Mandatory checks → problems[] ─────────────────────────────────────────
  const problems = [];
  if (!stats.started)                                problems.push('service_not_running');
  if (!stats.lastTickAt)                             problems.push('last_tick_too_old');
  else if (tickAgeMs != null && tickAgeMs >= 5000)   problems.push('last_tick_too_old');
  if (stats.eligibleSymbols <= 0)                    problems.push('no_eligible_symbols');
  if (stats.symbolsScanned > 0 && stats.eligibleSymbols === 0) problems.push('all_symbols_low_liquidity');
  if (all.length === 0)                              problems.push('store_empty');
  if (visible.length === 0)                          problems.push('no_visible_formations');

  const missingReason = visible.filter(f =>
    !f.id || !f.symbol || !f.direction || !f.status ||
    f.probability == null || f.level?.price == null || f.distancePct == null ||
    !Array.isArray(f.reason) || f.reason.length === 0);
  if (missingReason.length > 0)                      problems.push('formations_missing_reason');

  const brokenVisible = visible.filter(f =>
    f.status === FORMATION_STATUS.COMPLETED ||
    f.status === FORMATION_STATUS.INVALIDATED ||
    f.status === FORMATION_STATUS.EXPIRED);
  if (brokenVisible.length > 0)                      problems.push('broken_levels_still_visible');

  return {
    ok: problems.length === 0,
    service: {
      running:             stats.started,
      lastTickAt:          stats.lastTickAt,
      tickAgeMs,
      symbolsScanned:      stats.symbolsScanned,
      lowLiquiditySkipped: stats.lowLiquiditySkipped,
      eligibleSymbols:     stats.eligibleSymbols,
    },
    store: {
      total:   all.length,
      visible: visible.length,
      hidden:  hidden.length,
      byStatus,
    },
    api: {
      endpoint:        '/api/formations/scalping',
      wouldReturn:     visible.length,
      visibleStatuses: [...VISIBLE_STATUSES],
      minScoreUsed:    false,
    },
    topItems,
    problems,
  };
}

// ─── /debug/page?symbol=X — per-symbol drill-down ────────────────────────────

async function buildPageSymbolReport(service, store, symbol) {
  const [diag] = await service.diagnose([symbol]);
  const forSymbol = await store.getBySymbol(symbol);
  const visibleForSymbol = forSymbol.filter(f => VISIBLE_STATUSES.has(f.status));

  // Liquidity
  const liquidity = diag && 'trades24h' in diag
    ? {
        trades24h: diag.trades24h ?? 0,
        volume24h: diag.volume24h ?? 0,
        passed:    diag.skipped !== 'low_liquidity',
      }
    : { trades24h: 0, volume24h: 0, passed: false };

  // Levels
  const levels = diag && diag.levelsFound != null
    ? {
        found:            diag.levelsFound,
        resistancesAbove: Array.isArray(diag.resistancesAbove) ? diag.resistancesAbove.length : 0,
        supportsBelow:    Array.isArray(diag.supportsBelow) ? diag.supportsBelow.length : 0,
      }
    : { found: 0, resistancesAbove: 0, supportsBelow: 0 };

  // Per-strategy breakdown from diag.levels[]
  const strategies = {};
  const checkedSet = new Set(diag?.strategiesChecked || []);
  for (const key of checkedSet) {
    strategies[key] = { checked: true, created: 0, skippedReasons: {} };
  }
  for (const l of (diag?.levels || [])) {
    const key = l.strategy;
    if (!key) continue;
    if (!strategies[key]) strategies[key] = { checked: true, created: 0, skippedReasons: {} };
    if (l.created) strategies[key].created++;
    else if (l.skipReason) {
      strategies[key].skippedReasons[l.skipReason] =
        (strategies[key].skippedReasons[l.skipReason] || 0) + 1;
    }
  }

  return {
    symbol,
    liquidity,
    levels,
    strategies,
    skipped: diag?.skipped ?? null,
    store: {
      formationsForSymbol: forSymbol.length,
      visibleForSymbol:    visibleForSymbol.length,
    },
  };
}

module.exports = { createFormationRouter, createFormationDebugRouter };
