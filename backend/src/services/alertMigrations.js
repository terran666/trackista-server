'use strict';

/**
 * Auto-migration: runs CREATE TABLE IF NOT EXISTS for all alert-module tables.
 * Safe to run on every startup — no-ops if tables already exist.
 * Supplements init.sql which only runs on a fresh MySQL volume.
 */
const MIGRATIONS = [
  // Users
  `CREATE TABLE IF NOT EXISTS users (
    id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username      VARCHAR(64)     NOT NULL,
    password_hash VARCHAR(255)    NOT NULL,
    avatar_url    VARCHAR(512)    NULL,
    role          ENUM('user','moderator','admin') NOT NULL DEFAULT 'user',
    created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_username (username)
  ) ENGINE=InnoDB`,

  // Alert posts
  `CREATE TABLE IF NOT EXISTS alert_posts (
    id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    author_id      BIGINT UNSIGNED NOT NULL,
    image_url      VARCHAR(1024)   NOT NULL,
    image_key      VARCHAR(1024)   NULL,
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
  ) ENGINE=InnoDB`,

  // Alert comments
  `CREATE TABLE IF NOT EXISTS alert_comments (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    post_id    BIGINT UNSIGNED NOT NULL,
    author_id  BIGINT UNSIGNED NOT NULL,
    text       TEXT            NOT NULL,
    status     ENUM('active','deleted','hidden') NOT NULL DEFAULT 'active',
    created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_post_id_created (post_id, created_at ASC)
  ) ENGINE=InnoDB`,

  // Alert votes
  `CREATE TABLE IF NOT EXISTS alert_votes (
    id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    post_id    BIGINT UNSIGNED NOT NULL,
    user_id    BIGINT UNSIGNED NOT NULL,
    vote_type  ENUM('like','dislike') NOT NULL,
    created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_post_user (post_id, user_id),
    INDEX idx_post_id (post_id),
    INDEX idx_user_id (user_id)
  ) ENGINE=InnoDB`,
];

async function runMigrations(db) {
  console.log('[migrations] Running alert module migrations...');
  for (const sql of MIGRATIONS) {
    await db.query(sql);
  }
  console.log('[migrations] Alert module migrations complete');
}

module.exports = { runMigrations };
