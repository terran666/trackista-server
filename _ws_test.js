'use strict';
const { WebSocket } = require('ws');
const url = 'ws://127.0.0.1:3000/ws/fstream/bsbusdt@kline_1m';
console.log('Connecting to', url);
const ws = new WebSocket(url);
let count = 0;
ws.on('open', () => console.log('OPEN'));
ws.on('message', (data) => {
  count++;
  if (count <= 3) console.log('MSG', count, data.toString().slice(0, 120));
  if (count >= 5) { console.log('OK relay works, got 5 msgs'); ws.close(); }
});
ws.on('error', (e) => console.error('ERROR', e.message));
ws.on('close', (code, reason) => console.log('CLOSE', code, reason.toString(), 'msgs received:', count));
setTimeout(() => { console.log('TIMEOUT after 15s, msgs received:', count); ws.close(); }, 15000);
