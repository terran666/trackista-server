'use strict';

/**
 * watchLevelsMigrations.js
 * ─────────────────────────────────────────────────────────────────
 * Idempotent migrations for the Level Watch Engine module.
 *
 * PHASE 1:
 *   - Add watch columns to `levels`
 *   - CREATE level_watch_configs
 *   - CREATE level_alert_options
 *   - CREATE level_events
 *
 * Safe to run on every startup.
 */

// ─── Helpers ──────────────────────────────────────────────────────

async function columnExists(db, table, column) {
  const [rows] = await db.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column],
  );
  return rows.length > 0;
}

async function addColumnIfMissing(db, table, column, definition) {
  const exists = await columnExists(db, table, column);
  if (!exists) {
    await db.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
    console.log(`[watchMigrations] Added column ${table}.${column}`);
  }
}

// ─── levels table: new watch/market columns ───────────────────────

async function migratelevelsTable(db) {
  const cols = [
    ['market',               'VARCHAR(16) NOT NULL DEFAULT \'futures\''],
    ['geometry_type',        'VARCHAR(16) NOT NULL DEFAULT \'horizontal\''],
    ['side',                 'VARCHAR(16) NULL'],
    ['alert_enabled',        'BOOLEAN NOT NULL DEFAULT FALSE'],
    ['watch_enabled',        'BOOLEAN NOT NULL DEFAULT FALSE'],
    ['watch_mode',           'VARCHAR(16) NOT NULL DEFAULT \'off\''],
    ['watch_tactics_json',   'JSON NULL'],
    ['last_triggered_at',    'BIGINT NULL'],
    ['trigger_count',        'INT NOT NULL DEFAULT 0'],
    ['last_watch_state_json','JSON NULL'],
  ];

  for (const [col, def] of cols) {
    await addColumnIfMissing(db, 'levels', col, def);
  }
}

// ─── level_watch_configs ──────────────────────────────────────────

const CREATE_LEVEL_WATCH_CONFIGS = `
CREATE TABLE IF NOT EXISTS level_watch_configs (
  id                    BIGINT          AUTO_INCREMENT PRIMARY KEY,
  level_id              BIGINT          NULL,
  external_level_id     VARCHAR(128)    NULL,
  symbol                VARCHAR(32)     NOT NULL,
  market                VARCHAR(16)     NOT NULL DEFAULT 'futures',
  watch_enabled         BOOLEAN         NOT NULL DEFAULT FALSE,
  watch_mode            VARCHAR(16)     NOT NULL DEFAULT 'off',
  tactic_breakout       BOOLEAN         NOT NULL DEFAULT FALSE,
  tactic_bounce         BOOLEAN         NOT NULL DEFAULT FALSE,
  tactic_fakeout        BOOLEAN         NOT NULL DEFAULT FALSE,
  tactic_wall_bounce    BOOLEAN         NOT NULL DEFAULT FALSE,
  tactic_wall_breakout  BOOLEAN         NOT NULL DEFAULT FALSE,
  cooldown_sec          INT             NOT NULL DEFAULT 60,
  proximity_zone_pct    DECIMAL(12,6)   NOT NULL DEFAULT 0.500000,
  touch_zone_pct        DECIMAL(12,6)   NOT NULL DEFAULT 0.050000,
  bar_confirm_tf        VARCHAR(16)     NOT NULL DEFAULT '1m',
  min_confidence        DECIMAL(12,4)   NOT NULL DEFAULT 70,
  min_impulse_score     DECIMAL(12,4)   NOT NULL DEFAULT 100,
  min_in_play_score     DECIMAL(12,4)   NOT NULL DEFAULT 100,
  created_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_level_watch_symbol  (symbol),
  INDEX idx_level_watch_enabled (watch_enabled),
  INDEX idx_level_watch_level_id (level_id)
) ENGINE=InnoDB
`;

// ─── level_alert_options ──────────────────────────────────────────

