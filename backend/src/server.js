'use strict';

const express = require('express');
const Redis   = require('ioredis');
const mysql   = require('mysql2/promise');

const { createLevelsService }         = require('./levelsService');
const { levelsHandler }               = require('./routes/levelsEngineRoute');
const { autoLevelsHandler }           = require('./routes/autoLevelsRoute');
const { createDebugExtremesLevelsHandler } = require('./routes/debugExtremesLevelsRoute');
const { extremesEngineHandler, extremesEngineDebugHandler } = require('./routes/extremesEngineRoute');
const { createHandler: manualLevelsCreate, listHandler: manualLevelsList, deleteHandler: manualLevelsDelete, patchHandler: manualLevelsPatchFactory } = require('./routes/manualLevelsRoute');
const { getById: manualLevelsGetById, patch: manualLevelsPatch } = require('./services/manualLevelsStore');
const { bulkHandler: trackedLevelsBulk, listHandler: trackedLevelsList, deleteOneHandler: trackedLevelsDeleteOne, deleteManyHandler: trackedLevelsDeleteMany, patchOneHandler: trackedLevelsPatchOne, patchManyHandler: trackedLevelsPatchMany } = require('./routes/trackedLevelsRoute');
const { getById: trackedLevelsGetById } = require('./services/trackedLevelsStore');
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
const { createWebPushService }       = require('./services/webPushService');
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
const { createWallDebugHandler }                = require('./routes/wallDebugRoute');
const { createWallDepthHandlers }               = require('./routes/wallDepthRoute');
const { createUniverseDebugHandler }            = require('./routes/universeDebugRoute');
const { createTrackedUniverseHandler, createTrackedUniverseSummaryHandler } = require('./routes/trackedUniverseRoute');
const { createBinanceProxyRouter }             = require('./routes/binanceProxyRoute');
const { attachBinanceWsProxy, getWsProxyStats } = require('./routes/binanceWsProxy');
const dynamicTrackedSymbolsManager           = require('./services/density/dynamicTrackedSymbolsManager');
const { runMigrations }             = require('./services/alertMigrations');
const { runMoveMigrations }         = require('./services/moveMigrations');
const { ensureBucket }              = require('./services/alertStorageService');
const { createAuthRouter }          = require('./routes/authRoutes');
const { authRequired }              = require('./middleware/authRequired');
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
const barGapFillService                 = require('./services/barGapFillService');
const { createBarsRouter, createDebugBarsRouter } = require('./routes/barsRoute');
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
const { runRobobotMigrations }          = require('./services/robobotMigrations');
const { createRobobotEventService }     = require('./services/robobotEventService');
const { createRobobotTaskService }      = require('./services/robobotTaskService');
const { createRobobotWatchService }     = require('./services/robobotWatchService');
const robobotCloudBridge                = require('./services/robobotCloudBridge');
const { createRobobotRouter }           = require('./routes/robobotRoutes');
const { createAlertSoundsRouter }       = require('./routes/alertSoundsRoute');
const { SyntheticPlaybackService }      = require('./services/syntheticPlaybackService');
const { runScreenerAlertMigrations }    = require('./services/screenerAlertMigrations');
const { createScreenerAlertEngine }     = require('./services/screenerAlertEngine');
const { createScreenerAlertSettingsRouter } = require('./routes/screenerAlertSettingsRoute');
const { createScreenerAlertsRouter }    = require('./routes/screenerAlertsRoute');
const { createScreenerSnapshotRouter }  = require('./routes/screenerSnapshotRoute');
const { createScreenerLiveRouter }      = require('./routes/screenerLiveRoute');
const { createScreenerDiagnosticsRouter } = require('./routes/screenerDiagnosticsRoute');
const { createLiveSnapshotRouter }      = require('./routes/liveSnapshotRoute');
const { createLiveDeltaRouter }         = require('./routes/liveDeltaRoute');
const { createLiveHealthRouter }        = require('./routes/liveHealthRoute');
const { createMarketDataHealthRouter }  = require('./routes/marketDataHealthRoute');
const livePollingMetrics                = require('./services/livePollingMetrics');
const { createKlineFlatRouter }         = require('./routes/klineFlatRoute');
const { createScreenerSpotStatsRouter } = require('./routes/screenerSpotStatsRoute');
const { createSynthRouter }             = require('./routes/synthRoute');
const { attachLiveWsGateway, stopGateway: stopLiveWsGateway } = require('./routes/liveWsGateway');
const { createHeatmapRouter, attachHeatmapWs } = require('./routes/heatmapRoute');
const { createDensityDomRouter }        = require('./routes/densityDomRoute');
const { createFormationsCompareSourceHandler } = require('./routes/formationsCompareSourceRoute');
const heatmapService                    = require('./services/heatmapService');
const densityService                    = require('./services/densityService');
const wsEventBus                        = require('./services/wsEventBus');
const { createFormationsModule }        = require('./formations');
const { createExtremePatternFormationService } = require('./formations/patterns/extremePatternFormationService');
const { createFormationPatternRoutes }  = require('./formations/patterns/formationPatternRoutes');
const trackedExtremesStore              = require('./services/trackedExtremesStore');

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

// ─── Process safety net ───────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  const msg = (reason && (reason.stack || reason.message)) || String(reason);
  console.error('[backend] UNHANDLED REJECTION:', msg);
});
process.on('uncaughtException', (err) => {
  console.error('[backend] UNCAUGHT EXCEPTION:', err && (err.stack || err.message));
  // Process state is corrupted after an uncaught exception. Trigger graceful
  // shutdown so the orchestrator restarts a clean instance.
  if (typeof shutdown === 'function') {
    shutdown('uncaughtException').catch(() => process.exit(1));
    setTimeout(() => process.exit(1), 10_000).unref();
  } else {
    process.exit(1);
  }
});

