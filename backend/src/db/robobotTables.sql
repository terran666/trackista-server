-- robobotTables.sql — Reference schema for the Robobot module.
-- The runtime applies these idempotently from services/robobotMigrations.js.

CREATE TABLE IF NOT EXISTS robobot_tasks (
  id                    BIGINT          AUTO_INCREMENT PRIMARY KEY,
  user_id               VARCHAR(64)     NULL,
  symbol                VARCHAR(32)     NOT NULL,
  market                VARCHAR(16)     NOT NULL DEFAULT 'futures',

  scenario              VARCHAR(32)     NOT NULL,
  direction             VARCHAR(16)     NOT NULL,

  level_price           DECIMAL(20,8)   NOT NULL,
  trigger_type          VARCHAR(64)     NOT NULL,
  trigger_config_json   JSON            NULL,

  entry_type            VARCHAR(32)     NOT NULL DEFAULT 'market',

  stop_loss_price       DECIMAL(20,8)   NOT NULL,
  take_profit_price     DECIMAL(20,8)   NOT NULL,
  position_size_usdt    DECIMAL(20,8)   NOT NULL,

  risk_config_json      JSON            NULL,

  status                VARCHAR(32)     NOT NULL DEFAULT 'draft',
  cloud_status          VARCHAR(32)     NULL,
  bot_status            VARCHAR(32)     NULL,

  last_price            DECIMAL(20,8)   NULL,
  triggered_at          DATETIME        NULL,
  sent_to_cloud_at      DATETIME        NULL,

  expires_at            DATETIME        NULL,
  created_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_robobot_tasks_status         (status),
  INDEX idx_robobot_tasks_symbol         (symbol),
  INDEX idx_robobot_tasks_symbol_status  (symbol, status),
  INDEX idx_robobot_tasks_user           (user_id)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS robobot_events (
  id           BIGINT       AUTO_INCREMENT PRIMARY KEY,
  task_id      BIGINT       NOT NULL,
  event_type   VARCHAR(64)  NOT NULL,
  payload_json JSON         NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,

  INDEX idx_robobot_events_task   (task_id),
  INDEX idx_robobot_events_type   (event_type),
  INDEX idx_robobot_events_created (created_at)
) ENGINE=InnoDB;
