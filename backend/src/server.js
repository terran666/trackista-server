'use strict';

const express = require('express');
const Redis   = require('ioredis');
const mysql   = require('mysql2/promise');

const { createLevelsService }         = require('./levelsService');
const { levelsHandler }               = require('./routes/levelsEngineRoute');
const { autoLevelsHandler }           = require('./routes/autoLevelsRoute');
const { createHandler: manualLevelsCreate, listHandler: manualLevelsList, deleteHandler: manualLevelsDelete, patchHandler: manualLevelsPatchFactory } = require('./routes/manualLevelsRoute');
const { getById: manualLevelsGetById, patch: manualLevelsPatch } = require('./services/manualLevelsStore');
const { bulkHandler: trackedLevelsBulk, listHandler: trackedLevelsList, deleteOneHandler: trackedLevelsDeleteOne, deleteManyHandler: trackedLevelsDeleteMany, patchOneHandler: trackedLevelsPatchOne, patchManyHandler: trackedLevelsPatchMany } = require('./routes/trackedLevelsRoute');
const { bulkHandler: trackedExtremesBulk, listHandler: trackedExtremesList, deleteOneHandler: trackedExtremesDeleteOne, deleteManyHandler: trackedExtremesDeleteMany, patchOneHandler: trackedExtremesPatchOne, patchManyHandler: trackedExtremesPatchMany } = require('./routes/trackedExtremesRoute');
const { createHandler: extremesRaysCreate, patchHandler: extremesRaysPatch, deleteHandler: extremesRaysDelete, listHandler: extremesRaysList } = require('./routes/extremesRaysRoute');
const { bulkHandler: trackedRaysBulk, listHandler: trackedRaysList, deleteOneHandler: trackedRaysDeleteOne, deleteManyHandler: trackedRaysDeleteMany, patchOneHandler: trackedRaysPatchOne, patchManyHandler: trackedRaysPatchMany, lineValueHandler: trackedRaysLineValue } = require('./routes/trackedRaysRoute');
const { bulkHandler: savedRaysBulk, listHandler: savedRaysList, deleteOneHandler: savedRaysDeleteOne, deleteManyHandler: savedRaysDeleteMany, patchOneHandler: savedRaysPatchOne, patchManyHandler: savedRaysPatchMany, watchPatchHandler: savedRaysWatchPatch, watchGetHandler: savedRaysWatchGet, watchStateHandler: savedRaysWatchState } = require('./routes/savedRaysRoute');
const { createHandler: manualSlopedCreate, listHandler: manualSlopedList, deleteHandler: manualSlopedDelete, patchHandler: manualSlopedPatch, lineValueHandler: manualSlopedLineValue } = require('./routes/manualSlopedLevelsRoute');
const { createLevelMonitorService }  = require('./services/levelMonitorService');
const { createAlertEngineService }   = require('./services/alertEngineService');
const { createMarketImpulseService } = require('./services/marketImpulseService');
const { createTelegramService }      = require('./services/telegramService');
const { createAlertDeliveryService } = require('./services/alertDeliveryService');
const { createOrderbookHandler }      = require('./routes/orderbookRoute');
const { createOrderbookDebugHandler } = require('./routes/orderbookDebugRoute');
const { createWallsHandler }          = require('./routes/wallsRoute');
const { createWallsBatchHandler }      = require('./routes/wallsBatchRoute');
const { createDensityViewHandler }      = require('./routes/densityViewRoute');
const { createDensitySummaryHandler }   = require('./routes/densitySummaryRoute');
const { createWallWatchlistHandler }        = require('./routes/wallWatchlistRoute');
const { createDensityTrackedSymbolsHandler } = require('./routes/densityTrackedSymbolsRoute');
const { createBinanceRateLimitStateHandler }  = require('./routes/binanceRateLimitStateRoute');
const { createFuturesObStateHandler }          = require('./routes/futuresObStateRoute');
const { createFuturesWallsDebugHandler }        = require('./routes/futuresWallsDebugRoute');
const { createTrackedUniverseHandler, createTrackedUniverseSummaryHandler } = require('./routes/trackedUniverseRoute');
const { createBinanceProxyRouter }             = require('./routes/binanceProxyRoute');
const { attachBinanceWsProxy, getWsProxyStats } = require('./routes/binanceWsProxy');
const dynamicTrackedSymbolsManager           = require('./services/density/dynamicTrackedSymbolsManager');
const { runMigrations }             = require('./services/alertMigrations');
const { runMoveMigrations }         = require('./services/moveMigrations');
const { ensureBucket }              = require('./services/alertStorageService');
const { createAuthRouter }          = require('./routes/authRoutes');
const { createPostsRouter }         = require('./routes/postsRoutes');
const { createMoveDetectionService }    = require('./services/moveDetectionService');
const { createPreEventService }         = require('./services/preEventService');
const { createDerivativesContextService } = require('./services/derivativesContextService');
const { createRankingService }          = require('./services/rankingService');
const { createOutcomeTrackingService }  = require('./services/outcomeTrackingService');
const { createRuntimeQaService }        = require('./services/runtimeQaService');
const { createRuntimeQaRouter }         = require('./routes/runtimeQaRoute');
const { runBarAggregatorMigrations }    = require('./services/barAggregatorMigrations');
const { createBarAggregatorService }    = require('./services/barAggregatorService');
const { createBarsRouter }              = require('./routes/barsRoute');
const { runMoveMigrations2 }            = require('./services/movePhase2Migrations');
const { createMovesRouter }             = require('./routes/movesRoute');
const { createPreSignalsRouter }        = require('./routes/preSignalsRoute');
const { createScreenerMovesRouter }     = require('./routes/screenerMovesRoute');
const { createKlineStatsRouter }        = require('./routes/klineStatsRoute');
const { createFundingRouter }           = require('./routes/fundingRoute');
const { createCorrelationRouter }       = require('./routes/correlationRoute');
const { createCorrelationService }      = require('./services/correlationService');
const { createSymbolDataRouter }        = require('./routes/symbolDataRoute');
const { createTestTestRouter }          = require('./routes/testtestRoute');
const { runWatchLevelsMigrations }      = require('./services/watchLevelsMigrations');
const { createLevelWatchEngine }        = require('./services/levelWatchEngine');
const { createLevelWatchRouter }        = require('./routes/levelWatchRoute');
const { createLevelEventsRouter }       = require('./routes/levelEventsRoute');
const { createAlertSoundsRouter }       = require('./routes/alertSoundsRoute');
const { SyntheticPlaybackService }      = require('./services/syntheticPlaybackService');
const { createSynthRouter }             = require('./routes/synthRoute');

