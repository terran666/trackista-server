'use strict';

/**
 * Formations module — isolated, pluggable breakout-formation scanner.
 *
 * Wiring:
 *   const formations = createFormationsModule({ redis });
 *   formations.service.start();
 *   app.use('/api/formations/scalping', formations.router);
 *   app.use('/api/formations/debug',    formations.debugRouter);
 *
 * The module owns its own Redis keys (formations:scalping:*) and does not touch
 * any other subsystem.
 */

const { config } = require('./formationConfig');
const { createFormationStore } = require('./formationStore');
const { createFormationService } = require('./formationScalpingService');
const { createFormationRouter, createFormationDebugRouter } = require('./formationRoutes');

function createFormationsModule({ redis, overrides = {} }) {
  const cfg = { ...config, ...overrides };
  const store = createFormationStore(redis, cfg);
  const service = createFormationService({ redis, store, config: cfg });
  const router = createFormationRouter({ store });
  const debugRouter = createFormationDebugRouter({ service, store });

  return { config: cfg, store, service, router, debugRouter };
}

module.exports = { createFormationsModule };
