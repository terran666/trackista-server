'use strict';

console.log('[collector] Trackista collector starting...');
console.log(`[collector] NODE_ENV:           ${process.env.NODE_ENV}`);
console.log(`[collector] Redis:              ${process.env.REDIS_HOST}:${process.env.REDIS_PORT}`);
console.log(`[collector] DB:                 ${process.env.DB_HOST}:${process.env.DB_PORT}`);
console.log(`[collector] Binance Spot WS:    ${process.env.BINANCE_SPOT_WS}`);
console.log(`[collector] Binance Futures WS: ${process.env.BINANCE_FUTURES_WS}`);

// ─── Placeholder — full implementation in next stage ─────────────────────────
// Next stage will implement:
//   - Binance spot & futures WebSocket streams
//   - Live price & trade data  →  Redis
//   - Aggregation & persistence  →  MySQL
//   - Hooks for: impulse, large-order, pump/dump, knife-catch, wall-break/bounce

setInterval(() => {
  console.log('[collector] Running... waiting for next-stage implementation.');
}, 30_000);
