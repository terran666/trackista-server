'use strict';

/**
 * screenerAlertSettingsService.js
 * ─────────────────────────────────────────────────────────────────
 * MySQL CRUD for per-user screener alert settings.
 *
 * Settings table: screener_alert_settings
 */

const VALID_TIMEFRAMES = new Set(['1m', '5m', '15m', '30m', '1h', '4h', '24h']);

const DEFAULT_SETTINGS = {
  growth: {
    enabled:             false,
    timeframe:           '15m',
    percentThreshold:    5,
    volumeFilterEnabled: false,
    minVolumeUsdt:       0,
    cooldownMinutes:     15,
  },
  drop: {
    enabled:             false,
    timeframe:           '15m',
    percentThreshold:    5,
    volumeFilterEnabled: false,
    minVolumeUsdt:       0,
    cooldownMinutes:     15,
  },
};

/**
 * Convert a DB row to the camelCase settings response shape.
 */
function rowToSettings(row) {
  return {
    growth: {
      enabled:             Boolean(row.growth_enabled),
      timeframe:           row.growth_timeframe,
      percentThreshold:    parseFloat(row.growth_percent_threshold),
      volumeFilterEnabled: Boolean(row.growth_volume_filter_enabled),
      minVolumeUsdt:       parseFloat(row.growth_min_volume_usdt),
      cooldownMinutes:     parseInt(row.growth_cooldown_minutes, 10),
    },
    drop: {
      enabled:             Boolean(row.drop_enabled),
      timeframe:           row.drop_timeframe,
      percentThreshold:    parseFloat(row.drop_percent_threshold),
      volumeFilterEnabled: Boolean(row.drop_volume_filter_enabled),
      minVolumeUsdt:       parseFloat(row.drop_min_volume_usdt),
      cooldownMinutes:     parseInt(row.drop_cooldown_minutes, 10),
    },
  };
}

/**
 * Get settings for a user. Returns defaults if no row exists.
 */
async function getSettings(db, userId) {
  const [rows] = await db.query(
    'SELECT * FROM screener_alert_settings WHERE user_id = ? LIMIT 1',
    [userId],
  );
  if (rows.length === 0) return { ...DEFAULT_SETTINGS };
  return rowToSettings(rows[0]);
}

/**
 * Validate and sanitise a partial settings patch.
 * Returns { errors: string[], data: object } where data is DB-level snake_case fields.
 */
function validateAndBuildUpdate(patch) {
  const errors = [];
  const data   = {};

  function checkTimeframe(val, field) {
    if (!VALID_TIMEFRAMES.has(val)) {
      errors.push(`${field} must be one of: ${[...VALID_TIMEFRAMES].join(', ')}`);
    } else {
      data[field] = val;
    }
  }
  function checkPercent(val, field) {
    const n = parseFloat(val);
    if (isNaN(n) || n < 1 || n > 100) {
      errors.push(`${field} must be between 1 and 100`);
    } else {
      data[field] = n;
    }
  }
  function checkVolume(val, field) {
    const n = parseFloat(val);
    if (isNaN(n) || n < 0) {
      errors.push(`${field} must be >= 0`);
    } else {
      data[field] = n;
    }
  }
  function checkCooldown(val, field) {
    const n = parseInt(val, 10);
    if (isNaN(n) || n < 1 || n > 1440) {
      errors.push(`${field} must be between 1 and 1440`);
    } else {
      data[field] = n;
    }
  }

  const g = patch.growth || {};
  const d = patch.drop   || {};

  if (g.enabled             !== undefined) data.growth_enabled              = Boolean(g.enabled) ? 1 : 0;
  if (g.timeframe           !== undefined) checkTimeframe(g.timeframe,           'growth_timeframe');
  if (g.percentThreshold    !== undefined) checkPercent  (g.percentThreshold,    'growth_percent_threshold');
  if (g.volumeFilterEnabled !== undefined) data.growth_volume_filter_enabled = Boolean(g.volumeFilterEnabled) ? 1 : 0;
  if (g.minVolumeUsdt       !== undefined) checkVolume   (g.minVolumeUsdt,       'growth_min_volume_usdt');
  if (g.cooldownMinutes     !== undefined) checkCooldown (g.cooldownMinutes,     'growth_cooldown_minutes');

  if (d.enabled             !== undefined) data.drop_enabled              = Boolean(d.enabled) ? 1 : 0;
  if (d.timeframe           !== undefined) checkTimeframe(d.timeframe,           'drop_timeframe');
  if (d.percentThreshold    !== undefined) checkPercent  (d.percentThreshold,    'drop_percent_threshold');
  if (d.volumeFilterEnabled !== undefined) data.drop_volume_filter_enabled = Boolean(d.volumeFilterEnabled) ? 1 : 0;
  if (d.minVolumeUsdt       !== undefined) checkVolume   (d.minVolumeUsdt,       'drop_min_volume_usdt');
  if (d.cooldownMinutes     !== undefined) checkCooldown (d.cooldownMinutes,     'drop_cooldown_minutes');

  return { errors, data };
}

/**
 * Upsert settings for a user. Accepts a partial patch (only provided fields are updated).
 * Returns the new full settings object.
 */
async function upsertSettings(db, userId, patch) {
  const { errors, data } = validateAndBuildUpdate(patch);
  if (errors.length > 0) return { success: false, errors };
  if (Object.keys(data).length === 0) return { success: false, errors: ['No valid fields provided'] };

  // Build INSERT ... ON DUPLICATE KEY UPDATE
  const allFields = [
    'user_id',
    'growth_enabled', 'growth_timeframe', 'growth_percent_threshold',
    'growth_volume_filter_enabled', 'growth_min_volume_usdt', 'growth_cooldown_minutes',
    'drop_enabled', 'drop_timeframe', 'drop_percent_threshold',
    'drop_volume_filter_enabled', 'drop_min_volume_usdt', 'drop_cooldown_minutes',
  ];
  const defaults = {
    user_id:                      userId,
    growth_enabled:               0,
    growth_timeframe:             '15m',
    growth_percent_threshold:     5.00,
    growth_volume_filter_enabled: 0,
    growth_min_volume_usdt:       0,
    growth_cooldown_minutes:      15,
    drop_enabled:                 0,
    drop_timeframe:               '15m',
    drop_percent_threshold:       5.00,
    drop_volume_filter_enabled:   0,
    drop_min_volume_usdt:         0,
    drop_cooldown_minutes:        15,
  };
  const insertVals = allFields.map(f => (data[f] !== undefined ? data[f] : defaults[f]));

  const updateClauses = Object.keys(data)
    .filter(f => f !== 'user_id')
    .map(f => `\`${f}\` = VALUES(\`${f}\`)`);

  await db.query(
    `INSERT INTO screener_alert_settings (${allFields.map(f => `\`${f}\``).join(', ')})
     VALUES (${allFields.map(() => '?').join(', ')})
     ON DUPLICATE KEY UPDATE ${updateClauses.join(', ')}`,
    insertVals,
  );

  // Return the updated settings
  const settings = await getSettings(db, userId);
  return { success: true, settings };
}

/**
 * Return all rows with at least one alert type enabled.
 * Used by the engine to know which users to evaluate.
 */
async function getAllEnabledUsers(db) {
  const [rows] = await db.query(
    'SELECT * FROM screener_alert_settings WHERE growth_enabled = 1 OR drop_enabled = 1',
  );
  return rows;
}

module.exports = {
  getSettings,
  upsertSettings,
  getAllEnabledUsers,
  DEFAULT_SETTINGS,
  VALID_TIMEFRAMES,
};
