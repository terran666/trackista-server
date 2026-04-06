'use strict';

/**
 * levelWatchRoute.js
 * ─────────────────────────────────────────────────────────────────
 * Routes for Level Watch Engine config and state.
 *
 * PATCH /api/levels/:id/watch          — set/update watch config + alert options
 * GET   /api/levels/:id/watch          — get watch config + alert options
 * GET   /api/levels/:id/watch-state    — get current runtime state from Redis
 * GET   /api/levels/:id/events         — paginated event history from MySQL
 * GET   /api/levels/watch-states/active — all currently active watch states (bulk)
 */

const manualLevelsStore    = require('../services/manualLevelsStore');
const trackedLevelsStore   = require('../services/trackedLevelsStore');
const savedRaysStore       = require('../services/savedRaysStore');
const trackedExtremesStore = require('../services/trackedExtremesStore');
const manualSlopedLevelsStore = require('../services/manualSlopedLevelsStore');

const VALID_WATCH_MODES = new Set(['off', 'simple', 'tactic']);
const VALID_POPUP_PRIO  = new Set(['low', 'normal', 'high', 'urgent']);
const VALID_TG_PRIO     = new Set(['low', 'normal', 'high']);
const VALID_SOUNDS      = new Set([
  'default_alert', 'soft_ping', 'breakout_high', 'bounce_soft',
  'fakeout_warning', 'wall_alert', 'urgent_alarm',
]);

// ─── Sanitise & validate watch body ──────────────────────────────

function parseWatchBody(body) {
  const errors = [];

  const { watchEnabled, watchMode, tactics, alertOptions } = body;

  if (watchEnabled !== undefined && typeof watchEnabled !== 'boolean') {
    errors.push('watchEnabled must be a boolean');
  }

  if (watchMode !== undefined && !VALID_WATCH_MODES.has(watchMode)) {
    errors.push(`watchMode must be one of: ${[...VALID_WATCH_MODES].join(', ')}`);
  }

  if (tactics !== undefined && typeof tactics !== 'object') {
    errors.push('tactics must be an object');
  }

  if (alertOptions !== undefined && typeof alertOptions !== 'object') {
    errors.push('alertOptions must be an object');
  } else if (alertOptions) {
    const ao = alertOptions;
    if (ao.popupPriority !== undefined && !VALID_POPUP_PRIO.has(ao.popupPriority)) {
      errors.push(`alertOptions.popupPriority must be one of: ${[...VALID_POPUP_PRIO].join(', ')}`);
    }
    if (ao.telegramPriority !== undefined && !VALID_TG_PRIO.has(ao.telegramPriority)) {
      errors.push(`alertOptions.telegramPriority must be one of: ${[...VALID_TG_PRIO].join(', ')}`);
    }
    if (ao.soundId !== undefined && !VALID_SOUNDS.has(ao.soundId)) {
      errors.push(`alertOptions.soundId must be one of: ${[...VALID_SOUNDS].join(', ')}`);
    }
    if (ao.notificationEnabled !== undefined && typeof ao.notificationEnabled !== 'boolean') {
      errors.push('alertOptions.notificationEnabled must be a boolean');
    }
    if (ao.warnBeforeSeconds !== undefined && ao.warnBeforeSeconds !== null) {
      if (!Number.isInteger(ao.warnBeforeSeconds) || ao.warnBeforeSeconds <= 0) {
        errors.push('alertOptions.warnBeforeSeconds must be a positive integer');
      }
    }
    if (ao.warnBeforeDistancePct !== undefined && ao.warnBeforeDistancePct !== null) {
      const v = Number(ao.warnBeforeDistancePct);
      if (isNaN(v) || v <= 0) {
        errors.push('alertOptions.warnBeforeDistancePct must be a positive number');
      }
    }
  }

  return errors;
}

// ─── Factory ──────────────────────────────────────────────────────

