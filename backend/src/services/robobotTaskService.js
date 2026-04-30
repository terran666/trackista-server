'use strict';
/**
 * robobotTaskService.js — CRUD + lifecycle for robobot_tasks.
 *
 * Active statuses (watched by robobotWatchService):
 *   armed, watching
 *
 * Final statuses (immutable):
 *   tp_hit, sl_hit, expired, cancelled
 */

const eventBus = require('./wsEventBus');

const FINAL_STATUSES   = new Set(['tp_hit', 'sl_hit', 'expired', 'cancelled']);
const EDITABLE_STATUSES = new Set(['draft', 'cancelled', 'error']);
const ACTIVE_STATUSES  = new Set(['armed', 'watching']);

function rowToTask(r) {
  if (!r) return null;
  return {
    id               : r.id,
    userId           : r.user_id,
    symbol           : r.symbol,
    market           : r.market,
    scenario         : r.scenario,
    direction        : r.direction,
    levelPrice       : Number(r.level_price),
    triggerType      : r.trigger_type,
    triggerConfig    : r.trigger_config_json || {},
    entry            : { type: r.entry_type },
    stopLossPrice    : Number(r.stop_loss_price),
    takeProfitPrice  : Number(r.take_profit_price),
    positionSizeUsdt : Number(r.position_size_usdt),
    riskConfig       : r.risk_config_json || {},
    status           : r.status,
    cloudStatus      : r.cloud_status,
    botStatus        : r.bot_status,
    lastPrice        : r.last_price != null ? Number(r.last_price) : null,
    triggeredAt      : r.triggered_at,
    sentToCloudAt    : r.sent_to_cloud_at,
    expiresAt        : r.expires_at,
    createdAt        : r.created_at,
    updatedAt        : r.updated_at,
  };
}

function emitUpdate(task, extra = {}) {
  if (!task) return;
  eventBus.emit('robobot:task:update', {
    taskId      : task.id,
    symbol      : task.symbol,
    status      : task.status,
    cloudStatus : task.cloudStatus,
    botStatus   : task.botStatus,
    price       : task.lastPrice ?? null,
    message     : extra.message ?? null,
    updatedAt   : Date.now(),
  });
}

