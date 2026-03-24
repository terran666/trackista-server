'use strict';

/**
 * unifiedWatchLevelsLoader.js
 * ─────────────────────────────────────────────────────────────────
 * Loads watch-enabled levels from ALL sources and normalises them
 * into a single NormalizedWatchLevel[] list.
 *
 * Sources (Phase 1):
 *  1. MySQL `levels` JOIN `level_watch_configs` JOIN `level_alert_options`
 *     WHERE watch_enabled = TRUE
 *  2. File-based `tracked-levels.json` with alertEnabled = true  (adapter)
 *
 * Sources (Phase 2 — groundwork only, skipped if stores empty):
 *  3. `manual-levels.json`
 *  4. `manual-sloped-levels.json`  → geometryType='sloped'
 *
 * The result is cached in-memory for CACHE_TTL_MS to protect the DB
 * from 1-second per-tick queries.
 */

const path = require('path');
const fs   = require('fs');

const CACHE_TTL_MS = 5_000; // refresh unified list every 5 s

// ─── File-store helpers ───────────────────────────────────────────

function safeReadJson(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

function readTrackedLevels() {
  const store = safeReadJson(path.join(DATA_DIR, 'tracked-levels.json'));
  if (!store || !Array.isArray(store.levels)) return [];
  return store.levels;
}

function readManualLevels() {
  const store = safeReadJson(path.join(DATA_DIR, 'manual-levels.json'));
  if (!store || !Array.isArray(store.levels)) return [];
  return store.levels;
}

function readManualSlopedLevels() {
  const store = safeReadJson(path.join(DATA_DIR, 'manual-sloped-levels.json'));
  if (!store || !Array.isArray(store.levels)) return [];
  return store.levels;
}

// ─── Normalizers ──────────────────────────────────────────────────

/**
 * Normalise a MySQL levels row (with joined watch_config/alert_options)
 * into a NormalizedWatchLevel object.
 */
function normalizeDbLevel(row) {
  return {
    internalId:       `db-${row.id}`,
    levelId:          row.id,
    externalLevelId:  null,
    symbol:           row.symbol,
    market:           row.market || 'futures',
    timeframe:        row.timeframe || null,
    source:           row.source || null,
    geometryType:     row.geometry_type || 'horizontal',
    side:             row.side || null,
    price:            parseFloat(row.price),
    watchEnabled:     Boolean(row.watch_enabled),
    watchMode:        row.watch_mode || 'simple',
    tactics: {
      breakout:     Boolean(row.tactic_breakout),
      bounce:       Boolean(row.tactic_bounce),
      fakeout:      Boolean(row.tactic_fakeout),
      wallBounce:   Boolean(row.tactic_wall_bounce),
      wallBreakout: Boolean(row.tactic_wall_breakout),
    },
    config: {
      cooldownSec:        row.cooldown_sec        ?? 60,
      proximityZonePct:   parseFloat(row.proximity_zone_pct  ?? 0.5),
      touchZonePct:       parseFloat(row.touch_zone_pct      ?? 0.05),
      minConfidence:      parseFloat(row.min_confidence       ?? 70),
      minImpulseScore:    parseFloat(row.min_impulse_score    ?? 100),
      minInPlayScore:     parseFloat(row.min_in_play_score    ?? 100),
    },
    alertOptions: row.ao_id ? {
      earlyWarningEnabled:          Boolean(row.early_warning_enabled),
      warnBeforeSeconds:            row.warn_before_seconds     ?? null,
      warnBeforeDistancePct:        row.warn_before_distance_pct != null ? parseFloat(row.warn_before_distance_pct) : null,
      warnOnApproachSpeedChange:    Boolean(row.warn_on_approach_speed_change),
      warnOnVolumeChange:           Boolean(row.warn_on_volume_change),
      warnOnTradesChange:           Boolean(row.warn_on_trades_change),
      warnOnWallChange:             Boolean(row.warn_on_wall_change),
      minApproachSpeed:             row.min_approach_speed   != null ? parseFloat(row.min_approach_speed)   : null,
      minVolumeDeltaPct:            row.min_volume_delta_pct != null ? parseFloat(row.min_volume_delta_pct) : null,
      minTradesDeltaPct:            row.min_trades_delta_pct != null ? parseFloat(row.min_trades_delta_pct) : null,
      minWallStrength:              row.min_wall_strength    != null ? parseFloat(row.min_wall_strength)    : null,
      popupEnabled:                 Boolean(row.popup_enabled),
      telegramEnabled:              Boolean(row.telegram_enabled),
      popupPriority:                row.popup_priority    || 'normal',
      telegramPriority:             row.telegram_priority || 'high',
      soundEnabled:                 Boolean(row.sound_enabled),
      soundId:                      row.sound_id    || 'default_alert',
      soundGroup:                   row.sound_group || 'standard',
    } : defaultAlertOptions(),
    isActive: Boolean(row.is_active),
    meta: row.meta_json
      ? (typeof row.meta_json === 'string' ? (() => { try { return JSON.parse(row.meta_json); } catch (_) { return null; } })() : row.meta_json)
      : null,
  };
}

/**
 * Normalise a tracked-levels.json record (alertEnabled=true adapter).
 * In Phase 1, tracked levels that have alertEnabled=true are treated as
 * simple-watch levels using default config.
 */
function normalizeTrackedLevel(tl) {
  return {
    internalId:       `tracked-${tl.id}`,
    levelId:          null,
    externalLevelId:  String(tl.id),
    symbol:           tl.symbol,
    market:           tl.marketType || 'futures',
    timeframe:        tl.tf || null,
    source:           tl.source || 'tracked',
    geometryType:     'horizontal',
    side:             tl.side || null,
    price:            parseFloat(tl.price),
    watchEnabled:     true,
    watchMode:        'simple',
    tactics: {
      breakout: false, bounce: false, fakeout: false,
      wallBounce: false, wallBreakout: false,
    },
    config:       defaultConfig(),
    alertOptions: defaultAlertOptions(),
    isActive:     true,
    meta: {
      touches:            tl.touches,
      score:              tl.score,
      virgin:             tl.virgin,
      formationTimestamp: tl.formationTimestamp,
    },
  };
}

/**
 * Normalise a manual-levels.json record with alertEnabled=true.
 * Uses stored alertOptions/watchMode if present, otherwise defaults.
 */
function normalizeManualLevel(ml) {
  const storedOpts = ml.alertOptions || {};
  const alertOptions = {
    ...defaultAlertOptions(),
    ...storedOpts,
  };
  return {
    internalId:       `manual-${ml.id}`,
    levelId:          null,
    externalLevelId:  String(ml.id),
    symbol:           ml.symbol,
    market:           ml.marketType || 'futures',
    timeframe:        null,
    source:           'manual',
    geometryType:     'horizontal',
    side:             ml.side || null,
    price:            parseFloat(ml.price),
    watchEnabled:     true,
    watchMode:        ml.watchMode    || 'simple',
    scenarioMode:     ml.scenarioMode || 'all_in',
    tactics: {
      breakout: false, bounce: false, fakeout: false,
      wallBounce: false, wallBreakout: false,
    },
    config:       defaultConfig(),
    alertOptions,
    isActive:     true,
    meta:         null,
  };
}

// ─── Defaults ─────────────────────────────────────────────────────

function defaultConfig() {
  return {
    cooldownSec:      60,
    proximityZonePct: 0.5,
    touchZonePct:     0.05,
    minConfidence:    70,
    minImpulseScore:  100,
    minInPlayScore:   100,
  };
}

function defaultAlertOptions() {
  return {
    earlyWarningEnabled:          true,
    warnBeforeSeconds:            null,
    warnBeforeDistancePct:        null,
    warnOnApproachSpeedChange:    true,
    warnOnVolumeChange:           true,
    warnOnTradesChange:           true,
    warnOnWallChange:             true,
    minApproachSpeed:             null,
    minVolumeDeltaPct:            null,
    minTradesDeltaPct:            null,
    minWallStrength:              null,
    popupEnabled:                 true,
    telegramEnabled:              false,
    popupPriority:                'normal',
    telegramPriority:             'high',
    soundEnabled:                 true,
    soundId:                      'default_alert',
    soundGroup:                   'standard',
  };
}

// ─── Factory ──────────────────────────────────────────────────────

function createUnifiedWatchLevelsLoader(db) {
  let cache     = null;
  let cacheTime = 0;

  async function loadFromDb() {
    const [rows] = await db.query(`
      SELECT
        l.*,
        wc.id              AS wc_id,
        wc.watch_enabled,
        wc.watch_mode,
        wc.tactic_breakout,
        wc.tactic_bounce,
        wc.tactic_fakeout,
        wc.tactic_wall_bounce,
        wc.tactic_wall_breakout,
        wc.cooldown_sec,
        wc.proximity_zone_pct,
        wc.touch_zone_pct,
        wc.min_confidence,
        wc.min_impulse_score,
        wc.min_in_play_score,
        ao.id              AS ao_id,
        ao.early_warning_enabled,
        ao.warn_before_seconds,
        ao.warn_before_distance_pct,
        ao.warn_on_approach_speed_change,
        ao.warn_on_volume_change,
        ao.warn_on_trades_change,
        ao.warn_on_wall_change,
        ao.min_approach_speed,
        ao.min_volume_delta_pct,
        ao.min_trades_delta_pct,
        ao.min_wall_strength,
        ao.popup_enabled,
        ao.telegram_enabled,
        ao.popup_priority,
        ao.telegram_priority,
        ao.sound_enabled,
        ao.sound_id,
        ao.sound_group
      FROM levels l
      JOIN level_watch_configs wc
        ON wc.level_id = l.id AND wc.watch_enabled = TRUE
      LEFT JOIN level_alert_options ao
        ON ao.level_id = l.id
      WHERE l.is_active = TRUE
        AND l.watch_enabled = TRUE
    `);
    return rows.map(normalizeDbLevel);
  }

  function loadFromFiles() {
    const result = [];

    // tracked-levels with alertEnabled
    const tracked = readTrackedLevels().filter(tl => tl.alertEnabled);
    for (const tl of tracked) {
      if (!tl.price || isNaN(parseFloat(tl.price))) continue;
      result.push(normalizeTrackedLevel(tl));
    }

    // manual-levels with alertEnabled
    const manual = readManualLevels().filter(ml => ml.alertEnabled);
    for (const ml of manual) {
      if (!ml.price || isNaN(parseFloat(ml.price))) continue;
      result.push(normalizeManualLevel(ml));
    }

    return result;
  }

  /**
   * Returns a deduplicated list of watchable NormalizedWatchLevel objects.
   * Results are cached for CACHE_TTL_MS.
   */
  async function load() {
    const now = Date.now();
    if (cache && now - cacheTime < CACHE_TTL_MS) return cache;

    let levels = [];
    try {
      const dbLevels = await loadFromDb();
      levels.push(...dbLevels);
    } catch (err) {
      // Table may not exist yet on first startup before migrations complete
      if (!(err.code === 'ER_NO_SUCH_TABLE' || err.message.includes('level_watch_configs'))) {
        console.error('[watchLevels] DB load error:', err.message);
      }
    }

    try {
      const fileLevels = loadFromFiles();
      // Deduplicate: if a file-level has same symbol+price as a DB level, skip
      const dbKeys = new Set(levels.map(l => `${l.symbol}:${l.market}:${l.price}`));
      for (const fl of fileLevels) {
        const key = `${fl.symbol}:${fl.market}:${fl.price}`;
        if (!dbKeys.has(key)) levels.push(fl);
      }
    } catch (err) {
      console.error('[watchLevels] file load error:', err.message);
    }

    cache     = levels;
    cacheTime = now;
    return levels;
  }

  /** Invalidate the in-memory cache (call after watch config changes). */
  function invalidate() {
    cache     = null;
    cacheTime = 0;
  }

  return { load, invalidate };
}

module.exports = {
  createUnifiedWatchLevelsLoader,
  normalizeDbLevel,
  defaultConfig,
  defaultAlertOptions,
};