// ─── Configuration ───────────────────────────────────────────────
const PORT       = parseInt(process.env.API_PORT  || '3000', 10);
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
const MYSQL_HOST = process.env.DB_HOST     || process.env.MYSQL_HOST || 'localhost';
const MYSQL_PORT = parseInt(process.env.DB_PORT     || process.env.MYSQL_PORT || '3306', 10);
const MYSQL_USER = process.env.DB_USER     || process.env.MYSQL_USER || 'trackista';
const MYSQL_PASS = process.env.DB_PASSWORD || process.env.MYSQL_PASSWORD || '';
const MYSQL_DB   = process.env.DB_NAME     || process.env.MYSQL_DATABASE || 'trackista';

console.log('[backend] Starting backend API...');
console.log(`[backend] Redis: ${REDIS_HOST}:${REDIS_PORT}`);
console.log(`[backend] MySQL: ${MYSQL_HOST}:${MYSQL_PORT}/${MYSQL_DB}`);

// ─── Redis client ────────────────────────────────────────────────
const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });

redis.on('connect', () => {
  console.log('[backend] Connected to Redis');
  // Restore Binance IP backoff state from Redis so that klines routes don't
  // hammer Binance while a collector-triggered IP ban is still active.
  const { syncBackoffFromRedis } = require('./utils/binanceRestLogger');
  syncBackoffFromRedis(redis).catch(err =>
    console.error('[backend] syncBackoffFromRedis failed:', err.message),
  );
});
redis.on('error',   (err) => console.error('[backend] Redis error:', err.message));

// ─── MySQL pool ───────────────────────────────────────────────────
const db = mysql.createPool({
  host:            MYSQL_HOST,
  port:            MYSQL_PORT,
  user:            MYSQL_USER,
  password:        MYSQL_PASS,
  database:        MYSQL_DB,
  waitForConnections: true,
  connectionLimit: 10,
  timezone:        'Z',
});

db.getConnection()
  .then(conn => {
    console.log('[backend] Connected to MySQL');
    conn.release();
    // Run alert-module migrations and ensure MinIO bucket exists
    runMigrations(db).catch(err => console.error('[migrations] Failed:', err.message));
    runMoveMigrations(db).catch(err => console.error('[moveMigrations] Failed:', err.message));
    runMoveMigrations2(db).catch(err => console.error('[moveMigrations2] Failed:', err.message));
    runBarAggregatorMigrations(db).catch(err => console.error('[barAggregatorMigrations] Failed:', err.message));
    runWatchLevelsMigrations(db).catch(err => console.error('[watchMigrations] Failed:', err.message));
    ensureBucket().catch(err => console.error('[storage] ensureBucket failed:', err.message));
  })
  .catch(err => console.error('[backend] MySQL connection error:', err.message));

// ─── Levels service ───────────────────────────────────────────────
const levels  = createLevelsService(db, redis);

// ─── Level monitor ────────────────────────────────────────────────
const monitor = createLevelMonitorService(redis);
monitor.start();

const telegram      = createTelegramService();
const alertDelivery = createAlertDeliveryService(redis, telegram);

const alertEngine   = createAlertEngineService(redis, alertDelivery);
alertEngine.start();

const impulse       = createMarketImpulseService(redis, alertDelivery);
impulse.start();

dynamicTrackedSymbolsManager.start(redis);

// ─── Move Intelligence module ─────────────────────────────────────
const moveDetectionSvc = createMoveDetectionService(redis, db);
moveDetectionSvc.start();

const preEventSvc = createPreEventService(redis, moveDetectionSvc);
preEventSvc.start();

// ─── Phase 2: Derivatives, Ranking, Outcome Tracking ─────────────
const derivativesSvc = createDerivativesContextService(redis);
derivativesSvc.start();

const rankingSvc = createRankingService(redis, moveDetectionSvc);
rankingSvc.start();

const outcomeSvc = createOutcomeTrackingService(redis, db);
outcomeSvc.start();

const runtimeQaSvc = createRuntimeQaService(redis);
runtimeQaSvc.start();

const barAggregatorSvc = createBarAggregatorService(redis, db);
barAggregatorSvc.start();

const correlationSvc = createCorrelationService(redis);
correlationSvc.start();

// ─── Level Watch Engine ─────────────────────────────────────────────
const levelWatchEngine = createLevelWatchEngine(redis, db, alertDelivery);
levelWatchEngine.start();

