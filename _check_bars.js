'use strict';
const mysql = require('mysql2/promise');

async function main() {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST || 'mysql',
    user: process.env.DB_USER || 'trackista',
    password: process.env.DB_PASS || process.env.DB_PASSWORD || 'trackista',
    database: process.env.DB_NAME || 'trackista',
  });

  // Overall stats
  const [[r]] = await db.execute(
    "SELECT COUNT(*) cnt, FROM_UNIXTIME(MIN(ts)/1000) oldest, FROM_UNIXTIME(MAX(ts)/1000) newest FROM symbol_bars_1m WHERE symbol='ETHUSDT' AND market='futures'"
  );
  console.log('ETHUSDT total:', r.cnt, '| oldest:', r.oldest, '| newest:', r.newest);

  // Last 24h gaps
  const yesterday = Date.now() - 86400000;
  const [rows] = await db.execute(
    "SELECT ts FROM symbol_bars_1m WHERE symbol='ETHUSDT' AND market='futures' AND ts>=? ORDER BY ts ASC",
    [yesterday]
  );
  let gaps = 0;
  for (let i = 1; i < rows.length; i++) {
    const diff = rows[i].ts - rows[i-1].ts;
    if (diff > 120000) {
      gaps++;
      console.log('  gap:', new Date(rows[i-1].ts).toISOString(), '->', new Date(rows[i].ts).toISOString(), '~', Math.round(diff / 60000), 'min');
    }
  }
  console.log('24h bars:', rows.length, ' gaps>2m:', gaps);

  // Top symbols by missing bars today
  const [symbols] = await db.execute(
    "SELECT symbol, COUNT(*) cnt FROM symbol_bars_1m WHERE market='futures' AND ts>=? GROUP BY symbol ORDER BY cnt DESC LIMIT 5",
    [yesterday]
  );
  console.log('\nTop symbols by 24h bar count:');
  for (const s of symbols) console.log(' ', s.symbol, s.cnt, 'bars');

  await db.end();
}
main().catch(e => console.error(e.message));