const CREATE_LEVEL_ALERT_OPTIONS = `
CREATE TABLE IF NOT EXISTS level_alert_options (
  id                            BIGINT          AUTO_INCREMENT PRIMARY KEY,
  level_id                      BIGINT          NULL,
  external_level_id             VARCHAR(128)    NULL,
  symbol                        VARCHAR(32)     NOT NULL,
  market                        VARCHAR(16)     NOT NULL DEFAULT 'futures',
  early_warning_enabled         BOOLEAN         NOT NULL DEFAULT TRUE,
  warn_before_seconds           INT             NULL,
  warn_before_distance_pct      DECIMAL(12,6)   NULL,
  warn_on_approach_speed_change BOOLEAN         NOT NULL DEFAULT TRUE,
  warn_on_volume_change         BOOLEAN         NOT NULL DEFAULT TRUE,
  warn_on_trades_change         BOOLEAN         NOT NULL DEFAULT TRUE,
  warn_on_wall_change           BOOLEAN         NOT NULL DEFAULT TRUE,
  min_approach_speed            DECIMAL(20,8)   NULL,
  min_volume_delta_pct          DECIMAL(12,6)   NULL,
  min_trades_delta_pct          DECIMAL(12,6)   NULL,
  min_wall_strength             DECIMAL(20,8)   NULL,
  popup_enabled                 BOOLEAN         NOT NULL DEFAULT TRUE,
  telegram_enabled              BOOLEAN         NOT NULL DEFAULT FALSE,
  popup_priority                VARCHAR(16)     NOT NULL DEFAULT 'normal',
  telegram_priority             VARCHAR(16)     NOT NULL DEFAULT 'high',
  sound_enabled                 BOOLEAN         NOT NULL DEFAULT TRUE,
  sound_id                      VARCHAR(64)     NOT NULL DEFAULT 'default_alert',
  sound_group                   VARCHAR(32)     NOT NULL DEFAULT 'standard',
  created_at                    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_level_alert_opt_symbol   (symbol),
  INDEX idx_level_alert_opt_level_id (level_id)
) ENGINE=InnoDB
`;

// ─── level_events ─────────────────────────────────────────────────

const CREATE_LEVEL_EVENTS = `
CREATE TABLE IF NOT EXISTS level_events (
  id                    BIGINT          AUTO_INCREMENT PRIMARY KEY,
  level_id              BIGINT          NULL,
  external_level_id     VARCHAR(128)    NULL,
  symbol                VARCHAR(32)     NOT NULL,
  market                VARCHAR(16)     NOT NULL DEFAULT 'futures',
  timeframe             VARCHAR(16)     NULL,
  source                VARCHAR(32)     NULL,
  geometry_type         VARCHAR(16)     NOT NULL DEFAULT 'horizontal',
  event_type            VARCHAR(32)     NOT NULL,
  phase                 VARCHAR(32)     NULL,
  tactic                VARCHAR(32)     NULL,
  level_price           DECIMAL(20,8)   NULL,
  current_price         DECIMAL(20,8)   NULL,
  distance_pct          DECIMAL(12,6)   NULL,
  approach_speed        DECIMAL(20,8)   NULL,
  approach_acceleration DECIMAL(20,8)   NULL,
  volume_delta_pct      DECIMAL(12,6)   NULL,
  trades_delta_pct      DECIMAL(12,6)   NULL,
  impulse_score         DECIMAL(12,4)   NULL,
  in_play_score         DECIMAL(12,4)   NULL,
  confidence_score      DECIMAL(12,4)   NULL,
  wall_nearby           BOOLEAN         NOT NULL DEFAULT FALSE,
  wall_strength         DECIMAL(20,8)   NULL,
  wall_change           VARCHAR(16)     NULL,
  confirmed             BOOLEAN         NOT NULL DEFAULT FALSE,
  severity              VARCHAR(16)     NULL,
  message               TEXT            NULL,
  payload_json          JSON            NULL,
  occurred_at           BIGINT          NOT NULL,
  created_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_level_events_symbol          (symbol),
  INDEX idx_level_events_level_id        (level_id),
  INDEX idx_level_events_event_type      (event_type),
  INDEX idx_level_events_occurred_at     (occurred_at),
  INDEX idx_level_events_symbol_occurred (symbol, occurred_at)
) ENGINE=InnoDB
`;

// ─── Entry point ──────────────────────────────────────────────────

async function runWatchLevelsMigrations(db) {
  console.log('[watchMigrations] Running Level Watch Engine migrations...');
  try {
    await migratelevelsTable(db);
    await db.query(CREATE_LEVEL_WATCH_CONFIGS);
    console.log('[watchMigrations] level_watch_configs ready');
    await db.query(CREATE_LEVEL_ALERT_OPTIONS);
    console.log('[watchMigrations] level_alert_options ready');
    await db.query(CREATE_LEVEL_EVENTS);
    console.log('[watchMigrations] level_events ready');
    console.log('[watchMigrations] All Level Watch migrations complete');
  } catch (err) {
    console.error('[watchMigrations] Failed:', err.message);
    throw err;
  }
}

module.exports = { runWatchLevelsMigrations };