// ─── Redis client ────────────────────────────────────────────────
const redis = new Redis({ host: REDIS_HOST, port: REDIS_PORT });

let _backoffSynced = false;
redis.on('connect', () => {
  console.log('[backend] Connected to Redis');
  // Restore Binance IP backoff state from Redis so that klines routes don't
  // hammer Binance while a collector-triggered IP ban is still active.
  // Guard against repeat invocations on Redis reconnects.
  if (_backoffSynced) return;
  _backoffSynced = true;
  const { syncBackoffFromRedis } = require('./utils/binanceRestLogger');
  syncBackoffFromRedis(redis).catch(err => {
    _backoffSynced = false;
    console.error('[backend] syncBackoffFromRedis failed:', err.message);
  });
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

// Run all migrations sequentially to avoid races on shared schema objects.
// Service startup below assumes tables/columns from these migrations exist.
let migrationsReady = (async () => {
  const conn = await db.getConnection();
  console.log('[backend] Connected to MySQL');
  conn.release();
  const steps = [
    ['migrations',              () => runMigrations(db)],
    ['moveMigrations',          () => runMoveMigrations(db)],
    ['moveMigrations2',         () => runMoveMigrations2(db)],
    ['barAggregatorMigrations', () => runBarAggregatorMigrations(db)],
    ['watchMigrations',         () => runWatchLevelsMigrations(db)],
    ['screenerAlertMigrations', () => runScreenerAlertMigrations(db)],
    ['robobotMigrations',       () => runRobobotMigrations(db)],
  ];
  for (const [name, run] of steps) {
    try { await run(); }
    catch (err) { console.error(`[${name}] Failed:`, err.message); }
  }
  try { await ensureBucket(); }
  catch (err) { console.error('[storage] ensureBucket failed:', err.message); }
})().catch(err => {
  console.error('[backend] MySQL connection / migrations error:', err.message);
});

// ─── Levels service ───────────────────────────────────────────────
const levels  = createLevelsService(db, redis);

// ─── Level monitor ────────────────────────────────────────────────
const monitor = createLevelMonitorService(redis);
monitor.start();

const telegram      = createTelegramService();
const webPushSvc    = createWebPushService(db, redis);
const alertDelivery = createAlertDeliveryService(redis, telegram, webPushSvc);

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

const screenerAlertEngine = createScreenerAlertEngine(redis, db, alertDelivery);
screenerAlertEngine.start();

// ─── Heatmap service ─────────────────────────────────────────────
heatmapService.start(redis, wsEventBus)
  .catch(err => console.error('[heatmap] start error:', err.message));

densityService.start(redis, wsEventBus)
  .catch(err => console.error('[density] start error:', err.message));

// ─── Formations (isolated breakout-scanner module) ───────────────
const formations = createFormationsModule({ redis });
formations.service.start();

// ─── Extreme Pattern Formations (v1: horizontal sharp extremes) ──
const extremePatternService = createExtremePatternFormationService({ redis, trackedExtremesStore });
extremePatternService.start();
const patternFormationRouter = createFormationPatternRoutes({ service: extremePatternService, store: extremePatternService.store });

// ─── Express app ─────────────────────────────────────────────────
const app = express();
// Trust the first hop (nginx) so `req.ip` reflects the real client; the
// rate-limiter middleware relies on `req.ip` for per-IP keys.
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Minimal security headers (helmet-equivalent for our REST surface). nginx
// in front may already set some of these — these are belt-and-suspenders.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  next();
});

// Optional CORS — only enable when CORS_ORIGIN is set (e.g. for dev frontend
// hitting the API directly without nginx). In production nginx terminates CORS.
const CORS_ORIGIN = process.env.CORS_ORIGIN || '';
if (CORS_ORIGIN) {
  const allowed = CORS_ORIGIN.split(',').map(s => s.trim()).filter(Boolean);
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && allowed.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
      if (req.method === 'OPTIONS') return res.status(204).end();
    }
    next();
  });
}

app.use(express.json({ limit: '256kb' }));

// Global API rate-limit guard. Per-route limiters (auth, posts, votes)
// remain stricter; this is a coarse last-resort cap against burst floods.
// High-frequency read surfaces (screener, live, heatmap, alerts, orderbook,
// market, formations) get dedicated relaxed buckets so frequent polling from
// the frontend never trips the coarse global cap.
{
  const { createRateLimiter } = require('./middleware/rateLimiters');
  const globalApiLimiter = createRateLimiter({
    max:       parseInt(process.env.RATE_LIMIT_API_MAX || '600', 10) || 600,
    windowSec: parseInt(process.env.RATE_LIMIT_API_WINDOW_SEC || '60', 10) || 60,
    keyPrefix: 'api',
  })(redis);

  // Relaxed limiter shared by all high-frequency read namespaces.
  const readApiLimiter = createRateLimiter({
    max:       parseInt(process.env.RATE_LIMIT_READ_MAX || '10000', 10) || 10000,
    windowSec: parseInt(process.env.RATE_LIMIT_READ_WINDOW_SEC || '60', 10) || 60,
    keyPrefix: 'api-read',
  })(redis);

  // Read-heavy namespaces that must not share the coarse global bucket.
  const READ_PREFIXES = [
    '/screener/',
    '/live/',
    '/heatmap/',
    '/alerts/',
    '/formations/',
    '/orderbook',
    '/market/',
    '/walls',
    '/density',
    '/tracked-universe',
    // Chart page — burst on symbol switch (many hooks fire in parallel)
    '/correlation/',
    '/manual-levels',
    '/saved-rays',
    '/funding/',
    '/autolevels',
    '/extremes-engine',
    '/tracked-extremes',
    '/tracked-levels',
    '/auto-levels',
    '/bars',
    // Watch-state polling — frontend polls per-level every few seconds
    '/levels',
  ];

  app.use('/api', (req, res, next) => {
    const path = req.path || '';
    // Binance datafeed bypass (can burst heavily with many kline/agg-trade requests).
    if (path.startsWith('/binance/')) return next();
    // All high-frequency read surfaces use a relaxed shared bucket.
    if (READ_PREFIXES.some(p => path.startsWith(p))) return readApiLimiter(req, res, next);
    return globalApiLimiter(req, res, next);
  });
}

