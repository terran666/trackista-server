'use strict';
/**
 * robobotRoutes.js — REST API for the Robobot module.
 *
 *   GET    /api/robobot/tasks?symbol=&status=
 *   POST   /api/robobot/tasks
 *   GET    /api/robobot/tasks/:id
 *   PATCH  /api/robobot/tasks/:id
 *   POST   /api/robobot/tasks/:id/arm
 *   POST   /api/robobot/tasks/:id/cancel
 *   DELETE /api/robobot/tasks/:id
 *   GET    /api/robobot/events?taskId=&limit=
 *   GET    /api/robobot/status
 */

const express = require('express');
const { validateTaskInput } = require('./../services/robobotValidationService');
const { getCloudMode }      = require('./../services/robobotCloudBridge');

function createRobobotRouter({ redis, taskService, eventService, watchService }) {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));

  // ─── Universe loader (cached 30s) ───────────────────────────────
  let _univCache = { ts: 0, set: null };
  async function getUniverse() {
    const now = Date.now();
    if (_univCache.set && (now - _univCache.ts) < 30_000) return _univCache.set;
    try {
      const raw = await redis.get('symbols:active:usdt');
      if (raw) {
        let list = [];
        try {
          const parsed = JSON.parse(raw);
          list = Array.isArray(parsed) ? parsed
               : Array.isArray(parsed?.symbols) ? parsed.symbols
               : [];
        } catch {
          list = raw.split(',').map(s => s.trim());
        }
        _univCache = { ts: now, set: new Set(list.map(s => String(s).toUpperCase())) };
      } else {
        _univCache = { ts: now, set: null };
      }
    } catch (_) {
      _univCache = { ts: now, set: null };
    }
    return _univCache.set;
  }

  function badRequest(res, errors) {
    return res.status(400).json({ success: false, error: 'validation_failed', errors });
  }

  // ─── GET /tasks ─────────────────────────────────────────────────
  router.get('/tasks', async (req, res) => {
    try {
      const tasks = await taskService.listTasks({
        symbol: req.query.symbol,
        status: req.query.status,
      });
      res.json({ success: true, count: tasks.length, tasks });
    } catch (err) {
      console.error('[robobotRoutes] list tasks:', err.message);
      res.status(500).json({ success: false, error: 'internal_error' });
    }
  });

  // ─── POST /tasks ────────────────────────────────────────────────
  router.post('/tasks', async (req, res) => {
    try {
      const universeSymbols = await getUniverse();
      const result = validateTaskInput(req.body, { universeSymbols });
      if (!result.ok) return badRequest(res, result.errors);

      const dup = await taskService.findActiveDuplicate({
        symbol     : result.value.symbol,
        scenario   : result.value.scenario,
        direction  : result.value.direction,
        levelPrice : result.value.levelPrice,
      });
      if (dup) {
        return res.status(409).json({
          success: false, error: 'duplicate_active_task', existingId: dup,
        });
      }

      const userId = req.user?.id || req.user?.userId || null;
      const task   = await taskService.createTask(result.value, { userId });
      res.status(201).json({ success: true, task });
    } catch (err) {
      console.error('[robobotRoutes] create task:', err.message);
      res.status(500).json({ success: false, error: 'internal_error' });
    }
  });

  // ─── GET /tasks/:id ─────────────────────────────────────────────
  router.get('/tasks/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ success: false, error: 'bad_id' });
      const task = await taskService.getTask(id);
      if (!task) return res.status(404).json({ success: false, error: 'not_found' });
      res.json({ success: true, task });
    } catch (err) {
      console.error('[robobotRoutes] get task:', err.message);
      res.status(500).json({ success: false, error: 'internal_error' });
    }
  });

  // ─── PATCH /tasks/:id ───────────────────────────────────────────
  router.patch('/tasks/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ success: false, error: 'bad_id' });

      const existing = await taskService.getTask(id);
      if (!existing) return res.status(404).json({ success: false, error: 'not_found' });

      // Merge existing → patch (allow partial input)
      const merged = {
        symbol           : req.body.symbol           ?? existing.symbol,
        market           : req.body.market           ?? existing.market,
        scenario         : req.body.scenario         ?? existing.scenario,
        direction        : req.body.direction        ?? existing.direction,
        levelPrice       : req.body.levelPrice       ?? existing.levelPrice,
        triggerType      : req.body.triggerType      ?? existing.triggerType,
        triggerConfig    : req.body.triggerConfig    ?? existing.triggerConfig,
        entry            : req.body.entry            ?? existing.entry,
        entryType        : req.body.entryType        ?? existing.entry?.type,
        stopLossPrice    : req.body.stopLossPrice    ?? existing.stopLossPrice,
        takeProfitPrice  : req.body.takeProfitPrice  ?? existing.takeProfitPrice,
        positionSizeUsdt : req.body.positionSizeUsdt ?? existing.positionSizeUsdt,
        riskConfig       : req.body.riskConfig       ?? existing.riskConfig,
        expiresAt        : req.body.expiresAt        ?? existing.expiresAt,
      };

      const universeSymbols = await getUniverse();
      const result = validateTaskInput(merged, { universeSymbols });
      if (!result.ok) return badRequest(res, result.errors);

      const upd = await taskService.updateTask(id, result.value);
      if (!upd.ok) {
        return res.status(409).json({ success: false, error: upd.error, status: upd.status });
      }
      res.json({ success: true, task: upd.task });
    } catch (err) {
      console.error('[robobotRoutes] patch task:', err.message);
      res.status(500).json({ success: false, error: 'internal_error' });
    }
  });

  // ─── POST /tasks/:id/arm ────────────────────────────────────────
  router.post('/tasks/:id/arm', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ success: false, error: 'bad_id' });
      const result = await taskService.armTask(id);
      if (!result.ok) {
        const code = result.error === 'not_found' ? 404 : 409;
        return res.status(code).json({ success: false, error: result.error, status: result.status });
      }
      // Trigger reload so the watcher picks it up immediately
      watchService.reloadTasks().catch(() => {});
      res.json({ success: true, task: result.task });
    } catch (err) {
      console.error('[robobotRoutes] arm task:', err.message);
      res.status(500).json({ success: false, error: 'internal_error' });
    }
  });

  // ─── POST /tasks/:id/cancel ─────────────────────────────────────
  router.post('/tasks/:id/cancel', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ success: false, error: 'bad_id' });
      const result = await taskService.cancelTask(id);
      if (!result.ok) {
        const code = result.error === 'not_found' ? 404 : 409;
        return res.status(code).json({ success: false, error: result.error, status: result.status });
      }
      watchService.reloadTasks().catch(() => {});
      res.json({ success: true, task: result.task });
    } catch (err) {
      console.error('[robobotRoutes] cancel task:', err.message);
      res.status(500).json({ success: false, error: 'internal_error' });
    }
  });

  // ─── DELETE /tasks/:id ──────────────────────────────────────────
  router.delete('/tasks/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      if (!id) return res.status(400).json({ success: false, error: 'bad_id' });
      const result = await taskService.deleteTask(id);
      if (!result.ok) return res.status(404).json({ success: false, error: result.error });
      watchService.reloadTasks().catch(() => {});
      res.json({ success: true });
    } catch (err) {
      console.error('[robobotRoutes] delete task:', err.message);
      res.status(500).json({ success: false, error: 'internal_error' });
    }
  });

  // ─── GET /events ────────────────────────────────────────────────
  router.get('/events', async (req, res) => {
    try {
      const taskId = req.query.taskId ? parseInt(req.query.taskId, 10) : null;
      const limit  = req.query.limit;
      const events = await eventService.listEvents({ taskId, limit });
      res.json({ success: true, count: events.length, events });
    } catch (err) {
      console.error('[robobotRoutes] list events:', err.message);
      res.status(500).json({ success: false, error: 'internal_error' });
    }
  });

  // ─── GET /status ────────────────────────────────────────────────
  router.get('/status', async (_req, res) => {
    const w = watchService.status();
    res.json({
      ok          : true,
      watcher     : w.running ? 'running' : 'stopped',
      cloudMode   : getCloudMode(),
      activeTasks : w.activeTasks,
      pollMs      : w.pollMs,
      updatedAt   : Date.now(),
    });
  });

  return router;
}

module.exports = { createRobobotRouter };
