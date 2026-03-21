'use strict';

/**
 * moveMigrations — CREATE TABLE IF NOT EXISTS for the move intelligence module.
 * Safe to run on every startup.
 */

const MIGRATIONS = [
  // ── Move events ──────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS move_events (
    id                     BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    symbol                 VARCHAR(32)   NOT NULL,
    market_type            ENUM('spot','futures','both') NOT NULL DEFAULT 'spot',
    event_type             VARCHAR(32)   NOT NULL
                             COMMENT 'PUMP_EVENT | DUMP_EVENT | EXTREME_EXTENSION | REVERSAL_EVENT | IMPULSE_BURST | WALL_BOUNCE | WALL_BREAK | LIQUIDATION_BURST',
    direction              ENUM('up','down') NOT NULL,
    timeframe              VARCHAR(8)    NOT NULL  COMMENT '1m | 3m | 5m | 15m | 30m | 1h',
    threshold_percent      DECIMAL(8,4)  NOT NULL,

    start_ts               DATETIME(3)   NOT NULL,
    alert_ts               DATETIME(3)   NOT NULL,
    extreme_ts             DATETIME(3)   NULL,
    end_ts                 DATETIME(3)   NULL,

    start_price            DECIMAL(24,8) NOT NULL,
    alert_price            DECIMAL(24,8) NOT NULL,
    extreme_price          DECIMAL(24,8) NULL,
    end_price              DECIMAL(24,8) NULL,

    move_pct_at_alert      DECIMAL(10,4) NOT NULL,
    move_pct_at_extreme    DECIMAL(10,4) NULL,
    total_duration_ms      BIGINT        NULL,
    time_to_alert_ms       BIGINT        NOT NULL,
    time_to_extreme_ms     BIGINT        NULL,
    retracement_pct        DECIMAL(10,4) NOT NULL DEFAULT 0,

    confidence_score       TINYINT UNSIGNED NULL,
    cause_tags_json        JSON          NULL,

    snapshot_before_json   JSON          NULL,
    snapshot_alert_json    JSON          NULL,
    snapshot_extreme_json  JSON          NULL,
    snapshot_close_json    JSON          NULL,

    status                 VARCHAR(16)   NOT NULL DEFAULT 'active'
                             COMMENT 'active | extended | reversed | closed',
    created_at             DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at             DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    INDEX idx_symbol_created   (symbol, created_at DESC),
    INDEX idx_direction_tf     (direction, timeframe, created_at DESC),
    INDEX idx_status           (status, created_at DESC),
    INDEX idx_event_type       (event_type, created_at DESC)
  ) ENGINE=InnoDB`,

  // ── Pre-signal history ────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS pre_signals_history (
    id                       BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    symbol                   VARCHAR(32)   NOT NULL,
    signal_type              VARCHAR(32)   NOT NULL
                               COMMENT 'PRE_PUMP_SIGNAL | PRE_DUMP_SIGNAL | PRE_BREAKOUT_SIGNAL | PRE_BOUNCE_SIGNAL | PRE_LIQUIDATION_SQUEEZE | PRE_VOLATILITY_EXPANSION',
    direction_bias           ENUM('up','down','neutral') NOT NULL DEFAULT 'neutral',
    readiness_score          TINYINT UNSIGNED NOT NULL,
    confidence_score         TINYINT UNSIGNED NOT NULL,
    distance_to_condition_pct DECIMAL(10,4) NULL,
    wall_bias                VARCHAR(16)   NULL,
    acceleration_state       VARCHAR(16)   NULL,
    volatility_state         VARCHAR(16)   NULL,
    cause_tags_json          JSON          NULL,
    feature_snapshot_json    JSON          NULL,
    created_at               DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expired_at               DATETIME      NULL,
    outcome_event_id         BIGINT UNSIGNED NULL
                               COMMENT 'FK to move_events.id — filled retroactively',

    INDEX idx_symbol_created  (symbol, created_at DESC),
    INDEX idx_signal_type     (signal_type, created_at DESC),
    INDEX idx_readiness       (readiness_score DESC, created_at DESC)
  ) ENGINE=InnoDB`,

  // ── Alert triggers ────────────────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS alert_triggers (
    id                    BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_alert_id         BIGINT UNSIGNED NULL,
    symbol                VARCHAR(32)   NOT NULL,
    trigger_type          VARCHAR(32)   NOT NULL
                            COMMENT 'FACT_MOVE | PRE_SIGNAL | WALL_BREAK | WALL_BOUNCE | IMPULSE',
    trigger_ts            DATETIME(3)   NOT NULL,
    trigger_context_json  JSON          NULL,
    related_event_id      BIGINT UNSIGNED NULL
                            COMMENT 'FK to move_events.id',
    created_at            DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,

    INDEX idx_symbol_ts   (symbol, trigger_ts DESC),
    INDEX idx_trigger_type (trigger_type, trigger_ts DESC)
  ) ENGINE=InnoDB`,
];

async function runMoveMigrations(db) {
  console.log('[moveMigrations] Running move module migrations...');
  for (const sql of MIGRATIONS) {
    await db.query(sql);
  }
  console.log('[moveMigrations] Move module migrations complete');
}

module.exports = { runMoveMigrations };
