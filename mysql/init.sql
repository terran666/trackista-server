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
-- Price levels
-- Manual and auto-detected support/resistance
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS levels (
  id          BIGINT              AUTO_INCREMENT PRIMARY KEY,
  symbol      VARCHAR(32)         NOT NULL,
  price       DECIMAL(20,8)       NOT NULL,
  type        VARCHAR(32)         NOT NULL,   -- support, resistance, manual, high, low, cluster, density
  source      VARCHAR(32)         NOT NULL,   -- manual, auto, auto_swing, auto_extreme, auto_cluster, auto_density
  strength    INT                 NULL,       -- 0–100
  timeframe   VARCHAR(16)         NULL,
  is_active   BOOLEAN             NOT NULL DEFAULT TRUE,
  meta_json   JSON                NULL,
  created_at  DATETIME            NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME            NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_levels_symbol        (symbol),
  INDEX idx_levels_active        (is_active),
  INDEX idx_levels_symbol_active (symbol, is_active)
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

-- ─────────────────────────────────────────────
-- Users (for social feed / alerts module)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  username      VARCHAR(64)     NOT NULL,
  password_hash VARCHAR(255)    NOT NULL,
  avatar_url    VARCHAR(512)    NULL,
  role          ENUM('user','moderator','admin') NOT NULL DEFAULT 'user',
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_username (username)
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────
-- Alert posts (social feed with screenshots)
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alert_posts (
  id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  author_id      BIGINT UNSIGNED NOT NULL,
  image_url      VARCHAR(1024)   NOT NULL,
  image_key      VARCHAR(1024)   NULL COMMENT 'object storage key for deletion',
  image_width    INT             NULL,
  image_height   INT             NULL,
  symbol         VARCHAR(32)     NOT NULL,
  market         ENUM('spot','futures','unknown') NOT NULL DEFAULT 'unknown',
  timeframe      VARCHAR(16)     NOT NULL,
  note           TEXT            NOT NULL,
  source         ENUM('screener','monitor','testpage','manual') NOT NULL DEFAULT 'manual',
  exchange_name  VARCHAR(32)     NULL,
  layout_name    VARCHAR(64)     NULL,
  chart_price    DECIMAL(24,8)   NULL,
  likes_count    INT             NOT NULL DEFAULT 0,
  dislikes_count INT             NOT NULL DEFAULT 0,
  comments_count INT             NOT NULL DEFAULT 0,
  views_count    INT             NOT NULL DEFAULT 0,
  status         ENUM('active','deleted','hidden') NOT NULL DEFAULT 'active',
  created_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_created_at     (created_at DESC),
  INDEX idx_symbol         (symbol),
  INDEX idx_author_id      (author_id),
  INDEX idx_status_created (status, created_at DESC)
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────
-- Alert comments
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alert_comments (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  post_id    BIGINT UNSIGNED NOT NULL,
  author_id  BIGINT UNSIGNED NOT NULL,
  text       TEXT            NOT NULL,
  status     ENUM('active','deleted','hidden') NOT NULL DEFAULT 'active',
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_post_id_created (post_id, created_at ASC)
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────
-- Alert votes (likes / dislikes)
-- One vote per user per post — source of truth for counters
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS alert_votes (
  id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  post_id    BIGINT UNSIGNED NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  vote_type  ENUM('like','dislike') NOT NULL,
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_post_user (post_id, user_id),
  INDEX idx_post_id (post_id),
  INDEX idx_user_id (user_id)
) ENGINE=InnoDB;

-- ─────────────────────────────────────────────
-- 1-minute bars for futures symbols
-- Populated by barAggregatorService every minute
-- ─────────────────────────────────────────────
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
  UNIQUE KEY uniq_symbol_ts_market (symbol, ts, market),
  INDEX idx_symbol_ts (symbol, ts),
  INDEX idx_ts (ts)
) ENGINE=InnoDB;

