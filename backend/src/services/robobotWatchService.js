'use strict';
/**
 * robobotWatchService.js — polls Redis prices for active Robobot tasks,
 * detects breakout/bounce triggers, dispatches to the Cloud bridge.
 *
 * Active statuses watched: armed, watching.
 * On trigger: status = triggered → SENT_TO_CLOUD attempt → status updated.
 *
 * Price source:
 *   futures: redis GET futures:price:{symbol} (fallback price:{symbol})
 *   spot   : redis GET price:{symbol}
 */

const POLL_MS         = parseInt(process.env.ROBOBOT_WATCH_POLL_MS || '300', 10);
const RELOAD_TASKS_MS = parseInt(process.env.ROBOBOT_WATCH_RELOAD_MS || '5000', 10);

function priceKey(market, symbol) {
  if (market === 'futures') return `futures:price:${symbol}`;
  return `price:${symbol}`;
}

function createRobobotWatchService({ redis, taskService, eventService, cloudBridge }) {
  /** Map<taskId, { task, prevPrice, bounceTouched, bounceTouchedAt }> */
  const tracked = new Map();

  let pollTimer   = null;
  let reloadTimer = null;
  let running     = false;

  async function reloadTasks() {
    try {
      const tasks = await taskService.listActiveTasks();
      const seen = new Set();
      for (const t of tasks) {
        seen.add(t.id);
        const prev = tracked.get(t.id);
        if (prev) {
          // Refresh task fields but keep prevPrice / bounce state
          prev.task = t;
        } else {
          tracked.set(t.id, {
            task           : t,
            prevPrice      : null,
            bounceTouched  : false,
            bounceTouchedAt: null,
            bounceTouchedPrice: null,
          });
        }
      }
      // Drop tasks that left the active set
      for (const id of [...tracked.keys()]) {
        if (!seen.has(id)) tracked.delete(id);
      }
    } catch (err) {
      console.error('[robobotWatch] reloadTasks failed:', err.message);
    }
  }

  async function fetchPrice(market, symbol) {
    try {
      let raw = await redis.get(priceKey(market, symbol));
      if (raw == null && market === 'futures') {
        raw = await redis.get(`price:${symbol}`);
      }
      if (raw == null) return null;
      const n = parseFloat(raw);
      return isFinite(n) && n > 0 ? n : null;
    } catch (_) { return null; }
  }

  function checkBreakout(slot, price) {
    const t  = slot.task;
    const lp = t.levelPrice;
    const pp = slot.prevPrice;
    if (pp == null) return false;
    if (t.triggerType === 'cross_above') {
      return pp < lp && price >= lp;
    }
    if (t.triggerType === 'cross_below') {
      return pp > lp && price <= lp;
    }
    return false;
  }

  function checkBounce(slot, price) {
    const t  = slot.task;
    const lp = t.levelPrice;
    const cd = Number(t.triggerConfig?.confirmDistancePercent ?? 0.05) / 100;

    if (t.direction === 'long') {
      // Touch from above the level → confirm move back up by cd%
      if (!slot.bounceTouched) {
        if (price <= lp) {
          slot.bounceTouched      = true;
          slot.bounceTouchedAt    = Date.now();
          slot.bounceTouchedPrice = price;
        }
        return false;
      }
      return price >= lp * (1 + cd);
    }
    if (t.direction === 'short') {
      if (!slot.bounceTouched) {
        if (price >= lp) {
          slot.bounceTouched      = true;
          slot.bounceTouchedAt    = Date.now();
          slot.bounceTouchedPrice = price;
        }
        return false;
      }
      return price <= lp * (1 - cd);
    }
    return false;
  }

  async function onTriggered(slot, price) {
    const taskId = slot.task.id;
    try {
      // Mark triggered
      const triggeredAt = new Date();
      let task = await taskService.setStatus(taskId, 'triggered', {
        lastPrice  : price,
        triggeredAt,
      });
      await eventService.logEvent(taskId, 'LEVEL_TRIGGERED', {
        price, levelPrice: task.levelPrice, scenario: task.scenario, direction: task.direction,
      });
      taskService.emitUpdate(task, { message: 'level triggered' });

      // Send to Cloud
      const result = await cloudBridge.sendTaskToCloud(task, { triggeredAt });

      if (result.ok) {
        const cloudStatus = result.mock ? 'mock_ok' : (result.response?.status || 'accepted');
        task = await taskService.setStatus(taskId, 'sent_to_cloud', {
          cloudStatus,
          sentToCloudAt: new Date(),
        });
        await eventService.logEvent(taskId, 'SENT_TO_CLOUD', {
          mock: result.mock, response: result.response,
        });
        taskService.emitUpdate(task, { message: result.mock ? 'sent (mock)' : 'sent to cloud' });
      } else {
        task = await taskService.setStatus(taskId, 'error', {
          cloudStatus: 'error',
        });
        await eventService.logEvent(taskId, 'CLOUD_ERROR', {
          error: result.error, attempts: result.attempts,
        });
        taskService.emitUpdate(task, { message: `cloud error: ${result.error}` });
      }
    } catch (err) {
      console.error(`[robobotWatch] onTriggered(${taskId}) failed:`, err.message);
      try {
        const task = await taskService.setStatus(taskId, 'error');
        await eventService.logEvent(taskId, 'ERROR', { error: err.message });
        taskService.emitUpdate(task, { message: err.message });
      } catch (_) { /* ignore */ }
    } finally {
      tracked.delete(taskId);
    }
  }

  async function tick() {
    if (tracked.size === 0) return;

    // Group by symbol+market for one Redis call per pair
    const byKey = new Map(); // key = market|symbol → { market, symbol, slots:[] }
    for (const slot of tracked.values()) {
      const k = `${slot.task.market}|${slot.task.symbol}`;
      if (!byKey.has(k)) {
        byKey.set(k, { market: slot.task.market, symbol: slot.task.symbol, slots: [] });
      }
      byKey.get(k).slots.push(slot);
    }

    const triggers = [];

    for (const { market, symbol, slots } of byKey.values()) {
      const price = await fetchPrice(market, symbol);
      if (price == null) continue;

      for (const slot of slots) {
        slot.task.lastPrice = price;
        let triggered = false;
        if (slot.task.scenario === 'breakout')      triggered = checkBreakout(slot, price);
        else if (slot.task.scenario === 'bounce')   triggered = checkBounce(slot, price);

        if (triggered) {
          triggers.push({ slot, price });
        } else {
          slot.prevPrice = price;
        }
      }
    }

    // Fire triggers sequentially to keep DB writes ordered
    for (const { slot, price } of triggers) {
      await onTriggered(slot, price);
    }

    // Expire tasks past expires_at
    const now = Date.now();
    for (const slot of [...tracked.values()]) {
      const exp = slot.task.expiresAt ? new Date(slot.task.expiresAt).getTime() : 0;
      if (exp && exp < now) {
        try {
          const task = await taskService.setStatus(slot.task.id, 'expired');
          await eventService.logEvent(slot.task.id, 'TASK_EXPIRED', { expiresAt: slot.task.expiresAt });
          taskService.emitUpdate(task, { message: 'expired' });
        } catch (_) { /* ignore */ }
        tracked.delete(slot.task.id);
      }
    }
  }

  function start() {
    if (running) return;
    running = true;
    reloadTasks();
    pollTimer   = setInterval(() => {
      tick().catch(err => console.error('[robobotWatch] tick err:', err.message));
    }, POLL_MS);
    reloadTimer = setInterval(() => {
      reloadTasks().catch(err => console.error('[robobotWatch] reload err:', err.message));
    }, RELOAD_TASKS_MS);
    if (pollTimer.unref)   pollTimer.unref();
    if (reloadTimer.unref) reloadTimer.unref();
    console.log(`[robobotWatch] started (poll=${POLL_MS}ms, reload=${RELOAD_TASKS_MS}ms)`);
  }

  function stop() {
    if (pollTimer)   clearInterval(pollTimer);
    if (reloadTimer) clearInterval(reloadTimer);
    pollTimer = reloadTimer = null;
    running   = false;
  }

  function status() {
    return {
      running,
      activeTasks: tracked.size,
      pollMs     : POLL_MS,
    };
  }

  return { start, stop, status, reloadTasks };
}

module.exports = { createRobobotWatchService };
