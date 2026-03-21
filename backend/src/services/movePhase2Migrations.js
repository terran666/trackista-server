'use strict';
/**
 * movePhase2Migrations.js — Phase 2
 *
 * Non-destructive ALTER TABLE statements + new pre_signal_outcomes table.
 * Each ALTER uses IF NOT EXISTS so safe to run repeatedly.
 */

async function runMoveMigrations2(db) {
  console.log('[movePhase2Migrations] running Phase 2 migrations...');

  // ── move_events: add Phase 2 columns ─────────────────────────────
  const moveEventsCols = [
    `ALTER TABLE move_events ADD COLUMN IF NOT EXISTS dominant_timeframe VARCHAR(10) NULL`,
    `ALTER TABLE move_events ADD COLUMN IF NOT EXISTS covered_timeframes_json TEXT NULL`,
    `ALTER TABLE move_events ADD COLUMN IF NOT EXISTS parent_event_id VARCHAR(64) NULL`,
    `ALTER TABLE move_events ADD COLUMN IF NOT EXISTS continuation_count INT NOT NULL DEFAULT 0`,
    `ALTER TABLE move_events ADD COLUMN IF NOT EXISTS direction_flip_count INT NOT NULL DEFAULT 0`,
    `ALTER TABLE move_events ADD COLUMN IF NOT EXISTS identity_reason VARCHAR(128) NULL`,
    `ALTER TABLE move_events ADD COLUMN IF NOT EXISTS happened_rank_score TINYINT UNSIGNED NULL`,
    `ALTER TABLE move_events ADD COLUMN IF NOT EXISTS happened_rank_label VARCHAR(2) NULL`,
    `ALTER TABLE move_events ADD COLUMN IF NOT EXISTS happened_rank_breakdown_json TEXT NULL`,
    `ALTER TABLE move_events ADD COLUMN IF NOT EXISTS derivatives_json TEXT NULL`,
  ];

  // ── pre_signals_history: add Phase 2 columns ─────────────────────
  const preSignalsCols = [
    `ALTER TABLE pre_signals_history ADD COLUMN IF NOT EXISTS raw_readiness_score TINYINT UNSIGNED NULL`,
    `ALTER TABLE pre_signals_history ADD COLUMN IF NOT EXISTS adjusted_readiness_score TINYINT UNSIGNED NULL`,
    `ALTER TABLE pre_signals_history ADD COLUMN IF NOT EXISTS score_trend VARCHAR(20) NULL`,
    `ALTER TABLE pre_signals_history ADD COLUMN IF NOT EXISTS readiness_label VARCHAR(20) NULL`,
    `ALTER TABLE pre_signals_history ADD COLUMN IF NOT EXISTS noise_penalty TINYINT UNSIGNED NULL`,
    `ALTER TABLE pre_signals_history ADD COLUMN IF NOT EXISTS building_rank_score TINYINT UNSIGNED NULL`,
    `ALTER TABLE pre_signals_history ADD COLUMN IF NOT EXISTS building_rank_label VARCHAR(2) NULL`,
    `ALTER TABLE pre_signals_history ADD COLUMN IF NOT EXISTS building_rank_breakdown_json TEXT NULL`,
    `ALTER TABLE pre_signals_history ADD COLUMN IF NOT EXISTS derivatives_json TEXT NULL`,
  ];

  // ── New table: pre_signal_outcomes ────────────────────────────────
  const createOutcomes = `
    CREATE TABLE IF NOT EXISTS pre_signal_outcomes (
      id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      symbol             VARCHAR(20)  NOT NULL,
      signal_ts          DATETIME(3)  NOT NULL,
      event_id           VARCHAR(64)  NULL,
      readiness_score    TINYINT UNSIGNED NULL,
      readiness_label    VARCHAR(20)  NULL,
      direction_bias     VARCHAR(10)  NULL,
      converted          TINYINT(1)   NOT NULL DEFAULT 0,
      conversion_lag_ms  INT UNSIGNED NULL,
      event_move_pct     DECIMAL(8,4) NULL,
      created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      UNIQUE KEY uq_sym_ts (symbol, signal_ts),
      INDEX idx_symbol (symbol),
      INDEX idx_signal_ts (signal_ts),
      INDEX idx_converted (converted)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `;

  const allStatements = [...moveEventsCols, ...preSignalsCols, createOutcomes];

  for (const sql of allStatements) {
    try {
      await db.execute(sql);
    } catch (err) {
      // Skip "Duplicate column name" on older MySQL that doesn't support IF NOT EXISTS
      if (!err.message.includes('Duplicate column')) {
        console.error('[movePhase2Migrations] stmt error:', err.message);
        console.error('  SQL:', sql.trim().substring(0, 80));
      }
    }
  }

  console.log('[movePhase2Migrations] Phase 2 migrations complete');
}

module.exports = { runMoveMigrations2 };