// GET /health
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// GET /api/price/:symbol
app.get('/api/price/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();

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

// Reads impulse:signal:{sym} written by marketImpulseService (composite 0-100 score)
async function fetchAllImpulseSignals() {
  const rawSymbols = await redis.get('symbols:active:usdt');
  if (!rawSymbols) return null;
  const symbols = JSON.parse(rawSymbols);
  const pipeline = redis.pipeline();
  for (const sym of symbols) pipeline.get(`impulse:signal:${sym}`);
  const results = await pipeline.exec();
  const signals = [];
  for (const [err, raw] of results) {
    if (err || !raw) continue;
    try { signals.push(JSON.parse(raw)); } catch (_) {}
  }
  return signals;
}

// GET /api/market/impulse?limit=20&direction=up|down|mixed|all&minVolume=0&search=BTC
app.get('/api/market/impulse', async (req, res) => {
  const limit      = Math.min(parseInt(req.query.limit || '20', 10), 500);
  const direction  = (req.query.direction || 'all').toLowerCase();
  const minVolume  = parseFloat(req.query.minVolume || '0');
  const search     = typeof req.query.search === 'string' ? req.query.search.trim().toUpperCase() : '';

  try {
    const signals = await fetchAllImpulseSignals();
    if (signals === null) {
      return res.status(503).json({ success: false, error: 'Symbol list not available yet', count: 0, items: [] });
    }

    const now = Date.now();
    let filtered = signals;

    // Only return coins that are currently in the active impulse list
    filtered = filtered.filter(s => s.activeUntil && s.activeUntil > now);

    // Direction filter (case-insensitive, supports up/down/mixed/all)
    if (direction !== 'all') {
      filtered = filtered.filter(s => (s.impulseDirection ?? 'neutral').toLowerCase() === direction);
    }

    // Volume filter
    if (minVolume > 0) {
      filtered = filtered.filter(s => (s.volumeUsdt60s ?? 0) >= minVolume);
    }

    // Symbol search filter
    if (search) {
      filtered = filtered.filter(s => (s.symbol ?? '').includes(search));
    }

    // Stable order: by entry time (detectedAt ASC) so coins keep their slot
    // and do not jump as their impulseScore fluctuates. New coins append at
    // the bottom; tie-break by symbol for deterministic ordering.
    filtered.sort((a, b) => {
      const tDiff = (a.detectedAt ?? a.activeUntil ?? 0) - (b.detectedAt ?? b.activeUntil ?? 0);
      if (tDiff !== 0) return tDiff;
      return (a.symbol ?? '').localeCompare(b.symbol ?? '');
    });

    const items = filtered.slice(0, limit).map(s => ({
      symbol:              s.symbol              ?? '',
      price:               s.price               ?? 0,
      impulseDirection:    s.impulseDirection    ?? 'neutral',
      impulseWindow:       s.impulseWindow       ?? null,
      impulseMovePct:      s.impulseMovePct      ?? null,
      move1sPct:           s.move1sPct           ?? null,
      move5sPct:           s.move5sPct           ?? null,
      move15sPct:          s.move15sPct          ?? null,
      move60sPct:          s.move60sPct          ?? null,
      volumeSpikeRatio15s: s.volumeSpikeRatio15s ?? 0,
      tradeAcceleration:   s.tradeAcceleration   ?? 0,
      deltaUsdt60s:        s.deltaUsdt60s        ?? 0,
      oiChangePct:         s.oiChangePct         ?? (s.openInterestChangePct ?? 0),
      domBidPct:           s.domBidPct           ?? 50,
      domAskPct:           s.domAskPct           ?? 50,
      impulseScore:        s.impulseScore        ?? 0,
      detectedAt:          s.detectedAt          ?? null,
      activeUntil:         s.activeUntil         ?? null,
      lastUpdateTs:        s.lastUpdateTs        ?? (s.updatedAt ?? 0),
      // backward-compat
      volumeUsdt60s:       s.volumeUsdt60s       ?? 0,
      baselineReady:       s.baselineReady       ?? false,
      updatedAt:           s.updatedAt           ?? 0,
    }));

    return res.json({ success: true, count: items.length, items });
  } catch (err) {
    console.error('[backend] Error in /api/market/impulse:', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch impulse data', count: 0, items: [] });
  }
});

// GET /api/market/impulse/:symbol/ticks?limit=300
// Returns rolling 1s price/volume/delta snapshots for short-term chart.
// Sorted ASC by ts. Up to 300 ticks (~5 minutes).
{
  const { safeSymbol: _safeSymbol } = require('./utils/parseClamp');
  app.get('/api/market/impulse/:symbol/ticks', async (req, res) => {
    const symbol = _safeSymbol(req.params.symbol);
    if (!symbol) return res.status(400).json({ success: false, error: 'Invalid symbol' });
    const limit = Math.min(parseInt(req.query.limit || '300', 10), 300);
    try {
      const raws = await redis.zrange(`ticks:impulse:${symbol}`, -limit, -1);
      if (!raws || raws.length === 0) {
        return res.json({ success: true, symbol, count: 0, ticks: [] });
      }
      const ticks = [];
      for (const r of raws) {
        try { ticks.push(JSON.parse(r)); } catch (_) {}
      }
      return res.json({ success: true, symbol, count: ticks.length, ticks });
    } catch (err) {
      console.error('[backend] Error in /api/market/impulse/:symbol/ticks:', err.message);
      return res.status(500).json({ success: false, error: 'Failed to fetch ticks', symbol, count: 0, ticks: [] });
    }
  });
}

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
app.use('/api/binance', createBinanceProxyRouter(redis));

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
app.get('/api/futures-walls-debug', authRequired, createFuturesWallsDebugHandler(redis));

// GET /api/density/wall-debug?symbol=BTCUSDT — v3 adaptive wall algorithm debug
console.log('[backend] registering /api/density/wall-debug route');
app.get('/api/density/wall-debug', authRequired, createWallDebugHandler(redis));

// GET /api/density/wall-depth?symbol=ETHUSDT — depth-to-wall visualization data
// GET /api/density/wall-depth-debug?symbol=ETHUSDT — debug variant with rejects
console.log('[backend] registering /api/density/wall-depth routes');
const _wallDepthHandlers = createWallDepthHandlers(redis);
app.get('/api/density/wall-depth',       _wallDepthHandlers.main);
app.get('/api/density/wall-depth-debug', _wallDepthHandlers.debug);

// GET /api/density/universe-debug — included + excluded symbols with volatility diagnostics
app.get('/api/density/universe-debug', authRequired, createUniverseDebugHandler(redis));
// ─── Level endpoints ─────────────────────────────────────────────

// GET /api/levels — levels engine (global/local, supports futures/spot)
console.log('[backend] registering /api/levels route');
app.get('/api/levels', levelsHandler);

// GET /api/extremes-engine — server-side Sharp Extremes / Vertical Extremes / Trendlines
// ?symbol=BTCUSDT&tf=5m&marketType=futures&source=sharp-extremes|vertical-extremes|trendlines
// Optional overrides: lookbackBars, pivotWindow, minStrengthPct, variant, etc.
// save=true (default) persists results to trackedExtremesStore (userModified records are preserved)
console.log('[backend] registering /api/extremes-engine route');
app.get('/api/extremes-engine', extremesEngineHandler);

// GET /api/extremes-engine/debug — per-candle diagnostics for sharp-extremes
// ?symbol=XLMUSDT&tf=1h&source=sharp-extremes
console.log('[backend] registering /api/extremes-engine/debug route');
app.get('/api/extremes-engine/debug', authRequired, extremesEngineDebugHandler);

// GET /api/autolevels — AutoLevels engine (pivot grid clustering)
console.log('[backend] registering /api/autolevels route');
app.get('/api/autolevels', autoLevelsHandler);

// GET /api/debug/extremes-levels?symbol=SLXUSDT&tf=5m&marketType=futures
console.log('[backend] registering /api/debug/extremes-levels route');
app.get('/api/debug/extremes-levels', authRequired, createDebugExtremesLevelsHandler());

// ─── Manual levels endpoints ──────────────────────────────────────
console.log('[backend] registering /api/manual-levels routes');
app.post('/api/manual-levels',       authRequired, manualLevelsCreate);
app.get('/api/manual-levels',        authRequired, manualLevelsList);
app.delete('/api/manual-levels/:id', authRequired, (req, res) => {
  const id    = parseInt(req.params.id, 10);
  const level = !isNaN(id) && id > 0 ? manualLevelsGetById(id) : null;
  manualLevelsDelete(req, res);
  if (level?.alertEnabled) {
    const market = level.marketType || 'futures';
    redis.del(`levelwatchstate:${market}:${level.symbol}:manual-${id}`).catch(() => {});
    levelWatchEngine?.loader?.invalidate();
  }
});
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

app.patch('/api/manual-levels/:id/watch', authRequired, (req, res) => {
  if (typeof req.params.id === 'string' && req.params.id.startsWith('local_')) {
    return res.status(404).json({ success: false, error: 'Level not found (local id not yet synced)' });
  }
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid id' });

  const userId = req.user?.id ?? null;
  const level = manualLevelsGetById(id);
  if (!level) return res.status(404).json({ success: false, error: 'Level not found' });
  if (userId && level.userId && level.userId !== userId) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }

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

  const updated = manualLevelsPatch(id, updates, userId);
  if (soundPreset !== undefined) {
    console.log(`[watch-config] sound_preset_saved id=${id} preset=${soundPreset}`);
  }
  if (displayScope !== undefined) {
    console.log(`[watch-config] display_scope_saved id=${id} scope=${displayScope}`);
  }
  levelWatchEngine.loader.invalidate();
  // Immediately delete the Redis watch-state key when watch is disabled so
  // the WS flush loop stops broadcasting the level as active right away
  // (otherwise the key lingers until its 90 s TTL expires).
  if (watchEnabled === false) {
    const market = level.marketType || 'futures';
    redis.del(`levelwatchstate:${market}:${level.symbol}:manual-${id}`).catch(() => {});
  }
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

app.get('/api/manual-levels/:id/watch', authRequired, (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid id' });

  const userId = req.user?.id ?? null;
  const level = manualLevelsGetById(id);
  if (!level) return res.status(404).json({ success: false, error: 'Level not found' });
  if (userId && level.userId && level.userId !== userId) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }

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

app.get('/api/manual-levels/:id/watch-state', authRequired, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return res.status(400).json({ success: false, error: 'Invalid id' });

  const userId = req.user?.id ?? null;
  const level = manualLevelsGetById(id);
  if (!level) return res.status(404).json({ success: false, error: 'Level not found' });
  if (userId && level.userId && level.userId !== userId) {
    return res.status(403).json({ success: false, error: 'Forbidden' });
  }

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
app.patch('/api/manual-levels/:id',  authRequired, manualLevelsPatchFactory(levelWatchEngine?.loader));

// ─── Tracked levels endpoints ─────────────────────────────────────
console.log('[backend] registering /api/tracked-levels routes');
app.post('/api/tracked-levels/bulk',        authRequired, (req, res) => { trackedLevelsBulk(req, res); levelWatchEngine?.loader?.invalidate(); });
app.get('/api/tracked-levels',              authRequired, trackedLevelsList);
app.delete('/api/tracked-levels/:id',       authRequired, (req, res) => {
  const id    = parseInt(req.params.id, 10);
  const level = !isNaN(id) && id > 0 ? trackedLevelsGetById(id) : null;
  trackedLevelsDeleteOne(req, res);
  if (level?.alertEnabled) {
    const market = level.marketType || 'futures';
    redis.del(`levelwatchstate:${market}:${level.symbol}:tracked-${id}`).catch(() => {});
    levelWatchEngine?.loader?.invalidate();
  }
});
app.post('/api/tracked-levels/delete-many', authRequired, (req, res) => { trackedLevelsDeleteMany(req, res); levelWatchEngine?.loader?.invalidate(); });
app.patch('/api/tracked-levels/:id',        authRequired, async (req, res) => {
  await trackedLevelsPatchOne(req, res);
  levelWatchEngine?.loader?.invalidate();
  // Immediately delete the Redis watch-state key when alertEnabled is turned off
  if (req.body?.alertEnabled === false) {
    const id    = parseInt(req.params.id, 10);
    const level = !isNaN(id) && id > 0 ? trackedLevelsGetById(id) : null;
    if (level) {
      const market = level.marketType || 'futures';
      redis.del(`levelwatchstate:${market}:${level.symbol}:tracked-${id}`).catch(() => {});
    }
  }
});
app.post('/api/tracked-levels/patch-many',  authRequired, (req, res) => { trackedLevelsPatchMany(req, res); levelWatchEngine?.loader?.invalidate(); });

// ─── Tracked extremes endpoints ──────────────────────────────────
console.log('[backend] registering /api/tracked-extremes routes');
app.post('/api/tracked-extremes/bulk',        authRequired, async (req, res) => { await trackedExtremesBulk(req, res); levelWatchEngine?.loader?.invalidate(); });
app.get('/api/tracked-extremes',              authRequired, trackedExtremesList);
app.delete('/api/tracked-extremes/:id',       authRequired, trackedExtremesDeleteOne);
app.post('/api/tracked-extremes/delete-many', authRequired, trackedExtremesDeleteMany);
app.patch('/api/tracked-extremes/:id',        authRequired, async (req, res) => { await trackedExtremesPatchOne(req, res); levelWatchEngine?.loader?.invalidate(); });
app.post('/api/tracked-extremes/patch-many',  authRequired, async (req, res) => { await trackedExtremesPatchMany(req, res); levelWatchEngine?.loader?.invalidate(); });

// ─── Tracked rays endpoints ──────────────────────────────────────
console.log('[backend] registering /api/tracked-rays routes');
app.post('/api/tracked-rays/bulk',        authRequired, trackedRaysBulk);
app.get('/api/tracked-rays',              authRequired, trackedRaysList);
app.delete('/api/tracked-rays/:id',       authRequired, trackedRaysDeleteOne);
app.post('/api/tracked-rays/delete-many', authRequired, trackedRaysDeleteMany);
app.patch('/api/tracked-rays/:id',        authRequired, trackedRaysPatchOne);
app.post('/api/tracked-rays/patch-many',  authRequired, trackedRaysPatchMany);
app.get('/api/tracked-rays/:id/value',    authRequired, trackedRaysLineValue);

// ─── Manual sloped levels endpoints ────────────────────────────────
console.log('[backend] registering /api/manual-sloped-levels routes');
app.post('/api/manual-sloped-levels',             authRequired, manualSlopedCreate);
app.get('/api/manual-sloped-levels',              authRequired, manualSlopedList);
app.delete('/api/manual-sloped-levels/:id',       authRequired, manualSlopedDelete);
app.patch('/api/manual-sloped-levels/:id',        authRequired, async (req, res) => { await manualSlopedPatch(req, res); levelWatchEngine?.loader?.invalidate(); });
app.get('/api/manual-sloped-levels/:id/value',    authRequired, manualSlopedLineValue);

// ─── Saved rays endpoints ────────────────────────────────────────
console.log('[backend] registering /api/saved-rays routes');
app.post('/api/saved-rays/bulk',             authRequired, async (req, res) => { await savedRaysBulk(req, res); levelWatchEngine?.loader?.invalidate(); });
app.get('/api/saved-rays',                   authRequired, savedRaysList);
app.delete('/api/saved-rays/:id',            authRequired, async (req, res) => { await savedRaysDeleteOne(req, res); levelWatchEngine?.loader?.invalidate(); });
app.post('/api/saved-rays/delete-many',      authRequired, async (req, res) => { await savedRaysDeleteMany(req, res); levelWatchEngine?.loader?.invalidate(); });
app.patch('/api/saved-rays/:id/watch',       authRequired, (req, res) => savedRaysWatchPatch(req, res, levelWatchEngine?.loader));
app.get('/api/saved-rays/:id/watch',         authRequired, savedRaysWatchGet);
app.get('/api/saved-rays/:id/watch-state',   authRequired, (req, res) => savedRaysWatchState(req, res, redis));
app.patch('/api/saved-rays/:id',             authRequired, async (req, res) => { await savedRaysPatchOne(req, res); levelWatchEngine?.loader?.invalidate(); });
app.post('/api/saved-rays/patch-many',       authRequired, async (req, res) => { await savedRaysPatchMany(req, res); levelWatchEngine?.loader?.invalidate(); });

// ─── Extremes rays endpoints ──────────────────────────────────────
console.log('[backend] registering /api/extremes-rays routes');
app.post('/api/extremes-rays',        authRequired, extremesRaysCreate);
app.get('/api/extremes-rays',         authRequired, extremesRaysList);
app.patch('/api/extremes-rays/:id',   authRequired, extremesRaysPatch);
app.delete('/api/extremes-rays/:id',  authRequired, extremesRaysDelete);

// ─── Level Watch Engine routes (must be before /api/levels/:symbol wildcard) ───
console.log('[backend] registering /api/levels/:id/watch routes');
app.use('/api/levels', authRequired, createLevelWatchRouter(db, redis, levelWatchEngine.loader));

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
// Reads from levelwatchstate:* (levelWatchEngine) instead of legacy levelstate:{sym}
app.get('/api/levels/watchlist', async (req, res) => {
  try {
    const symbolMap = new Map(); // symbol → { approaching, touched, breakoutCandidate, bounceCandidate, updatedAt, levelCount }

    // SCAN all current watch states — non-blocking
    let cursor = '0';
    do {
      const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'levelwatchstate:*', 'COUNT', 200);
      cursor = nextCursor;
      if (keys.length === 0) continue;

      const pipeline = redis.pipeline();
      for (const k of keys) pipeline.get(k);
      const results = await pipeline.exec();

      for (const [, raw] of results) {
        if (!raw) continue;
        let s;
        try { s = JSON.parse(raw); } catch (_) { continue; }
        if (!s || !s.symbol || !s.phase) continue;

        const sym  = s.symbol;
        const prev = symbolMap.get(sym) || { approaching: false, touched: false, breakoutCandidate: false, bounceCandidate: false, updatedAt: 0, levelCount: 0 };
        prev.levelCount++;
        if (s.phase === 'approaching' || s.phase === 'precontact') prev.approaching = true;
        if (s.phase === 'contact' || s.touchDetected)              prev.touched = true;
        if (s.crossDetectedRaw || s.crossConfirmed || s.phase === 'crossed') prev.breakoutCandidate = true;
        if (s.rollbackAfterAlert)                                  prev.bounceCandidate = true;
        if ((s.updatedAt ?? 0) > prev.updatedAt)                   prev.updatedAt = s.updatedAt;
        symbolMap.set(sym, prev);
      }
    } while (cursor !== '0');

    const watchlist = [];
    for (const [symbol, data] of symbolMap) {
      if (!data.approaching && !data.touched && !data.breakoutCandidate && !data.bounceCandidate) continue;
      watchlist.push({ symbol, ...data });
    }
    watchlist.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

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
app.post('/api/levels/manual', authRequired, async (req, res) => {
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
app.patch('/api/levels/:id', authRequired, async (req, res) => {
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
app.delete('/api/levels/:id', authRequired, async (req, res) => {
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

// POST /api/delivery/test  (dev/internal only — auth-gated to prevent outbound spam)
app.post('/api/delivery/test', authRequired, async (req, res) => {
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

// GET /api/push/vapid-public-key
app.get('/api/push/vapid-public-key', (req, res) => {
  if (!process.env.VAPID_PUBLIC_KEY) return res.status(503).json({ error: 'Push not configured' });
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// POST /api/push/subscribe
app.post('/api/push/subscribe', authRequired, async (req, res) => {
  const { endpoint, keys, deviceName } = req.body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'Missing required fields: endpoint, keys.p256dh, keys.auth' });
  }
  try {
    await db.query(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, device_name, user_agent)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE p256dh=VALUES(p256dh), auth=VALUES(auth), updated_at=NOW()`,
      [req.user.id, endpoint, keys.p256dh, keys.auth, deviceName || null, req.headers['user-agent'] || null],
    );
    res.status(201).json({ success: true });
  } catch (err) {
    console.error('[push.subscribe] error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/push/unsubscribe
app.delete('/api/push/unsubscribe', authRequired, async (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) return res.status(400).json({ error: 'Missing endpoint' });
  try {
    await db.query(
      'DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?',
      [req.user.id, endpoint],
    );
    res.json({ success: true });
  } catch (err) {
    console.error('[push.unsubscribe] error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/alerts/live?since=<ts>
// Timestamp-based global alert polling — returns all alerts newer than `since` (ms epoch).
// Any page can poll this endpoint to receive the same stream of alert events.
// Response: { ts, items: NormalizedAlertEvent[], nextSince }
// Frontend: poll every 2-5s with since=nextSince from previous response.
app.get('/api/alerts/live', async (req, res) => {
  const since = parseInt(req.query.since || '0', 10);
  const nowTs = Date.now();
  try {
    // Query sorted set (score = createdAt) for events newer than `since`
    const zsetRaws = await redis.zrangebyscore('alerts:live', since + 1, '+inf');
    let items;
    if (zsetRaws.length > 0) {
      items = zsetRaws
        .map(r => { try { return JSON.parse(r); } catch (_) { return null; } })
        .filter(Boolean);
      // Sorted set range is ascending by score, but verify sort
      items.sort((a, b) => a.createdAt - b.createdAt);
    } else {
      // Fallback: scan alerts:recent list (covers migration period before sorted set populates)
      const raws = await redis.lrange('alerts:recent', 0, 499);
      items = [];
      for (const r of raws) {
        try { const a = JSON.parse(r); if (a && a.createdAt > since) items.push(a); } catch (_) {}
      }
      items.sort((a, b) => a.createdAt - b.createdAt);
    }
    const nextSince = items.length > 0 ? items[items.length - 1].createdAt : since;
    return res.json({ ts: nowTs, items, nextSince });
  } catch (err) {
    console.error('[backend] Error reading alerts:live:', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// GET /api/alerts/active
// Returns all currently monitored levels with their live watch state.
// Source: unifiedWatchLevelsLoader (in-memory cache, 5 s TTL) + Redis levelwatchstate keys.
// Sort: crossed → contact → precontact → approaching → watching; within same phase by distancePct asc.
app.get('/api/alerts/active', async (req, res) => {
  try {
    const levels = await levelWatchEngine.loader.load();
    if (levels.length === 0) {
      return res.json({ success: true, count: 0, items: [] });
    }

    // Fetch all Redis watch states in one pipeline
    const pipeline = redis.pipeline();
    for (const lvl of levels) {
      pipeline.get(`levelwatchstate:${lvl.market}:${lvl.symbol}:${lvl.internalId}`);
    }
    const results = await pipeline.exec();

    const items = [];
    for (let i = 0; i < levels.length; i++) {
      const lvl = levels[i];
      const [, raw] = results[i];
      let state = null;
      if (raw) { try { state = JSON.parse(raw); } catch (_) {} }

      items.push({
        internalId:          lvl.internalId,
        levelId:             lvl.levelId          ?? null,
        externalLevelId:     lvl.externalLevelId  ?? null,
        symbol:              lvl.symbol,
        market:              lvl.market,
        source:              lvl.source           ?? null,
        geometryType:        lvl.geometryType     ?? 'horizontal',
        side:                lvl.side             ?? null,
        tf:                  lvl.timeframe        ?? null,
        price:               lvl.price            ?? null,
        watchEnabled:        true,
        alertEnabled:        true,
        notificationEnabled: lvl.alertOptions?.notificationEnabled ?? false,
        popupEnabled:        lvl.alertOptions?.popupEnabled        ?? true,
        telegramEnabled:     lvl.alertOptions?.telegramEnabled      ?? false,
        // Runtime state — null when engine hasn't ticked for this level yet (Redis TTL 90 s)
        phase:               state?.phase          ?? null,
        distancePct:         state?.absDistancePct ?? null,
        currentPrice:        state?.currentPrice   ?? null,
        levelPriceRef:       state?.levelPrice     ?? lvl.price ?? null,
        etaLabel:            state?.etaLabel       ?? null,
        etaSeconds:          state?.etaSeconds     ?? null,
        approaching:         state?.approaching    ?? null,
        movingToward:        state?.movingToward   ?? null,
        scenarioLeading:     state?.scenarioLeading ?? null,
        lastEventType:       state?.lastEventType  ?? null,
        lastEventAt:         state?.lastEventAt    ?? null,
        updatedAt:           state?.updatedAt      ?? null,
      });
    }

    // Sort by phase priority, then distancePct ascending
    const phaseOrder = { crossed: 0, contact: 1, precontact: 2, approaching: 3, watching: 4 };
    items.sort((a, b) => {
      const pd = (phaseOrder[a.phase] ?? 9) - (phaseOrder[b.phase] ?? 9);
      if (pd !== 0) return pd;
      return (a.distancePct ?? 999) - (b.distancePct ?? 999);
    });

    return res.json({ success: true, count: items.length, items });
  } catch (err) {
    console.error('[backend] GET /api/alerts/active error:', err.message);
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

// ── Screener domain routes ──────────────────────────────────────────────────
// Auth-protected sub-routes registered BEFORE the general screenerMovesRouter
// so Express does not swallow them under the wildcard mount.
app.use('/api/screener/alert-settings', authRequired, createScreenerAlertSettingsRouter(db, screenerAlertEngine));
app.use('/api/screener/alerts',         authRequired, createScreenerAlertsRouter(redis));

// New unified snapshot / live-delta / diagnostics routes
app.use('/api/screener/snapshot',        createScreenerSnapshotRouter(redis));
app.use('/api/screener/live',            createScreenerLiveRouter(redis));
app.use('/api/screener/debug',           authRequired, createScreenerDiagnosticsRouter(redis));
app.use('/api/screener/kline-flat',      createKlineFlatRouter(redis));
app.use('/api/screener/spot-stats',      createScreenerSpotStatsRouter(redis));

// Production live-polling endpoints (scope-aware, rate-guarded, with pollingHints)
app.use('/api/live/snapshot',            createLiveSnapshotRouter(redis, livePollingMetrics));
app.use('/api/live/delta',               createLiveDeltaRouter(redis, livePollingMetrics));

// Legacy screener routes kept for backwards-compat while frontend migrates
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

// (levelWatchRouter already registered above, before /api/levels/:symbol)
console.log('[backend] registering /api/level-events routes');
app.use('/api/level-events', createLevelEventsRouter(db));
console.log('[backend] registering /api/alert-sounds route');
app.use('/api/alert-sounds', createAlertSoundsRouter());

// ─── Synthetic Feed (dev/test) ───────────────────────────────────
console.log('[backend] registering /api/synth routes');
const synthPlaybackService = new SyntheticPlaybackService(redis);
app.use('/api/synth', authRequired, createSynthRouter(synthPlaybackService));

// ─── Phase 2: TESTTEST diagnostic routes ─────────────────────────
const path = require('path');
app.use('/api/testtest', authRequired, createTestTestRouter(redis, db, { moveDetectionSvc, derivativesSvc, rankingSvc }));
app.get('/testtest', (_req, res) => res.sendFile(path.join(__dirname, 'routes', 'testtest.html')));
app.get('/screener', (_req, res) => res.sendFile(path.join(__dirname, 'routes', 'screener.html')));

// ─── Phase 3: Runtime QA routes ─────────────────────────────────
console.log('[backend] registering /api/runtime-qa routes');
app.use('/api/runtime-qa', authRequired, createRuntimeQaRouter(redis, runtimeQaSvc));

// ─── Live polling health ─────────────────────────────────────────
console.log('[backend] registering /api/runtime/live-health route');
app.use('/api/runtime/live-health', createLiveHealthRouter(livePollingMetrics));

console.log('[backend] registering /api/health/market-data route');
app.use('/api/health/market-data', createMarketDataHealthRouter(redis));

// ─── Block 1: 1-minute bars routes ───────────────────────────────
console.log('[backend] registering /api/bars routes');
app.use('/api/bars', createBarsRouter(redis, db));

console.log('[backend] registering /api/debug/bars routes');
app.use('/api/debug/bars', createDebugBarsRouter(redis, db));

// POST /api/debug/bars/gap-fill — manually trigger immediate gap-fill scan
app.post('/api/debug/bars/gap-fill', authRequired, async (_req, res) => {
  try {
    barGapFillService.attach(redis, db);
    // Run in background — don't await so the response is instant
    barGapFillService.runGapFill().catch(err =>
      console.error('[barGapFill] manual trigger error:', err.message),
    );
    res.json({ success: true, message: 'Gap-fill started in background. Check server logs.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

console.log('[backend] registering /api/ws-proxy/debug route');
app.get('/api/ws-proxy/debug', authRequired, (_req, res) => {
  return res.json({ success: true, now: new Date().toISOString(), ...getWsProxyStats() });
});

// ─── Heatmap routes ───────────────────────────────────────────────
console.log('[backend] registering /api/heatmap routes');
app.use('/api/heatmap', createHeatmapRouter(redis, heatmapService));

console.log('[backend] registering /api/density routes');
app.use('/api/density', createDensityDomRouter(redis, densityService));

console.log('[backend] registering /api/formations routes');
app.use('/api/formations/scalping', formations.router);
app.use('/api/formations/debug', formations.debugRouter);
app.get('/api/formations/compare-source', createFormationsCompareSourceHandler({ service: formations.service }));

// New pattern formations endpoint
console.log('[backend] registering /api/formations/patterns routes');
app.use('/api/formations/patterns', patternFormationRouter);

// Density chart / orderbook / depth / symbols / appearance (new density page)
const { createDensityChartRouter } = require('./routes/densityChartRoute');
console.log('[backend] registering /api/density chart/orderbook/depth-map/symbols/appearance routes');
app.use('/api/density', createDensityChartRouter(redis));

// ─── Robobot module ─────────────────────────────────────────────
console.log('[backend] registering /api/robobot routes');
const robobotEventService = createRobobotEventService(db);
const robobotTaskService  = createRobobotTaskService(db, robobotEventService);
const robobotWatchService = createRobobotWatchService({
  redis,
  taskService  : robobotTaskService,
  eventService : robobotEventService,
  cloudBridge  : robobotCloudBridge,
});
robobotWatchService.start();
app.use('/api/robobot', authRequired, createRobobotRouter({
  redis,
  taskService  : robobotTaskService,
  eventService : robobotEventService,
  watchService : robobotWatchService,
}));

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

// Attach live WS gateway BEFORE Binance proxy so /ws/live is intercepted first
attachLiveWsGateway(httpServer, redis);

// Attach dedicated heatmap WS at /ws/heatmap?symbol=
attachHeatmapWs(httpServer, redis, wsEventBus);

// Attach Binance WS proxy: /ws/stream/* → wss://stream.binance.com and /ws/fstream/* → wss://fstream.binance.com
attachBinanceWsProxy(httpServer);

// ─── Graceful shutdown ───────────────────────────────────────
let _shuttingDown = false;
async function shutdown(signal) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`[backend] ${signal} received — shutting down gracefully…`);

  // Stop accepting new HTTP/WS connections; let in-flight requests finish.
  try {
    await new Promise((resolve) => {
      httpServer.close(() => resolve());
      // Hard cap so we don't hang forever on a stuck keep-alive socket.
      setTimeout(() => resolve(), 8_000).unref();
    });
  } catch (err) {
    console.error('[backend] httpServer.close error:', err.message);
  }

  // Stop background services that expose a .stop() handle. Each is wrapped so
  // one slow/buggy service does not block others. Order: producers → consumers.
  const stopSteps = [
    ['liveWsGateway',      () => stopLiveWsGateway?.()],
    ['alertEngine',        () => alertEngine?.stop?.()],
    ['correlationSvc',     () => correlationSvc?.stop?.()],
    ['barAggregatorSvc',   () => barAggregatorSvc?.stop?.()],
    ['runtimeQaSvc',       () => runtimeQaSvc?.stop?.()],
    ['outcomeSvc',         () => outcomeSvc?.stop?.()],
    ['rankingSvc',         () => rankingSvc?.stop?.()],
    ['derivativesSvc',     () => derivativesSvc?.stop?.()],
    ['preEventSvc',        () => preEventSvc?.stop?.()],
    ['moveDetectionSvc',   () => moveDetectionSvc?.stop?.()],
    ['screenerAlertEngine',() => screenerAlertEngine?.stop?.()],
    ['robobotWatchService',() => robobotWatchService?.stop?.()],
  ];
  await Promise.allSettled(stopSteps.map(async ([name, fn]) => {
    try { await fn(); }
    catch (err) { console.error(`[backend] ${name}.stop error:`, err.message); }
  }));

  // Close DB pool and Redis client. Do this last so shutdown handlers in
  // services that flush state on close still have a working client.
  try { await db.end(); } catch (err) { console.error('[backend] db.end error:', err.message); }
  try { await redis.quit(); } catch (err) { console.error('[backend] redis.quit error:', err.message); }
  console.log('[backend] shutdown complete');
  process.exit(0);
}
// Expose for the uncaughtException handler hoisted earlier in the file.
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
