'use strict';
/**
 * wsEventBus.js — internal in-process event bus for real-time domain events.
 *
 * Events emitted on this bus are consumed by liveWsGateway to push
 * immediate notifications to WS clients without waiting for the next
 * flush-loop tick.
 *
 * Event types:
 *   'alert'       payload: alertObject   — emitted by screenerAlertEngine on fire
 *   'watch_delta' payload: { changes, removed } — emitted by levelWatchEngine
 *
 * Emitting is optional (fire-and-forget). If no listener is registered the
 * event is simply dropped. The WS gateway also has an independent flush loop
 * that polls Redis as a fallback, so missing an event here is not critical.
 */

const EventEmitter = require('events');

const bus = new EventEmitter();
bus.setMaxListeners(100); // support many gateway handler registrations

module.exports = bus;
