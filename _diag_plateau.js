'use strict';
const R = require('ioredis');
const r = new R({ host: 'redis', port: 6379 });

r.keys('bars:1m:*').then(async keys => {
  const futures = keys.filter(k => !k.startsWith('bars:1m:spot:'));
  const results = [];
  for (const key of futures) {
    const count_all = await r.zcard(key);
    const raw = await r.zrange(key, Math.max(0, count_all - 200), count_all - 1);
    const bars = raw.map(x => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
    if (bars.length < 10) continue;

    let maxRun = 1, curRun = 1, maxVolRun = 1, curVolRun = 1;
    let zeroTradeCount = 0;
    for (let i = 1; i < bars.length; i++) {
      const b = bars[i], p = bars[i - 1];
      if (b.open === p.open && b.high === p.high && b.low === p.low && b.close === p.close) { curRun++; }
      else { if (curRun > maxRun) maxRun = curRun; curRun = 1; }
      if (b.volumeUsdt === p.volumeUsdt) { curVolRun++; }
      else { if (curVolRun > maxVolRun) maxVolRun = curVolRun; curVolRun = 1; }
      if ((b.tradeCount ?? 0) === 0) zeroTradeCount++;
    }
    if (curRun > maxRun) maxRun = curRun;
    if (curVolRun > maxVolRun) maxVolRun = curVolRun;

    if (maxRun >= 5 || maxVolRun >= 10 || zeroTradeCount >= 5) {
      results.push({ sym: key.replace('bars:1m:', ''), maxOhlcRun: maxRun, maxVolRun, zeroTrades: zeroTradeCount, total: bars.length });
    }
  }
  results.sort((a, b) => b.maxOhlcRun - a.maxOhlcRun);
  console.log('=== Symbols with plateau / anomaly (last 200 bars) ===');
  console.log(JSON.stringify(results.slice(0, 20), null, 2));
  r.disconnect();
});
