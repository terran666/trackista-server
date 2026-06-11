'use strict';
const R = require('ioredis');
const r = new R({ host: 'redis', port: 6379 });
const now = Date.now();
const TWO_HOURS = 2 * 3600 * 1000;

r.get('symbols:active:usdt').then(async raw => {
  const symbols = JSON.parse(raw);
  console.log('Active symbols:', symbols.length);

  const results = [];
  for (const sym of symbols) {
    const key = 'bars:1m:' + sym;
    const count = await r.zcard(key);
    if (count < 5) continue;

    // Get last 200 bars
    const rawBars = await r.zrange(key, Math.max(0, count - 200), count - 1);
    const bars = rawBars.map(x => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean);
    if (bars.length < 5) continue;

    // Only look at bars from last 2 hours
    const recentBars = bars.filter(b => b.ts > now - TWO_HOURS);
    if (recentBars.length < 5) continue;

    let maxRun = 1, curRun = 1;
    let maxVolRun = 1, curVolRun = 1;
    for (let i = 1; i < recentBars.length; i++) {
      const b = recentBars[i], p = recentBars[i - 1];
      if (b.open === p.open && b.high === p.high && b.low === p.low && b.close === p.close) { curRun++; }
      else { if (curRun > maxRun) maxRun = curRun; curRun = 1; }
      if (b.volumeUsdt === p.volumeUsdt) { curVolRun++; }
      else { if (curVolRun > maxVolRun) maxVolRun = curVolRun; curVolRun = 1; }
    }
    if (curRun > maxRun) maxRun = curRun;
    if (curVolRun > maxVolRun) maxVolRun = curVolRun;

    // Check metrics staleness
    const metRaw = await r.get('metrics:' + sym);
    const met = metRaw ? JSON.parse(metRaw) : null;
    const metAge = met ? Math.round((now - met.updatedAt) / 1000) : null;

    if (maxRun >= 5) {
      results.push({
        sym, maxOhlcRun: maxRun, maxVolRun, recentBars: recentBars.length,
        lastBarTs: new Date(recentBars[recentBars.length - 1].ts).toISOString(),
        metricsAgeS: metAge,
        sample: { O: recentBars[recentBars.length-1].open, V: recentBars[recentBars.length-1].volumeUsdt, T: recentBars[recentBars.length-1].tradeCount }
      });
    }
  }

  results.sort((a, b) => b.maxOhlcRun - a.maxOhlcRun);
  console.log('=== ACTIVE symbols with current plateau (last 2h) ===');
  console.log(JSON.stringify(results.slice(0, 20), null, 2));
  r.disconnect();
});
