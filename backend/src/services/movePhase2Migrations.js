'use strict';
/**
 * movePhase2Migrations.js — Phase 2
 *
 * Non-destructive column additions + new pre_signal_outcomes table.
 *
 * MySQL 8.x does NOT support `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`
 * (that is MariaDB-only syntax). We therefore probe information_schema for each
 * column and add only the missing ones, so the migration is safe to run
 * repeatedly on any MySQL version.
 */

/**
 * Add a column only if it does not already exist on the table.
 * @param {import('mysql2/promise').Pool} db
 * @param {string} table
 * @param {string} column
 * @param {string} definition  e.g. 'VARCHAR(10) NULL'
 */
async function addColumnIfMissing(db, table, column, definition) {
  const [rows] = await db.execute(
    `SELECT 1
       FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name   = ?
        AND column_name  = ?
      LIMIT 1`,
    [table, column],
  );
  if (rows.length > 0) return; // already present
  // Identifiers cannot be parameterised — they are code-controlled constants here.
  await db.execute(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
}

async function runMoveMigrations2(db) {
  console.log('[movePhase2Migrations] running Phase 2 migrations...');

  // ── move_events: add Phase 2 columns ─────────────────────────────
  const moveEventsCols = [
    ['dominant_timeframe',           'VARCHAR(10) NULL'],
    ['covered_timeframes_json',      'TEXT NULL'],
    ['parent_event_id',              'VARCHAR(64) NULL'],
    ['continuation_count',           'INT NOT NULL DEFAULT 0'],
    ['direction_flip_count',         'INT NOT NULL DEFAULT 0'],
    ['identity_reason',              'VARCHAR(128) NULL'],
    ['happened_rank_score',          'TINYINT UNSIGNED NULL'],
    ['happened_rank_label',          'VARCHAR(2) NULL'],
    ['happened_rank_breakdown_json', 'TEXT NULL'],
    ['derivatives_json',             'TEXT NULL'],
  ];

  // ── pre_signals_history: add Phase 2 columns ─────────────────────
  const preSignalsCols = [
    ['raw_readiness_score',          'TINYINT UNSIGNED NULL'],
    ['adjusted_readiness_score',     'TINYINT UNSIGNED NULL'],
    ['score_trend',                  'VARCHAR(20) NULL'],
    ['readiness_label',              'VARCHAR(20) NULL'],
    ['noise_penalty',                'TINYINT UNSIGNED NULL'],
    ['building_rank_score',          'TINYINT UNSIGNED NULL'],
    ['building_rank_label',          'VARCHAR(2) NULL'],
    ['building_rank_breakdown_json', 'TEXT NULL'],
    ['derivatives_json',             'TEXT NULL'],
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

  for (const [column, definition] of moveEventsCols) {
    try {
      await addColumnIfMissing(db, 'move_events', column, definition);
    } catch (err) {
      if (!err.message.includes('Duplicate column')) {
        console.error(`[movePhase2Migrations] move_events.${column} error:`, err.message);
      }
    }
  }

  for (const [column, definition] of preSignalsCols) {
    try {
      await addColumnIfMissing(db, 'pre_signals_history', column, definition);
    } catch (err) {
      if (!err.message.includes('Duplicate column')) {
        console.error(`[movePhase2Migrations] pre_signals_history.${column} error:`, err.message);
      }
    }
  }

  try {
    await db.execute(createOutcomes);
  } catch (err) {
    console.error('[movePhase2Migrations] create pre_signal_outcomes error:', err.message);
  }

  console.log('[movePhase2Migrations] Phase 2 migrations complete');
}

module.exports = { runMoveMigrations2 };