function createRobobotTaskService(db, eventService) {
  async function listTasks({ symbol, status } = {}) {
    const where = [];
    const params = [];
    if (symbol) { where.push('symbol = ?'); params.push(String(symbol).toUpperCase()); }
    if (status) { where.push('status = ?'); params.push(String(status).toLowerCase()); }
    const sql = `SELECT * FROM robobot_tasks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT 500`;
    const [rows] = await db.query(sql, params);
    return rows.map(rowToTask);
  }

  async function getTask(id) {
    const [rows] = await db.query(`SELECT * FROM robobot_tasks WHERE id = ? LIMIT 1`, [id]);
    return rowToTask(rows[0]);
  }

  async function findActiveDuplicate({ symbol, scenario, direction, levelPrice }) {
    const [rows] = await db.query(
      `SELECT id FROM robobot_tasks
       WHERE symbol = ? AND scenario = ? AND direction = ? AND level_price = ?
         AND status IN ('draft','armed','watching','triggered','sent_to_cloud','accepted_by_cloud','sent_to_bot','order_placed','position_open')
       LIMIT 1`,
      [symbol, scenario, direction, levelPrice],
    );
    return rows[0]?.id ?? null;
  }

  async function createTask(value, { userId = null } = {}) {
    const [res] = await db.query(
      `INSERT INTO robobot_tasks
        (user_id, symbol, market, scenario, direction,
         level_price, trigger_type, trigger_config_json,
         entry_type, stop_loss_price, take_profit_price, position_size_usdt,
         risk_config_json, status, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?)`,
      [
        userId,
        value.symbol, value.market, value.scenario, value.direction,
        value.levelPrice, value.triggerType, JSON.stringify(value.triggerConfig || {}),
        value.entryType, value.stopLossPrice, value.takeProfitPrice, value.positionSizeUsdt,
        JSON.stringify(value.riskConfig || {}),
        value.expiresAt || null,
      ],
    );
    const task = await getTask(res.insertId);
    await eventService.logEvent(task.id, 'TASK_CREATED', { task });
    emitUpdate(task, { message: 'created' });
    return task;
  }

  async function updateTask(id, value) {
    const existing = await getTask(id);
    if (!existing) return { ok: false, error: 'not_found' };
    if (!EDITABLE_STATUSES.has(existing.status)) {
      return { ok: false, error: 'not_editable', status: existing.status };
    }
    await db.query(
      `UPDATE robobot_tasks SET
         symbol = ?, market = ?, scenario = ?, direction = ?,
         level_price = ?, trigger_type = ?, trigger_config_json = ?,
         entry_type = ?, stop_loss_price = ?, take_profit_price = ?, position_size_usdt = ?,
         risk_config_json = ?, expires_at = ?
       WHERE id = ?`,
      [
        value.symbol, value.market, value.scenario, value.direction,
        value.levelPrice, value.triggerType, JSON.stringify(value.triggerConfig || {}),
        value.entryType, value.stopLossPrice, value.takeProfitPrice, value.positionSizeUsdt,
        JSON.stringify(value.riskConfig || {}),
        value.expiresAt || null,
        id,
      ],
    );
    const task = await getTask(id);
    await eventService.logEvent(id, 'TASK_UPDATED', { task });
    emitUpdate(task, { message: 'updated' });
    return { ok: true, task };
  }

  async function setStatus(id, status, extra = {}) {
    const sets = ['status = ?'];
    const params = [status];
    if (extra.cloudStatus !== undefined) { sets.push('cloud_status = ?');     params.push(extra.cloudStatus); }
    if (extra.botStatus   !== undefined) { sets.push('bot_status = ?');       params.push(extra.botStatus); }
    if (extra.lastPrice   !== undefined) { sets.push('last_price = ?');       params.push(extra.lastPrice); }
    if (extra.triggeredAt)               { sets.push('triggered_at = ?');     params.push(extra.triggeredAt); }
    if (extra.sentToCloudAt)             { sets.push('sent_to_cloud_at = ?'); params.push(extra.sentToCloudAt); }
    params.push(id);
    await db.query(`UPDATE robobot_tasks SET ${sets.join(', ')} WHERE id = ?`, params);
    return getTask(id);
  }

  async function armTask(id) {
    const existing = await getTask(id);
    if (!existing) return { ok: false, error: 'not_found' };
    if (!['draft', 'cancelled', 'error'].includes(existing.status)) {
      return { ok: false, error: 'invalid_status', status: existing.status };
    }
    const task = await setStatus(id, 'armed');
    await eventService.logEvent(id, 'TASK_ARMED', { task });
    emitUpdate(task, { message: 'armed' });
    return { ok: true, task };
  }

  async function cancelTask(id) {
    const existing = await getTask(id);
    if (!existing) return { ok: false, error: 'not_found' };
    if (FINAL_STATUSES.has(existing.status)) {
      return { ok: false, error: 'final_status', status: existing.status };
    }
    const task = await setStatus(id, 'cancelled');
    await eventService.logEvent(id, 'TASK_CANCELLED', { task });
    emitUpdate(task, { message: 'cancelled' });
    return { ok: true, task };
  }

  async function deleteTask(id) {
    const existing = await getTask(id);
    if (!existing) return { ok: false, error: 'not_found' };
    await db.query(`DELETE FROM robobot_tasks WHERE id = ?`, [id]);
    return { ok: true };
  }

  async function listActiveTasks() {
    const statuses = [...ACTIVE_STATUSES];
    const placeholders = statuses.map(() => '?').join(',');
    const [rows] = await db.query(
      `SELECT * FROM robobot_tasks WHERE status IN (${placeholders}) ORDER BY id ASC LIMIT 1000`,
      statuses,
    );
    return rows.map(rowToTask);
  }

  return {
    listTasks,
    getTask,
    findActiveDuplicate,
    createTask,
    updateTask,
    armTask,
    cancelTask,
    deleteTask,
    setStatus,
    listActiveTasks,
    emitUpdate,
    FINAL_STATUSES,
    ACTIVE_STATUSES,
  };
}

module.exports = { createRobobotTaskService };
