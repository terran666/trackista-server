-- Trackista Database — Stage 1 Schema
-- Designed for extensibility: analytics, signals, alerts, posts, media

CREATE DATABASE IF NOT EXISTS trackista
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE trackista;

-- ─────────────────────────────────────────────
-- Coin metadata
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS coins (
  id          INT UNSIGNED        AUTO_INCREMENT PRIMARY KEY,
  symbol      VARCHAR(20)         NOT NULL UNIQUE,  -- e.g. BTCUSDT
  base_asset  VARCHAR(20)         NOT NULL,          -- BTC
  quote_asset VARCHAR(20)         NOT NULL,          -- USDT
  market_type ENUM('spot','futures') NOT NULL DEFAULT 'spot',
  is_active   TINYINT(1)          NOT NULL DEFAULT 1,
  created_at  DATETIME            NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME            NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_symbol    (symbol),
  INDEX idx_is_active (is_active)
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────
-- Price aggregates (1m / 5m / 1h candles)
-- Stored by collector after each closed window
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS price_aggregates (
  id          BIGINT UNSIGNED     AUTO_INCREMENT PRIMARY KEY,
  symbol      VARCHAR(20)         NOT NULL,
  market_type ENUM('spot','futures') NOT NULL DEFAULT 'spot',
  interval    ENUM('1m','5m','15m','1h','4h','1d') NOT NULL DEFAULT '1m',
  open_time   DATETIME            NOT NULL,
  close_time  DATETIME            NOT NULL,
  open        DECIMAL(20,8)       NOT NULL,
  high        DECIMAL(20,8)       NOT NULL,
  low         DECIMAL(20,8)       NOT NULL,
  close       DECIMAL(20,8)       NOT NULL,
  volume      DECIMAL(30,8)       NOT NULL,
  trade_count INT UNSIGNED        NOT NULL DEFAULT 0,
  created_at  DATETIME            NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_symbol_interval_time (symbol, `interval`, open_time),
  INDEX idx_open_time            (open_time)
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────
-- Trade events
-- Large trades, abnormal activity, impulses
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trade_events (
  id          BIGINT UNSIGNED     AUTO_INCREMENT PRIMARY KEY,
  symbol      VARCHAR(20)         NOT NULL,
  market_type ENUM('spot','futures') NOT NULL DEFAULT 'spot',
  event_type  VARCHAR(50)         NOT NULL,  -- large_trade, impulse, pump, dump, knife, wall_break
  price       DECIMAL(20,8)       NOT NULL,
  quantity    DECIMAL(30,8)       NOT NULL,
  side        ENUM('buy','sell')  NOT NULL,
  raw_data    JSON,
  occurred_at DATETIME            NOT NULL,
  created_at  DATETIME            NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_symbol_type  (symbol, event_type),
  INDEX idx_occurred_at  (occurred_at)
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────
-- Signals
-- Strategy triggers: knife catch, wall break/bounce, impulse, pump/dump
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS signals (
  id           BIGINT UNSIGNED    AUTO_INCREMENT PRIMARY KEY,
  symbol       VARCHAR(20)        NOT NULL,
  market_type  ENUM('spot','futures') NOT NULL DEFAULT 'spot',
  strategy     VARCHAR(50)        NOT NULL,  -- knife_catch, wall_break, wall_bounce, impulse, pump, dump
  direction    ENUM('long','short','neutral') NOT NULL DEFAULT 'neutral',
  confidence   TINYINT UNSIGNED   NOT NULL DEFAULT 50,  -- 0–100
  price        DECIMAL(20,8)      NOT NULL,
  meta         JSON,
  triggered_at DATETIME           NOT NULL,
  created_at   DATETIME           NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_symbol_strategy (symbol, strategy),
  INDEX idx_triggered_at    (triggered_at)
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────
-- System logs
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS system_logs (
  id         BIGINT UNSIGNED      AUTO_INCREMENT PRIMARY KEY,
  service    VARCHAR(50)          NOT NULL,  -- backend, collector, notifier, image-worker
  level      ENUM('info','warn','error') NOT NULL DEFAULT 'info',
  message    TEXT                 NOT NULL,
  meta       JSON,
  created_at DATETIME             NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_service_level (service, `level`),
  INDEX idx_created_at    (created_at)
) ENGINE=InnoDB;
