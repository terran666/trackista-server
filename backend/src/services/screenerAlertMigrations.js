'use strict';

/**
 * screenerAlertMigrations.js
 * ─────────────────────────────────────────────────────────────────
 * Idempotent migrations for the Screener Alert Engine module.
 *
 * Creates:
 *   - screener_alert_settings  (per-user growth/drop alert config)
 *
 * Safe to run on every startup.
 */

const CREATE_SCREENER_ALERT_SETTINGS = `
CREATE TABLE IF NOT EXISTS screener_alert_settings (
  id                          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id                     BIGINT UNSIGNED NOT NULL,
  -- Growth alert
  growth_enabled              TINYINT(1)      NOT NULL DEFAULT 0,
  growth_timeframe            VARCHAR(10)     NOT NULL DEFAULT '15m',
  growth_percent_threshold    DECIMAL(10,2)   NOT NULL DEFAULT 5.00,
  growth_volume_filter_enabled TINYINT(1)     NOT NULL DEFAULT 0,
  growth_min_volume_usdt      DECIMAL(20,2)   NOT NULL DEFAULT 0,
  growth_cooldown_minutes     INT             NOT NULL DEFAULT 15,
  -- Drop alert
  drop_enabled                TINYINT(1)      NOT NULL DEFAULT 0,
  drop_timeframe              VARCHAR(10)     NOT NULL DEFAULT '15m',
  drop_percent_threshold      DECIMAL(10,2)   NOT NULL DEFAULT 5.00,
  drop_volume_filter_enabled  TINYINT(1)      NOT NULL DEFAULT 0,
  drop_min_volume_usdt        DECIMAL(20,2)   NOT NULL DEFAULT 0,
  drop_cooldown_minutes       INT             NOT NULL DEFAULT 15,
  -- Timestamps
  created_at                  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  -- Constraints
  UNIQUE KEY uq_screener_alert_settings_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

async function runScreenerAlertMigrations(db) {
  console.log('[screenerAlertMigrations] Running migrations...');
  try {
    await db.query(CREATE_SCREENER_ALERT_SETTINGS);
    console.log('[screenerAlertMigrations] screener_alert_settings table ensured.');
  } catch (err) {
    console.error('[screenerAlertMigrations] Failed:', err.message);
    throw err;
  }
}

module.exports = { runScreenerAlertMigrations };