// ─── Express app ─────────────────────────────────────────────────
const app = express();
app.use(express.json());

// GET /health
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// GET /api/price/:symbol
app.get('/api/price/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  console.log(`[backend] GET /api/price/${symbol}`);

  try {
    const price = await redis.get(`price:${symbol}`);

    if (price === null) {
      return res.status(404).json({
        success: false,
        error:   'Price not found',
        symbol,
      });
    }

    return res.json({
      success: true,
      symbol,
      price,
    });
  } catch (err) {
    console.error(`[backend] Error reading price:${symbol}:`, err.message);
    return res.status(500).json({
      success: false,
      error:   'Internal server error',
      symbol,
    });
  }
});

// GET /api/symbols
app.get('/api/symbols', async (_req, res) => {
  try {
    const raw = await redis.get('symbols:active:usdt');

    if (raw === null) {
      return res.status(503).json({
        success: false,
        error:   'Symbol list not available yet — collector may still be starting up',
      });
    }

    const symbols = JSON.parse(raw);
    return res.json({
      success: true,
      count:   symbols.length,
      symbols,
    });
  } catch (err) {
    console.error('[backend] Error reading symbols:active:usdt:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/trade/:symbol/last
app.get('/api/trade/:symbol/last', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  console.log(`[backend] GET /api/trade/${symbol}/last`);

  try {
    const raw = await redis.get(`trade:${symbol}:last`);

    if (raw === null) {
      return res.status(404).json({
        success: false,
        error:   'Trade data not found',
        symbol,
      });
    }

    return res.json({
      success: true,
      symbol,
      trade:   JSON.parse(raw),
    });
  } catch (err) {
    console.error(`[backend] Error reading trade:${symbol}:last:`, err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/metrics/:symbol
app.get('/api/metrics/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();

  try {
    const raw = await redis.get(`metrics:${symbol}`);

    if (raw === null) {
      return res.status(404).json({
        success: false,
        error:   'Metrics not found — symbol may be inactive or collector still warming up',
        symbol,
      });
    }

    return res.json({
      success: true,
      symbol,
      metrics: JSON.parse(raw),
    });
  } catch (err) {
    console.error(`[backend] Error reading metrics:${symbol}:`, err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/signals/:symbol
app.get('/api/signals/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();

  try {
    const raw = await redis.get(`signal:${symbol}`);

    if (raw === null) {
      return res.status(404).json({
        success: false,
        error:   'Signal not found — symbol may be inactive or collector still warming up',
        symbol,
      });
    }

    return res.json({
      success: true,
      symbol,
      signal: JSON.parse(raw),
    });
  } catch (err) {
    console.error(`[backend] Error reading signal:${symbol}:`, err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Helper: fetch all signal snapshots by active symbol list via pipeline
async function fetchAllSignals() {
  const rawSymbols = await redis.get('symbols:active:usdt');
  if (!rawSymbols) return null;
  const symbols = JSON.parse(rawSymbols);
  const pipeline = redis.pipeline();
  for (const sym of symbols) pipeline.get(`signal:${sym}`);
  const results = await pipeline.exec();
  const signals = [];
  for (const [err, raw] of results) {
    if (err || !raw) continue;
    try { signals.push(JSON.parse(raw)); } catch (_) {}
  }
  return signals;
}

// GET /api/market/in-play?limit=20
app.get('/api/market/in-play', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '20', 10), 500);

  try {
    const signals = await fetchAllSignals();
    if (signals === null) {
      return res.status(503).json({ success: false, error: 'Symbol list not available yet' });
    }

    signals.sort((a, b) => b.inPlayScore - a.inPlayScore);
    const items = signals.slice(0, limit).map(s => ({
      symbol:               s.symbol,
      inPlayScore:          s.inPlayScore,
      volumeSpikeRatio60s:  s.volumeSpikeRatio60s,
      volumeSpikeRatio15s:  s.volumeSpikeRatio15s,
      tradeAcceleration:    s.tradeAcceleration,
      deltaImbalancePct60s: s.deltaImbalancePct60s,
      impulseDirection:     s.impulseDirection,
      signalConfidence:     s.signalConfidence,
      baselineReady:        s.baselineReady,
    }));

    return res.json({ success: true, count: items.length, items });
  } catch (err) {
    console.error('[backend] Error in /api/market/in-play:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/market/impulse?limit=20&direction=up|down|mixed|all
app.get('/api/market/impulse', async (req, res) => {
  const limit     = Math.min(parseInt(req.query.limit || '20', 10), 500);
  const direction = (req.query.direction || 'all').toLowerCase();

  try {
    const signals = await fetchAllSignals();
    if (signals === null) {
      return res.status(503).json({ success: false, error: 'Symbol list not available yet' });
    }

    const filtered = direction === 'all'
      ? signals
      : signals.filter(s => s.impulseDirection === direction);

    filtered.sort((a, b) => b.impulseScore - a.impulseScore);
    const items = filtered.slice(0, limit).map(s => ({
      symbol:               s.symbol,
      impulseScore:         s.impulseScore,
      impulseDirection:     s.impulseDirection,
      volumeSpikeRatio15s:  s.volumeSpikeRatio15s,
      tradeAcceleration:    s.tradeAcceleration,
      deltaImbalancePct60s: s.deltaImbalancePct60s,
      priceVelocity60s:     s.priceVelocity60s,
      signalConfidence:     s.signalConfidence,
      baselineReady:        s.baselineReady,
    }));

    return res.json({ success: true, count: items.length, items });
  } catch (err) {
    console.error('[backend] Error in /api/market/impulse:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/market/top-active?limit=20
app.get('/api/market/top-active', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '20', 10), 500);

  try {
    const rawSymbols = await redis.get('symbols:active:usdt');
    if (rawSymbols === null) {
      return res.status(503).json({
        success: false,
        error:   'Symbol list not available yet — collector may still be starting up',
      });
    }

    const symbols = JSON.parse(rawSymbols);

    // Fetch all metrics in one pipeline
    const pipeline = redis.pipeline();
    for (const sym of symbols) pipeline.get(`metrics:${sym}`);
    const results = await pipeline.exec();

    const items = [];
    for (const [err, raw] of results) {
      if (err || !raw) continue;
      try {
        const m = JSON.parse(raw);
        items.push({
          symbol:            m.symbol,
          activityScore:     m.activityScore,
          volumeUsdt60s:     m.volumeUsdt60s,
          tradeCount60s:     m.tradeCount60s,
          priceChangePct60s: m.priceChangePct60s,
          lastPrice:         m.lastPrice,
        });
      } catch (_) { /* skip malformed */ }
    }

    items.sort((a, b) => b.activityScore - a.activityScore);

    return res.json({
      success: true,
      count:   Math.min(items.length, limit),
      items:   items.slice(0, limit),
    });
  } catch (err) {
    console.error('[backend] Error in /api/market/top-active:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─── Binance REST proxy (browser → backend → Binance, no direct browser→Binance) ──
console.log('[backend] registering /api/binance proxy route');
app.use('/api/binance', createBinanceProxyRouter());

// ─── Orderbook endpoint ──────────────────────────────────────────
console.log('[backend] registering /api/orderbook route');
app.get('/api/orderbook', createOrderbookHandler(redis));

// ─── Orderbook debug-compare endpoint ────────────────────────────
console.log('[backend] registering /api/orderbook/debug-compare route');
app.get('/api/orderbook/debug-compare', createOrderbookDebugHandler(redis));

// ─── Walls endpoint ───────────────────────────────────────────
console.log('[backend] registering /api/walls route');
app.get('/api/walls', createWallsHandler(redis));

console.log('[backend] registering /api/walls-batch route');
app.get('/api/walls-batch', createWallsBatchHandler(redis));

// ─── Density endpoints ────────────────────────────────────────
console.log('[backend] registering /api/density-view route');
app.get('/api/density-view', createDensityViewHandler(redis));

console.log('[backend] registering /api/density-summary route');
app.get('/api/density-summary', createDensitySummaryHandler(redis));

console.log('[backend] registering /api/wall-watchlist route');
app.get('/api/wall-watchlist', createWallWatchlistHandler(redis));

console.log('[backend] registering /api/density-tracked-symbols route');
app.get('/api/density-tracked-symbols', createDensityTrackedSymbolsHandler(redis));

console.log('[backend] registering /api/tracked-universe routes');
app.get('/api/tracked-universe/summary', createTrackedUniverseSummaryHandler(redis));
app.get('/api/tracked-universe', createTrackedUniverseHandler(redis));

// ─── Binance rate-limit state debug endpoint ──────────────────────
console.log('[backend] registering /api/binance-rate-limit-state route');
app.get('/api/binance-rate-limit-state', createBinanceRateLimitStateHandler(redis));

// ─── Futures OB debug state endpoint ─────────────────────────────
console.log('[backend] registering /api/futures-ob/state route');
app.get('/api/futures-ob/state', createFuturesObStateHandler(redis));
// GET /api/futures-walls-debug?symbol=BTCUSDT
console.log('[backend] registering /api/futures-walls-debug route');
app.get('/api/futures-walls-debug', createFuturesWallsDebugHandler(redis));
// ─── Level endpoints ─────────────────────────────────────────────

// GET /api/levels — levels engine (global/local, supports futures/spot)
console.log('[backend] registering /api/levels route');
app.get('/api/levels', levelsHandler);

// GET /api/autolevels — AutoLevels engine (pivot grid clustering)
console.log('[backend] registering /api/autolevels route');
app.get('/api/autolevels', autoLevelsHandler);

// ─── Manual levels endpoints ──────────────────────────────────────
console.log('[backend] registering /api/manual-levels routes');
app.post('/api/manual-levels',       manualLevelsCreate);
app.get('/api/manual-levels',        manualLevelsList);
app.delete('/api/manual-levels/:id', manualLevelsDelete);
// NOTE: app.patch('/api/manual-levels/:id', ...) is registered AFTER all
// /watch sub-routes below to avoid Express matching '2/watch' as id='2/watch'

// Watch endpoints for file-based manual levels
// These persist alertEnabled + watchMode + alertOptions into manual-levels.json
// and the unified watch loader picks them up automatically (alertEnabled=true filter).
const VALID_MANUAL_SOUNDS = new Set([
  'default_alert','soft_ping','breakout_high','bounce_soft',
  'fakeout_warning','wall_alert','urgent_alarm',
]);

const VALID_WATCH_MODES    = new Set(['off', 'simple']);
const VALID_SCENARIO_MODES = new Set(['bounce_only', 'breakout_only', 'wick_only', 'auto', 'all_in']);
const VALID_SOUND_PRESETS  = new Set([
  'standard', 'soft', 'danger', 'breakout', 'bounce', 'wick',
  'meme-airhorn', 'meme-bruh', 'meme-ohno',
]);
const VALID_DISPLAY_SCOPES = new Set(['tab', 'all_tabs', 'system', 'telegram']);

app.patch('/api/manual-levels/:id/watch', (req, res) => {
  if (typeof req.params.id === 'string' && req.params.id.startsWith('local_')) {
    return res.status(404).json({ success: false, error: 'Level not found (local id not yet synced)' });
  }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid id' });

  const level = manualLevelsGetById(id);
  if (!level) return res.status(404).json({ success: false, error: 'Level not found' });

  const {
    watchEnabled, watchMode, alertOptions, scenarioMode,
    soundEnabled, soundPreset, popupEnabled, badgeEnabled,
    telegramEnabled, displayScope,
  } = req.body || {};

  if (watchEnabled !== undefined && typeof watchEnabled !== 'boolean') {
    return res.status(400).json({ success: false, error: 'watchEnabled must be a boolean' });
  }
  if (watchMode !== undefined && !VALID_WATCH_MODES.has(watchMode)) {
    return res.status(400).json({ success: false, error: 'watchMode must be off or simple' });
  }
  if (scenarioMode !== undefined && !VALID_SCENARIO_MODES.has(scenarioMode)) {
    return res.status(400).json({ success: false, error: `scenarioMode must be one of: ${[...VALID_SCENARIO_MODES].join(', ')}` });
  }
  if (soundPreset !== undefined && !VALID_SOUND_PRESETS.has(soundPreset)) {
    console.log(`[watch-config] invalid_sound_preset_rejected id=${id} preset=${soundPreset}`);
    return res.status(400).json({ success: false, error: `soundPreset must be one of: ${[...VALID_SOUND_PRESETS].join(', ')}` });
  }
  if (displayScope !== undefined && !VALID_DISPLAY_SCOPES.has(displayScope)) {
    return res.status(400).json({ success: false, error: `displayScope must be one of: ${[...VALID_DISPLAY_SCOPES].join(', ')}` });
  }
  if (alertOptions && alertOptions.soundId && !VALID_MANUAL_SOUNDS.has(alertOptions.soundId)) {
    return res.status(400).json({ success: false, error: `soundId must be one of: ${[...VALID_MANUAL_SOUNDS].join(', ')}` });
  }

  const updates = {};
  if (watchEnabled  !== undefined) updates.alertEnabled  = watchEnabled;
  if (watchMode     !== undefined) updates.watchMode     = watchMode;
  if (scenarioMode  !== undefined) updates.scenarioMode  = scenarioMode;

  // Merge sound/popup fields into alertOptions
  const aoOverrides = {};
  if (soundEnabled    !== undefined)  aoOverrides.soundEnabled    = soundEnabled;
  if (soundPreset     !== undefined)  aoOverrides.soundPreset     = soundPreset;
  if (popupEnabled    !== undefined)  aoOverrides.popupEnabled    = popupEnabled;
  if (badgeEnabled    !== undefined)  aoOverrides.badgeEnabled    = badgeEnabled;
  if (telegramEnabled !== undefined)  aoOverrides.telegramEnabled = telegramEnabled;
  if (displayScope    !== undefined)  aoOverrides.displayScope    = displayScope;

  const hasAoOverrides = Object.keys(aoOverrides).length > 0;
  if (hasAoOverrides || alertOptions !== undefined) {
    updates.alertOptions = {
      ...(level.alertOptions || {}),
      ...(alertOptions || {}),
      ...aoOverrides,
    };
  }

  const updated = manualLevelsPatch(id, updates);
  if (soundPreset !== undefined) {
    console.log(`[watch-config] sound_preset_saved id=${id} preset=${soundPreset}`);
  }
  if (displayScope !== undefined) {
    console.log(`[watch-config] display_scope_saved id=${id} scope=${displayScope}`);
  }
  levelWatchEngine.loader.invalidate();
  const ao = updated.alertOptions || {};
  return res.json({
    success:         true,
    levelId:         id,
    watchEnabled:    Boolean(updated.alertEnabled),
    watchMode:       updated.watchMode    || 'simple',
    scenarioMode:    updated.scenarioMode || 'all_in',
    soundPreset:     ao.soundPreset    ?? 'standard',
    soundEnabled:    ao.soundEnabled   ?? true,
    popupEnabled:    ao.popupEnabled   ?? true,
    badgeEnabled:    ao.badgeEnabled   ?? true,
    telegramEnabled: ao.telegramEnabled ?? false,
    displayScope:    ao.displayScope   ?? 'tab',
  });
});

app.get('/api/manual-levels/:id/watch', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid id' });

  const level = manualLevelsGetById(id);
  if (!level) return res.status(404).json({ success: false, error: 'Level not found' });

  const ao = level.alertOptions || {};
  return res.json({
    success:         true,
    levelId:         id,
    watchEnabled:    Boolean(level.alertEnabled),
    watchMode:       level.watchMode    || 'simple',
    scenarioMode:    level.scenarioMode || 'all_in',
    soundEnabled:    ao.soundEnabled   ?? true,
    soundPreset:     ao.soundPreset    ?? 'standard',
    popupEnabled:    ao.popupEnabled   ?? true,
    badgeEnabled:    ao.badgeEnabled   ?? true,
    telegramEnabled: ao.telegramEnabled ?? false,
    displayScope:    ao.displayScope   ?? 'tab',
    alertOptions:    ao,
  });
});

app.get('/api/manual-levels/:id/watch-state', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid id' });

  const level = manualLevelsGetById(id);
  if (!level) return res.status(404).json({ success: false, error: 'Level not found' });

  const debugMode = req.query.debug === '1';

  try {
    const market = level.marketType || 'futures';
    const key    = `levelwatchstate:${market}:${level.symbol}:manual-${id}`;
    const raw    = await redis.get(key);
    const state  = raw ? JSON.parse(raw) : null;

    // When debug=1 return the full state as-is; in normal mode strip raw pending internals
    let returnState = state;
    if (state && !debugMode) {
      const { pendingContactTicks, pendingCrossTicks, pendingCrossDirection,
              lastNonAtSide, transitionReason, lastEventSuppressedReason,
              pending, ...publicState } = state;
      returnState = publicState;
    }

    return res.json({
      success:      true,
      levelId:      id,
      watchEnabled: Boolean(level.alertEnabled),
      watchMode:    level.watchMode || 'simple',
      debug:        debugMode,
      state:        returnState,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.get('/api/manual-levels/:id/events', (_req, res) => {
  // File-based levels have no MySQL event history — events flow via alerts:recent
  const id = parseInt(_req.params.id, 10);
  return res.json({ success: true, levelId: id, count: 0, nextCursor: null, items: [] });
});

// Registered AFTER /watch sub-routes so Express doesn't match '2/watch' as id='2/watch'
app.patch('/api/manual-levels/:id',  manualLevelsPatchFactory(levelWatchEngine?.loader));

// ─── Tracked levels endpoints ─────────────────────────────────────
console.log('[backend] registering /api/tracked-levels routes');
app.post('/api/tracked-levels/bulk',        trackedLevelsBulk);
app.get('/api/tracked-levels',              trackedLevelsList);
app.delete('/api/tracked-levels/:id',       trackedLevelsDeleteOne);
app.post('/api/tracked-levels/delete-many', trackedLevelsDeleteMany);
app.patch('/api/tracked-levels/:id',        (req, res) => { trackedLevelsPatchOne(req, res); levelWatchEngine?.loader?.invalidate(); });
app.post('/api/tracked-levels/patch-many',  trackedLevelsPatchMany);

// ─── Tracked extremes endpoints ──────────────────────────────────
console.log('[backend] registering /api/tracked-extremes routes');
app.post('/api/tracked-extremes/bulk',        trackedExtremesBulk);
app.get('/api/tracked-extremes',              trackedExtremesList);
app.delete('/api/tracked-extremes/:id',       trackedExtremesDeleteOne);
app.post('/api/tracked-extremes/delete-many', trackedExtremesDeleteMany);
app.patch('/api/tracked-extremes/:id',        (req, res) => { trackedExtremesPatchOne(req, res); levelWatchEngine?.loader?.invalidate(); });
app.post('/api/tracked-extremes/patch-many',  (req, res) => { trackedExtremesPatchMany(req, res); levelWatchEngine?.loader?.invalidate(); });

// ─── Tracked rays endpoints ──────────────────────────────────────
console.log('[backend] registering /api/tracked-rays routes');
app.post('/api/tracked-rays/bulk',        trackedRaysBulk);
app.get('/api/tracked-rays',              trackedRaysList);
app.delete('/api/tracked-rays/:id',       trackedRaysDeleteOne);
app.post('/api/tracked-rays/delete-many', trackedRaysDeleteMany);
app.patch('/api/tracked-rays/:id',        trackedRaysPatchOne);
app.post('/api/tracked-rays/patch-many',  trackedRaysPatchMany);
app.get('/api/tracked-rays/:id/value',    trackedRaysLineValue);

// ─── Manual sloped levels endpoints ────────────────────────────────
console.log('[backend] registering /api/manual-sloped-levels routes');
app.post('/api/manual-sloped-levels',             manualSlopedCreate);
app.get('/api/manual-sloped-levels',              manualSlopedList);
app.delete('/api/manual-sloped-levels/:id',       manualSlopedDelete);
app.patch('/api/manual-sloped-levels/:id',        manualSlopedPatch);
app.get('/api/manual-sloped-levels/:id/value',    manualSlopedLineValue);

// ─── Saved rays endpoints ────────────────────────────────────────
console.log('[backend] registering /api/saved-rays routes');
app.post('/api/saved-rays/bulk',             savedRaysBulk);
app.get('/api/saved-rays',                   savedRaysList);
app.delete('/api/saved-rays/:id',            savedRaysDeleteOne);
app.post('/api/saved-rays/delete-many',      savedRaysDeleteMany);
app.patch('/api/saved-rays/:id/watch',       (req, res) => savedRaysWatchPatch(req, res, levelWatchEngine?.loader));
app.get('/api/saved-rays/:id/watch',         savedRaysWatchGet);
app.get('/api/saved-rays/:id/watch-state',   (req, res) => savedRaysWatchState(req, res, redis));
app.patch('/api/saved-rays/:id',             savedRaysPatchOne);
app.post('/api/saved-rays/patch-many',       savedRaysPatchMany);

// ─── Extremes rays endpoints ──────────────────────────────────────
console.log('[backend] registering /api/extremes-rays routes');
app.post('/api/extremes-rays',        extremesRaysCreate);
app.get('/api/extremes-rays',         extremesRaysList);
app.patch('/api/extremes-rays/:id',   extremesRaysPatch);
app.delete('/api/extremes-rays/:id',  extremesRaysDelete);

// GET /api/levels/state/:symbol
app.get('/api/levels/state/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const raw = await redis.get(`levelstate:${symbol}`);
    if (!raw) {
      return res.status(404).json({
        success: false,
        symbol,
        error: 'No level state found — symbol may have no active levels or monitor is warming up',
      });
    }
    return res.json({ success: true, symbol, state: JSON.parse(raw) });
  } catch (err) {
    console.error(`[backend] Error reading levelstate:${symbol}:`, err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/levels/watchlist — symbols with approaching/touched/breakout/bounce
app.get('/api/levels/watchlist', async (req, res) => {
  try {
    const rawSymbols = await redis.get('symbols:active:usdt');
    if (!rawSymbols) {
      return res.status(503).json({ success: false, error: 'Symbol list not available yet' });
    }
    const symbols = JSON.parse(rawSymbols);

    const pipeline = redis.pipeline();
    for (const sym of symbols) pipeline.get(`levelstate:${sym}`);
    const results = await pipeline.exec();

    const watchlist = [];
    for (const [err, raw] of results) {
      if (err || !raw) continue;
      let state;
      try { state = JSON.parse(raw); } catch (_) { continue; }
      const { levels: lvls = [] } = state;
      const approaching       = lvls.some(l => l.approaching);
      const touched           = lvls.some(l => l.touched);
      const breakoutCandidate = lvls.some(l => l.breakoutCandidate);
      const bounceCandidate   = lvls.some(l => l.bounceCandidate);
      if (!approaching && !touched && !breakoutCandidate && !bounceCandidate) continue;
      watchlist.push({
        symbol:             state.symbol,
        updatedAt:          state.updatedAt,
        levelCount:         lvls.length,
        approaching,
        touched,
        breakoutCandidate,
        bounceCandidate,
      });
    }

    return res.json({ success: true, count: watchlist.length, watchlist });
  } catch (err) {
    console.error('[backend] Error in /api/levels/watchlist:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/levels/:symbol
app.get('/api/levels/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const result = await levels.getActiveLevelsBySymbol(symbol);
    return res.json({ success: true, symbol, count: result.length, levels: result });
  } catch (err) {
    console.error(`[backend] Error reading levels:${symbol}:`, err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/levels/manual
app.post('/api/levels/manual', async (req, res) => {
  const payload = req.body || {};
  const errors  = levels.validateLevelPayload(payload, true);
  if (errors.length) {
    return res.status(400).json({ success: false, errors });
  }
  if (!levels.ALLOWED_TYPES.has(payload.type)) {
    return res.status(400).json({ success: false, errors: [`type must be one of: ${[...levels.ALLOWED_TYPES].join(', ')}`] });
  }

  try {
    const level = await levels.createManualLevel(payload);
    return res.status(201).json({ success: true, level });
  } catch (err) {
    console.error('[backend] Error creating manual level:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// PATCH /api/levels/:id
app.patch('/api/levels/:id', async (req, res) => {
  const id      = parseInt(req.params.id, 10);
  const payload = req.body || {};

  if (isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid id' });

  const errors = levels.validateLevelPayload(payload, false);
  if (errors.length) return res.status(400).json({ success: false, errors });

  try {
    const level = await levels.updateLevel(id, payload);
    if (!level) return res.status(404).json({ success: false, error: 'Level not found' });
    return res.json({ success: true, level });
  } catch (err) {
    console.error(`[backend] Error updating level ${id}:`, err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// DELETE /api/levels/:id  (soft delete)
app.delete('/api/levels/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid id' });

  try {
    const result = await levels.deactivateLevel(id);
    if (!result) return res.status(404).json({ success: false, error: 'Level not found' });
    return res.json({ success: true, id: result.id, message: 'Level deactivated' });
  } catch (err) {
    console.error(`[backend] Error deactivating level ${id}:`, err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─── Delivery endpoints ───────────────────────────────────────────

// GET /api/delivery/status
app.get('/api/delivery/status', async (_req, res) => {
  try {
    const recentCount = await redis.llen('alerts:recent');
    return res.json({
      success: true,
      telegram: {
        enabled:       telegram.enabled,
        chatConfigured: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
      },
      recentAlerts: recentCount,
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// POST /api/delivery/test  (dev/internal only)
app.post('/api/delivery/test', async (req, res) => {
  const body = req.body || {};
  const symbol       = body.symbol       || 'BTCUSDT';
  const direction    = body.direction    || 'UP';
  const priceMovePct = body.priceMovePct || 10.0;
  const volSpike     = body.volSpike     || 3.2;
  const price        = body.price        || 82450.50;

  const impulseScore      = parseFloat(((Math.abs(priceMovePct) * 40) + (volSpike * 50)).toFixed(1));
  const priceFactor       = Math.abs(priceMovePct) / 2.5;
  const volumeFactor      = volSpike / 2.0;
  const signalConfidence  = Math.min(((priceFactor + volumeFactor) / 2) * 100, 100);
  const severity          = (Math.abs(priceMovePct) >= 5.0 && volSpike >= 3.0) ? 'critical' : 'high';

  const testAlert = {
    type:         'market_impulse',
    symbol,
    severity,
    createdAt:    Date.now(),
    currentPrice: price,
    signalContext: {
      impulseDirection:  direction,
      impulseScore,
      signalConfidence:  parseFloat(signalConfidence.toFixed(1)),
      priceMovePct5s:    priceMovePct,
      volume5s:          125000,
      baselineVolume5s:  39062,
      volumeSpikeRatio:  volSpike,
      impulseWindowSec:  5,
    },
  };
  try {
    const result = await alertDelivery.handleAlert(testAlert);
    return res.json({ success: true, alert: testAlert, result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─── Alert endpoints ───────────────────────────────────────────────
// NOTE: /api/posts is the social feed (screenshots/annotations).
//       /api/alerts/* below are the existing market-impulse alert endpoints.
console.log('[backend] registering /api/auth routes');
app.use('/api/auth', createAuthRouter(db, redis));

console.log('[backend] registering /api/posts routes');
app.use('/api/posts', createPostsRouter(db, redis));

// ─── Alert endpoints ───────────────────────────────────────────────

// GET /api/alerts/recent?limit=50
app.get('/api/alerts/recent', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 500);
  try {
    const raws = await redis.lrange('alerts:recent', 0, limit - 1);
    const alerts = raws.map(r => { try { return JSON.parse(r); } catch (_) { return null; } }).filter(Boolean);
    return res.json({ success: true, count: alerts.length, alerts });
  } catch (err) {
    console.error('[backend] Error reading alerts:recent:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/alerts/watchlist
app.get('/api/alerts/watchlist', async (req, res) => {
  try {
    const raws = await redis.lrange('alerts:recent', 0, 499);
    const seen = new Set();
    for (const r of raws) {
      try { const a = JSON.parse(r); if (a && a.symbol) seen.add(a.symbol); } catch (_) {}
    }
    const symbols = [...seen];
    return res.json({ success: true, count: symbols.length, symbols });
  } catch (err) {
    console.error('[backend] Error reading alerts watchlist:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/alerts/:symbol?limit=20
app.get('/api/alerts/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  const limit  = Math.min(parseInt(req.query.limit || '20', 10), 500);
  try {
    const raws = await redis.lrange('alerts:recent', 0, 499);
    const alerts = [];
    for (const r of raws) {
      if (alerts.length >= limit) break;
      try {
        const a = JSON.parse(r);
        if (a && a.symbol === symbol) alerts.push(a);
      } catch (_) {}
    }
    return res.json({ success: true, symbol, count: alerts.length, alerts });
  } catch (err) {
    console.error(`[backend] Error reading alerts for ${symbol}:`, err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─── JSON 404 fallback ────────────────────────────────────────────
// ─── WS proxy debug endpoint ─────────────────────────────────────────────────
// ─── Move Intelligence routes ───────────────────────────────────
console.log('[backend] registering /api/moves, /api/events, /api/pre-signals, /api/screener routes');
app.use('/api/moves',                    createMovesRouter(redis, db));
app.use('/api/events',                   createMovesRouter(redis, db));
app.use('/api/pre-signals',              createPreSignalsRouter(redis, db));
app.use('/api/screener/kline-stats',     createKlineStatsRouter(redis));
app.use('/api/screener',                 createScreenerMovesRouter(redis, db));

console.log('[backend] registering /api/funding routes');
app.use('/api/funding',                  createFundingRouter(redis));

console.log('[backend] registering /api/correlation routes');
app.use('/api/correlation',              createCorrelationRouter(redis));

console.log('[backend] registering /api/symbol routes');
app.use('/api/symbol',                   createSymbolDataRouter(redis));

// ─── Level Watch Engine routes ─────────────────────────────────────────
console.log('[backend] registering /api/levels/:id/watch routes');
app.use('/api/levels', createLevelWatchRouter(db, redis, levelWatchEngine.loader));
console.log('[backend] registering /api/level-events routes');
app.use('/api/level-events', createLevelEventsRouter(db));
console.log('[backend] registering /api/alert-sounds route');
app.use('/api/alert-sounds', createAlertSoundsRouter());

// ─── Synthetic Feed (dev/test) ───────────────────────────────────
console.log('[backend] registering /api/synth routes');
const synthPlaybackService = new SyntheticPlaybackService(redis);
app.use('/api/synth', createSynthRouter(synthPlaybackService));

// ─── Phase 2: TESTTEST diagnostic routes ─────────────────────────
const path = require('path');
app.use('/api/testtest', createTestTestRouter(redis, db, { moveDetectionSvc, derivativesSvc, rankingSvc }));
app.get('/testtest', (_req, res) => res.sendFile(path.join(__dirname, 'routes', 'testtest.html')));
app.get('/screener', (_req, res) => res.sendFile(path.join(__dirname, 'routes', 'screener.html')));

// ─── Phase 3: Runtime QA routes ─────────────────────────────────
console.log('[backend] registering /api/runtime-qa routes');
app.use('/api/runtime-qa', createRuntimeQaRouter(redis, runtimeQaSvc));

// ─── Block 1: 1-minute bars routes ───────────────────────────────
console.log('[backend] registering /api/bars routes');
app.use('/api/bars', createBarsRouter(redis, db));

console.log('[backend] registering /api/ws-proxy/debug route');
app.get('/api/ws-proxy/debug', (_req, res) => {
  return res.json({ success: true, now: new Date().toISOString(), ...getWsProxyStats() });
});

// Must be registered AFTER all routes so it only fires when nothing matched.
// Returns JSON instead of Express's default HTML — prevents frontend from
// silently swallowing errors or misidentifying the response as success.
app.use((req, res) => {
  console.warn(`[backend] 404 ${req.method} ${req.path}`);
  res.status(404).json({ success: false, error: `Cannot ${req.method} ${req.path}` });
});

// ─── Start server ────────────────────────────────────────────────
const httpServer = app.listen(PORT, () => {
  console.log(`[backend] API listening on port ${PORT}`);
});

// Attach Binance WS proxy: /ws/stream/* → wss://stream.binance.com and /ws/fstream/* → wss://fstream.binance.com
attachBinanceWsProxy(httpServer);
