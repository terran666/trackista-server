'use strict';

const CREATE_SYMBOL_BARS_1M = `
CREATE TABLE IF NOT EXISTS symbol_bars_1m (
  id                 BIGINT UNSIGNED  AUTO_INCREMENT PRIMARY KEY,
  symbol             VARCHAR(32)      NOT NULL,
  ts                 BIGINT           NOT NULL,
  market             VARCHAR(16)      NOT NULL DEFAULT 'futures',
  open               DECIMAL(24,8)    NOT NULL,
  high               DECIMAL(24,8)    NOT NULL,
  low                DECIMAL(24,8)    NOT NULL,
  close              DECIMAL(24,8)    NOT NULL,
  price_change_pct   DECIMAL(12,6)    NULL,
  volatility         DECIMAL(12,6)    NULL,
  volume_usdt        DECIMAL(24,8)    NULL,
  buy_volume_usdt    DECIMAL(24,8)    NULL,
  sell_volume_usdt   DECIMAL(24,8)    NULL,
  delta_usdt         DECIMAL(24,8)    NULL,
  trade_count        INT              NULL,
  volume_spike_ratio DECIMAL(12,6)    NULL,
  funding_rate       DECIMAL(18,10)   NULL,
  oi_value           DECIMAL(24,8)    NULL,
  oi_delta           DECIMAL(24,8)    NULL,
  liq_long_usd       DECIMAL(24,8)    NULL,
  liq_short_usd      DECIMAL(24,8)    NULL,
  impulse_score      DECIMAL(12,6)    NULL,
  in_play_score      DECIMAL(12,6)    NULL,
  created_at         DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uniq_symbol_ts (symbol, ts),
  INDEX idx_symbol_ts (symbol, ts),
  INDEX idx_ts (ts)
) ENGINE=InnoDB
`;

async function runBarAggregatorMigrations(db) {
  console.log('[barAggregatorMigrations] Running...');
  try {
    await db.execute(CREATE_SYMBOL_BARS_1M);
    console.log('[barAggregatorMigrations] symbol_bars_1m table ready');
  } catch (err) {
    console.error('[barAggregatorMigrations] Failed:', err.message);
    throw err;
  }
}

module.exports = { runBarAggregatorMigrations };