function createLevelWatchRouter(db, redis, watchLoader) {
  const express = require('express');
  const router  = express.Router();

  // ── GET /api/levels/watch-states/active ─────────────────────
  // Returns all currently active levelwatchstate entries from Redis.
  // Uses SCAN so it never blocks (unlike KEYS).
  // Phases considered "active": approaching, precontact, contact, crossed.
  // Query params:
  //   ?symbol=BTCUSDT   — filter by symbol (optional)
  //   ?phase=contact    — filter by phase  (optional, comma-separated)
  //   ?includeWatching=1 — also return 'watching' phase (default: off)
  router.get('/watch-states/active', async (req, res) => {
    const symbolFilter  = req.query.symbol  ? req.query.symbol.toUpperCase()   : null;
    const phaseFilter   = req.query.phase   ? new Set(req.query.phase.split(',')) : null;
    const inclWatching  = req.query.includeWatching === '1';

    // Active phases (exclude 'watching' unless requested)
    const ACTIVE_PHASES = new Set(['approaching', 'precontact', 'contact', 'crossed']);
    if (inclWatching) ACTIVE_PHASES.add('watching');

    try {
      const states    = [];
      const pattern   = symbolFilter
        ? `levelwatchstate:*:${symbolFilter}:*`
        : 'levelwatchstate:*';

      // SCAN in batches of 200 — non-blocking on large keyspaces
      let cursor = '0';
      do {
        const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
        cursor = nextCursor;
        if (keys.length === 0) continue;

        const pipeline = redis.pipeline();
        for (const k of keys) pipeline.get(k);
        const results = await pipeline.exec();

        for (const [, raw] of results) {
          if (!raw) continue;
          let s;
          try { s = JSON.parse(raw); } catch (_) { continue; }
          if (!s || !s.phase) continue;
          if (!ACTIVE_PHASES.has(s.phase)) continue;
          if (phaseFilter && !phaseFilter.has(s.phase)) continue;

          // Return a lightweight summary — not the full state object
          states.push({
            internalId:   s.internalId,
            symbol:       s.symbol,
            market:       s.market,
            phase:        s.phase,
            popupStatus:  s.popup?.status ?? null,
            popupTitle:   s.popupTitleKey ?? null,
            levelPrice:   s.levelPrice    ?? null,
            currentPrice: s.currentPrice  ?? null,
            distancePct:  s.absDistancePct ?? null,
            etaSeconds:   s.etaSeconds     ?? null,
            touchDetected:    s.touchDetected    ?? false,
            crossDetectedRaw: s.crossDetectedRaw ?? false,
            crossConfirmed:   s.crossConfirmed   ?? false,
            scenarioLeading:  s.scenarioLeading  ?? null,
            updatedAt:    s.updatedAt ?? null,
          });
        }
      } while (cursor !== '0');

      // Sort: crossed first, then contact, precontact, approaching
      const phaseOrder = { crossed: 0, contact: 1, precontact: 2, approaching: 3, watching: 4 };
      states.sort((a, b) => (phaseOrder[a.phase] ?? 9) - (phaseOrder[b.phase] ?? 9));

      return res.json({
        success: true,
        count:   states.length,
        states,
      });
    } catch (err) {
      console.error('[levelWatch] GET watch-states/active error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ── PATCH /api/levels/:id/watch ─────────────────────────────
  router.patch('/:id/watch', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid level id' });
    }

    const errors = parseWatchBody(req.body);
    if (errors.length > 0) {
      return res.status(400).json({ success: false, errors });
    }

    const { watchEnabled, watchMode, tactics, alertOptions } = req.body;
    const userId = req.user?.id ?? null;

    try {
      // Verify level exists — fall back to manual-levels.json if not in MySQL
      const [[level]] = await db.query('SELECT id, symbol, market FROM levels WHERE id = ?', [id]);
      if (!level) {
        const ml = manualLevelsStore.getById(id);
        if (ml) {
          if (userId && ml.userId && ml.userId !== userId) {
            return res.status(403).json({ success: false, error: 'Forbidden' });
          }
          const updates = {};
          if (watchEnabled !== undefined) updates.alertEnabled = watchEnabled;
          if (watchMode    !== undefined) updates.watchMode    = watchMode;
          if (alertOptions)               updates.alertOptions = { ...(ml.alertOptions || {}), ...alertOptions };
          manualLevelsStore.patch(id, updates, userId);
          if (watchLoader) watchLoader.invalidate();
          return res.json({ success: true, levelId: id });
        }

        const tl = trackedLevelsStore.getById(id);
        if (tl) {
          if (userId && tl.userId && tl.userId !== userId) {
            return res.status(403).json({ success: false, error: 'Forbidden' });
          }
          const updates = {};
          if (watchEnabled !== undefined) updates.alertEnabled = watchEnabled;
          if (watchMode    !== undefined) updates.watchMode    = watchMode;
          if (alertOptions)               updates.alertOptions = { ...(tl.alertOptions || {}), ...alertOptions };
          trackedLevelsStore.patchOne(id, updates, userId);
          if (watchLoader) watchLoader.invalidate();
          return res.json({ success: true, levelId: id });
        }

        const sr = savedRaysStore.getById(id);
        if (sr) {
          if (userId && sr.userId && sr.userId !== userId) {
            return res.status(403).json({ success: false, error: 'Forbidden' });
          }
          const updates = {};
          if (watchEnabled !== undefined) updates.alertEnabled = watchEnabled;
          if (watchMode    !== undefined) updates.watchMode    = watchMode;
          if (alertOptions)               updates.alertOptions = { ...(sr.alertOptions || {}), ...alertOptions };
          savedRaysStore.patchOne(id, updates, userId);
          if (watchLoader) watchLoader.invalidate();
          return res.json({ success: true, levelId: id });
        }

        const ex = trackedExtremesStore.getById(id);
        if (ex) {
          if (userId && ex.userId && ex.userId !== userId) {
            return res.status(403).json({ success: false, error: 'Forbidden' });
          }
          const updates = {};
          if (watchEnabled !== undefined) updates.alertEnabled = watchEnabled;
          if (watchMode    !== undefined) updates.watchMode    = watchMode;
          if (alertOptions)               updates.alertOptions = { ...(ex.alertOptions || {}), ...alertOptions };
          trackedExtremesStore.patchOne(id, updates, userId);
          if (watchLoader) watchLoader.invalidate();
          return res.json({ success: true, levelId: id });
        }

        const sl = manualSlopedLevelsStore.getById(id);
        if (sl) {
          if (userId && sl.userId && sl.userId !== userId) {
            return res.status(403).json({ success: false, error: 'Forbidden' });
          }
          const updates = {};
          if (watchEnabled !== undefined) updates.alertEnabled = watchEnabled;
          if (watchMode    !== undefined) updates.watchMode    = watchMode;
          if (alertOptions)               updates.alertOptions = { ...(sl.alertOptions || {}), ...alertOptions };
          manualSlopedLevelsStore.patch(id, updates);
          if (watchLoader) watchLoader.invalidate();
          return res.json({ success: true, levelId: id });
        }

        return res.status(404).json({ success: false, error: 'Level not found' });
      }

      const conn = await db.getConnection();
      try {
        await conn.beginTransaction();

        // ── Update levels table flags ────────────────────────
        const lvlUpdates = {};
        if (watchEnabled !== undefined) {
          lvlUpdates.watch_enabled = watchEnabled ? 1 : 0;
          lvlUpdates.watch_mode    = watchEnabled ? (watchMode || 'simple') : 'off';
        }
        if (watchMode !== undefined) {
          lvlUpdates.watch_mode = watchMode;
        }
        if (tactics !== undefined) {
          lvlUpdates.watch_tactics_json = JSON.stringify(tactics);
        }
        if (Object.keys(lvlUpdates).length > 0) {
          const setClauses = Object.keys(lvlUpdates).map(k => `\`${k}\` = ?`).join(', ');
          await conn.query(`UPDATE levels SET ${setClauses} WHERE id = ?`, [...Object.values(lvlUpdates), id]);
        }

        // ── Upsert level_watch_configs ───────────────────────
        if (watchEnabled !== undefined || watchMode !== undefined || tactics !== undefined) {
          const effectiveMode    = watchMode || (watchEnabled ? 'simple' : 'off');
          const effectiveEnabled = watchEnabled !== undefined ? watchEnabled : true;

          const tac  = tactics || {};
          const [[existing]] = await conn.query(
            'SELECT id FROM level_watch_configs WHERE level_id = ?',
            [id],
          );

          if (existing) {
            await conn.query(`
              UPDATE level_watch_configs
              SET watch_enabled = ?, watch_mode = ?,
                  tactic_breakout = ?, tactic_bounce = ?, tactic_fakeout = ?,
                  tactic_wall_bounce = ?, tactic_wall_breakout = ?
              WHERE level_id = ?
            `, [
              effectiveEnabled ? 1 : 0,
              effectiveMode,
              tac.breakout    ? 1 : 0,
              tac.bounce      ? 1 : 0,
              tac.fakeout     ? 1 : 0,
              tac.wallBounce  ? 1 : 0,
              tac.wallBreakout ? 1 : 0,
              id,
            ]);
          } else {
            await conn.query(`
              INSERT INTO level_watch_configs
                (level_id, symbol, market, watch_enabled, watch_mode,
                 tactic_breakout, tactic_bounce, tactic_fakeout,
                 tactic_wall_bounce, tactic_wall_breakout)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
              id,
              level.symbol,
              level.market || 'futures',
              effectiveEnabled ? 1 : 0,
              effectiveMode,
              tac.breakout     ? 1 : 0,
              tac.bounce       ? 1 : 0,
              tac.fakeout      ? 1 : 0,
              tac.wallBounce   ? 1 : 0,
              tac.wallBreakout ? 1 : 0,
            ]);
          }
        }

        // ── Upsert level_alert_options ───────────────────────
        if (alertOptions) {
          const ao = alertOptions;
          const [[existingAO]] = await conn.query(
            'SELECT id FROM level_alert_options WHERE level_id = ?',
            [id],
          );

          const aoFields = {
            early_warning_enabled:          ao.earlyWarningEnabled          !== undefined ? (ao.earlyWarningEnabled ? 1 : 0) : undefined,
            warn_before_seconds:            ao.warnBeforeSeconds            !== undefined ? ao.warnBeforeSeconds            : undefined,
            warn_before_distance_pct:       ao.warnBeforeDistancePct        !== undefined ? ao.warnBeforeDistancePct        : undefined,
            warn_on_approach_speed_change:  ao.warnOnApproachSpeedChange    !== undefined ? (ao.warnOnApproachSpeedChange ? 1 : 0) : undefined,
            warn_on_volume_change:          ao.warnOnVolumeChange           !== undefined ? (ao.warnOnVolumeChange ? 1 : 0)       : undefined,
            warn_on_trades_change:          ao.warnOnTradesChange           !== undefined ? (ao.warnOnTradesChange ? 1 : 0)       : undefined,
            warn_on_wall_change:            ao.warnOnWallChange             !== undefined ? (ao.warnOnWallChange ? 1 : 0)         : undefined,
            min_approach_speed:             ao.minApproachSpeed             !== undefined ? ao.minApproachSpeed                  : undefined,
            min_volume_delta_pct:           ao.minVolumeDeltaPct            !== undefined ? ao.minVolumeDeltaPct                 : undefined,
            min_trades_delta_pct:           ao.minTradesDeltaPct            !== undefined ? ao.minTradesDeltaPct                 : undefined,
            min_wall_strength:              ao.minWallStrength              !== undefined ? ao.minWallStrength                   : undefined,
            popup_enabled:                  ao.popupEnabled                 !== undefined ? (ao.popupEnabled ? 1 : 0)            : undefined,
            telegram_enabled:               ao.telegramEnabled              !== undefined ? (ao.telegramEnabled ? 1 : 0)          : undefined,
            popup_priority:                 ao.popupPriority                !== undefined ? ao.popupPriority                     : undefined,
            telegram_priority:              ao.telegramPriority             !== undefined ? ao.telegramPriority                  : undefined,
            sound_enabled:                  ao.soundEnabled                 !== undefined ? (ao.soundEnabled ? 1 : 0)            : undefined,
            sound_id:                       ao.soundId                      !== undefined ? ao.soundId                           : undefined,
            sound_group:                    ao.soundGroup                   !== undefined ? ao.soundGroup                        : undefined,            notification_enabled:           ao.notificationEnabled          !== undefined ? (ao.notificationEnabled ? 1 : 0)        : undefined,          };

          // Filter out undefined values
          const definedFields = Object.fromEntries(
            Object.entries(aoFields).filter(([, v]) => v !== undefined),
          );

          if (existingAO) {
            if (Object.keys(definedFields).length > 0) {
              const setClauses = Object.keys(definedFields).map(k => `\`${k}\` = ?`).join(', ');
              await conn.query(
                `UPDATE level_alert_options SET ${setClauses} WHERE level_id = ?`,
                [...Object.values(definedFields), id],
              );
            }
          } else {
            await conn.query(`
              INSERT INTO level_alert_options
                (level_id, symbol, market${Object.keys(definedFields).length > 0 ? ', ' + Object.keys(definedFields).join(', ') : ''})
              VALUES (?, ?, ?${Object.keys(definedFields).length > 0 ? ', ' + Object.keys(definedFields).map(() => '?').join(', ') : ''})
            `, [id, level.symbol, level.market || 'futures', ...Object.values(definedFields)]);
          }
        }

        await conn.commit();
      } catch (err) {
        await conn.rollback();
        throw err;
      } finally {
        conn.release();
      }

      // Flush loader cache so watch engine sees changes on next tick
      if (watchLoader) watchLoader.invalidate();

      return res.json({ success: true, levelId: id });
    } catch (err) {
      console.error('[levelWatch] PATCH watch error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ── GET /api/levels/:id/watch ───────────────────────────────
  router.get('/:id/watch', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid level id' });
    }

    try {
      const [[level]] = await db.query(
        'SELECT id, symbol, market, watch_enabled, watch_mode, watch_tactics_json FROM levels WHERE id = ?',
        [id],
      );
      if (!level) {
        const ml = manualLevelsStore.getById(id);
        if (ml) {
          const userId = req.user?.id ?? null;
          if (userId && ml.userId && ml.userId !== userId) {
            return res.status(403).json({ success: false, error: 'Forbidden' });
          }
          const ao = ml.alertOptions || {};
          return res.json({
            success:         true,
            levelId:         id,
            watchEnabled:    Boolean(ml.alertEnabled),
            watchMode:       ml.watchMode || 'simple',
            tactics:         null,
            displayScope:    ao.displayScope   ?? 'tab',
            telegramEnabled: ao.telegramEnabled ?? false,
            alertOptions:    ao,
          });
        }

        const tl = trackedLevelsStore.getById(id);
        if (tl) {
          const ao = tl.alertOptions || {};
          return res.json({
            success:         true,
            levelId:         id,
            watchEnabled:    Boolean(tl.alertEnabled),
            watchMode:       tl.watchMode || 'simple',
            tactics:         null,
            displayScope:    ao.displayScope   ?? 'tab',
            telegramEnabled: ao.telegramEnabled ?? false,
            alertOptions:    ao,
          });
        }

        const sr = savedRaysStore.getById(id);
        if (sr) {
          const ao = sr.alertOptions || {};
          return res.json({
            success:         true,
            levelId:         id,
            watchEnabled:    Boolean(sr.alertEnabled),
            watchMode:       sr.watchMode || 'simple',
            tactics:         null,
            displayScope:    ao.displayScope   ?? 'tab',
            telegramEnabled: ao.telegramEnabled ?? false,
            alertOptions:    ao,
          });
        }

        const ex = trackedExtremesStore.getById(id);
        if (ex) {
          const ao = ex.alertOptions || {};
          return res.json({
            success:         true,
            levelId:         id,
            watchEnabled:    Boolean(ex.alertEnabled),
            watchMode:       ex.watchMode || 'simple',
            tactics:         null,
            displayScope:    ao.displayScope   ?? 'tab',
            telegramEnabled: ao.telegramEnabled ?? false,
            alertOptions:    ao,
          });
        }

        return res.status(404).json({ success: false, error: 'Level not found' });
      }

      const [[wc]] = await db.query(
        'SELECT * FROM level_watch_configs WHERE level_id = ?',
        [id],
      );

      const [[ao]] = await db.query(
        'SELECT * FROM level_alert_options WHERE level_id = ?',
        [id],
      );

      const tactics = wc ? {
        breakout:    Boolean(wc.tactic_breakout),
        bounce:      Boolean(wc.tactic_bounce),
        fakeout:     Boolean(wc.tactic_fakeout),
        wallBounce:  Boolean(wc.tactic_wall_bounce),
        wallBreakout: Boolean(wc.tactic_wall_breakout),
      } : { breakout: false, bounce: false, fakeout: false, wallBounce: false, wallBreakout: false };

      const alertOptions = ao ? {
        earlyWarningEnabled:          Boolean(ao.early_warning_enabled),
        warnBeforeSeconds:            ao.warn_before_seconds     ?? null,
        warnBeforeDistancePct:        ao.warn_before_distance_pct != null ? parseFloat(ao.warn_before_distance_pct) : null,
        warnOnApproachSpeedChange:    Boolean(ao.warn_on_approach_speed_change),
        warnOnVolumeChange:           Boolean(ao.warn_on_volume_change),
        warnOnTradesChange:           Boolean(ao.warn_on_trades_change),
        warnOnWallChange:             Boolean(ao.warn_on_wall_change),
        minApproachSpeed:             ao.min_approach_speed    != null ? parseFloat(ao.min_approach_speed)   : null,
        minVolumeDeltaPct:            ao.min_volume_delta_pct  != null ? parseFloat(ao.min_volume_delta_pct) : null,
        minTradesDeltaPct:            ao.min_trades_delta_pct  != null ? parseFloat(ao.min_trades_delta_pct) : null,
        minWallStrength:              ao.min_wall_strength     != null ? parseFloat(ao.min_wall_strength)    : null,
        popupEnabled:                 Boolean(ao.popup_enabled),
        telegramEnabled:              Boolean(ao.telegram_enabled),
        popupPriority:                ao.popup_priority    || 'normal',
        telegramPriority:             ao.telegram_priority || 'high',
        soundEnabled:                 Boolean(ao.sound_enabled),
        soundId:                      ao.sound_id    || 'default_alert',
        soundGroup:                   ao.sound_group || 'standard',
        notificationEnabled:          Boolean(ao.notification_enabled),
      } : null;

      return res.json({
        success:        true,
        levelId:        level.id,
        watchEnabled:   Boolean(level.watch_enabled),
        watchMode:      level.watch_mode || 'off',
        tactics,
        alertOptions,
      });
    } catch (err) {
      console.error('[levelWatch] GET watch error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ── GET /api/levels/:id/watch-state ─────────────────────────
  router.get('/:id/watch-state', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid level id' });
    }

    try {
      const [[level]] = await db.query(
        'SELECT id, symbol, market, watch_enabled, watch_mode, last_triggered_at, trigger_count FROM levels WHERE id = ?',
        [id],
      );
      if (!level) {
        const ml = manualLevelsStore.getById(id);
        if (ml) {
          const market = ml.marketType || 'futures';
          const key    = `levelwatchstate:${market}:${ml.symbol}:manual-${id}`;
          const raw    = await redis.get(key);
          let   state  = null;
          if (raw) { try { state = JSON.parse(raw); } catch (_) {} }
          return res.json({
            success:         true,
            levelId:         id,
            symbol:          ml.symbol,
            watchEnabled:    Boolean(ml.alertEnabled),
            watchMode:       ml.watchMode || 'simple',
            lastTriggeredAt: null,
            triggerCount:    0,
            state,
          });
        }

        const tl = trackedLevelsStore.getById(id);
        if (tl) {
          const market = tl.marketType || 'futures';
          const key    = `levelwatchstate:${market}:${tl.symbol}:tracked-${id}`;
          const raw    = await redis.get(key);
          let   state  = null;
          if (raw) { try { state = JSON.parse(raw); } catch (_) {} }
          return res.json({
            success:         true,
            levelId:         id,
            symbol:          tl.symbol,
            watchEnabled:    Boolean(tl.alertEnabled),
            watchMode:       tl.watchMode || 'simple',
            lastTriggeredAt: null,
            triggerCount:    0,
            state,
          });
        }

        const sr = savedRaysStore.getById(id);
        if (sr) {
          const market = sr.marketType || 'futures';
          const key    = `levelwatchstate:${market}:${sr.symbol}:sray-${id}`;
          const raw    = await redis.get(key);
          let   state  = null;
          if (raw) { try { state = JSON.parse(raw); } catch (_) {} }
          return res.json({
            success:         true,
            levelId:         id,
            symbol:          sr.symbol,
            watchEnabled:    Boolean(sr.alertEnabled),
            watchMode:       sr.watchMode || 'simple',
            lastTriggeredAt: null,
            triggerCount:    0,
            state,
          });
        }

        const ex = trackedExtremesStore.getById(id);
        if (ex) {
          const market = ex.marketType || 'futures';
          const key    = `levelwatchstate:${market}:${ex.symbol}:extreme-${id}`;
          const raw    = await redis.get(key);
          let   state  = null;
          if (raw) { try { state = JSON.parse(raw); } catch (_) {} }
          return res.json({
            success:         true,
            levelId:         id,
            symbol:          ex.symbol,
            watchEnabled:    Boolean(ex.alertEnabled),
            watchMode:       ex.watchMode || 'simple',
            lastTriggeredAt: null,
            triggerCount:    0,
            state,
          });
        }

        const sl = manualSlopedLevelsStore.getById(id);
        if (sl) {
          const market = sl.marketType || 'futures';
          const key    = `levelwatchstate:${market}:${sl.symbol}:sloped-${id}`;
          const raw    = await redis.get(key);
          let   state  = null;
          if (raw) { try { state = JSON.parse(raw); } catch (_) {} }
          return res.json({
            success:         true,
            levelId:         id,
            symbol:          sl.symbol,
            watchEnabled:    Boolean(sl.alertEnabled),
            watchMode:       sl.watchMode || 'simple',
            lastTriggeredAt: null,
            triggerCount:    0,
            state,
          });
        }

        return res.status(404).json({ success: false, error: 'Level not found' });
      }

      if (!level.watch_enabled) {
        return res.json({
          success:      true,
          levelId:      id,
          watchEnabled: false,
          watchMode:    'off',
          state:        null,
        });
      }

      // Find watch state in Redis — try all markets
      const markets     = [level.market || 'futures', 'spot'];
      const internalIds = [`db-${id}`];
      let   state       = null;

      for (const mkt of markets) {
        for (const iid of internalIds) {
          const key = `levelwatchstate:${mkt}:${level.symbol}:${iid}`;
          const raw = await redis.get(key);
          if (raw) {
            try { state = JSON.parse(raw); break; } catch (_) {}
          }
        }
        if (state) break;
      }

      return res.json({
        success:          true,
        levelId:          id,
        symbol:           level.symbol,
        watchEnabled:     Boolean(level.watch_enabled),
        watchMode:        level.watch_mode || 'off',
        lastTriggeredAt:  level.last_triggered_at ?? null,
        triggerCount:     level.trigger_count ?? 0,
        state,
      });
    } catch (err) {
      console.error('[levelWatch] GET watch-state error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  // ── GET /api/levels/:id/events ───────────────────────────────
  router.get('/:id/events', async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid level id' });
    }

    const limit  = Math.max(1, Math.min(parseInt(req.query.limit  || '50', 10) || 50, 500));
    const cursor = parseInt(req.query.cursor || '0', 10); // last seen id (pagination)

    try {
      const [[level]] = await db.query('SELECT id FROM levels WHERE id = ?', [id]);
      if (!level) {
        return res.status(404).json({ success: false, error: 'Level not found' });
      }

      const conditions = ['level_id = ?'];
      const params     = [id];

      if (cursor > 0) {
        conditions.push('id < ?');
        params.push(cursor);
      }

      params.push(limit);

      const [rows] = await db.query(
        `SELECT * FROM level_events WHERE ${conditions.join(' AND ')} ORDER BY id DESC LIMIT ?`,
        params,
      );

      const nextCursor = rows.length === limit ? rows[rows.length - 1].id : null;

      return res.json({
        success:    true,
        levelId:    id,
        count:      rows.length,
        nextCursor,
        items:      rows.map(rowToEvent),
      });
    } catch (err) {
      console.error('[levelWatch] GET events error:', err.message);
      return res.status(500).json({ success: false, error: 'Internal server error' });
    }
  });

  return router;
}

// ─── Row mapper ───────────────────────────────────────────────────

function rowToEvent(row) {
  return {
    id:                   row.id,
    levelId:              row.level_id,
    externalLevelId:      row.external_level_id,
    symbol:               row.symbol,
    market:               row.market,
    timeframe:            row.timeframe,
    source:               row.source,
    geometryType:         row.geometry_type,
    eventType:            row.event_type,
    phase:                row.phase,
    tactic:               row.tactic,
    levelPrice:           row.level_price     != null ? parseFloat(row.level_price)     : null,
    currentPrice:         row.current_price   != null ? parseFloat(row.current_price)   : null,
    distancePct:          row.distance_pct    != null ? parseFloat(row.distance_pct)    : null,
    approachSpeed:        row.approach_speed  != null ? parseFloat(row.approach_speed)  : null,
    approachAcceleration: row.approach_acceleration != null ? parseFloat(row.approach_acceleration) : null,
    volumeDeltaPct:       row.volume_delta_pct != null ? parseFloat(row.volume_delta_pct) : null,
    tradesDeltaPct:       row.trades_delta_pct != null ? parseFloat(row.trades_delta_pct) : null,
    impulseScore:         row.impulse_score   != null ? parseFloat(row.impulse_score)   : null,
    inPlayScore:          row.in_play_score   != null ? parseFloat(row.in_play_score)   : null,
    confidenceScore:      row.confidence_score != null ? parseFloat(row.confidence_score) : null,
    wallNearby:           Boolean(row.wall_nearby),
    wallStrength:         row.wall_strength != null ? parseFloat(row.wall_strength) : null,
    wallChange:           row.wall_change,
    confirmed:            Boolean(row.confirmed),
    severity:             row.severity,
    message:              row.message,
    payload:              row.payload_json
      ? (typeof row.payload_json === 'string' ? (() => { try { return JSON.parse(row.payload_json); } catch (_) { return null; } })() : row.payload_json)
      : null,
    occurredAt:           row.occurred_at,
    createdAt:            row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

module.exports = { createLevelWatchRouter, rowToEvent };
