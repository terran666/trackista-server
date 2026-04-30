'use strict';
/**
 * robobotEventService.js — append-only event log for Robobot tasks.
 *
 * Writes to robobot_events and emits `robobot:event` on the wsEventBus
 * for live frontend tail.
 */

const eventBus = require('./wsEventBus');

function createRobobotEventService(db) {
  async function logEvent(taskId, eventType, payload = null) {
    try {
      const json = payload ? JSON.stringify(payload) : null;
      const [res] = await db.query(
        `INSERT INTO robobot_events (task_id, event_type, payload_json) VALUES (?, ?, ?)`,
        [taskId, eventType, json],
      );
      const ev = {
        id        : res.insertId,
        taskId,
        eventType,
        payload,
        createdAt : Date.now(),
      };
      eventBus.emit('robobot:event', ev);
      return ev;
    } catch (err) {
      console.error(`[robobotEvent] logEvent(${taskId}, ${eventType}) failed:`, err.message);
      return null;
    }
  }

  async function listEvents({ taskId, limit = 200 }) {
    const lim = Math.min(Math.max(parseInt(limit, 10) || 200, 1), 1000);
    const params = [];
    let where = '';
    if (taskId) {
      where = 'WHERE task_id = ?';
      params.push(taskId);
    }
    const [rows] = await db.query(
      `SELECT id, task_id, event_type, payload_json, created_at
       FROM robobot_events ${where}
       ORDER BY id DESC
       LIMIT ${lim}`,
      params,
    );
    return rows.map(r => ({
      id        : r.id,
      taskId    : r.task_id,
      eventType : r.event_type,
      payload   : r.payload_json,
      createdAt : r.created_at,
    }));
  }

  return { logEvent, listEvents };
}

module.exports = { createRobobotEventService };
