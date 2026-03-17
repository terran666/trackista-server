const http = require('http');

console.log('=== In-flight deduplication test ===');
console.log('Sending 10 simultaneous exchangeInfo?symbol= requests...');
console.log('');

const symbols = ['BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','ADAUSDT','DOTUSDT','XRPUSDT','LTCUSDT','LINKUSDT','UNIUSDT'];
let completed = 0;
const startTime = Date.now();

symbols.forEach((symbol, i) => {
  setTimeout(() => {
    const req = http.get(`http://localhost:3000/api/binance/futures/v1/exchangeInfo?symbol=${symbol}`, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        const parsed = JSON.parse(data);
        console.log(`${i+1}. ${symbol} - cache: ${res.headers['x-proxy-cache']} - size: ${(data.length/1024).toFixed(1)}KB - symbols: ${parsed.symbols?.length}`);
        completed++;
        if (completed === symbols.length) {
          console.log('');
          console.log(`All requests completed in ${Date.now() - startTime}ms`);
          console.log('');
          
          // Check debug metrics
          setTimeout(() => {
            const req2 = http.get('http://localhost:3000/api/binance/debug', res2 => {
              let data2 = '';
              res2.on('data', chunk => { data2 += chunk; });
              res2.on('end', () => {
                const debug = JSON.parse(data2);
                console.log('=== Final Metrics ===');
                console.log('Cache hits:', debug.cache.hits);
                console.log('Cache misses:', debug.cache.misses);
                console.log('Dedupe hits:', debug.cache.dedupeHits);
                console.log('Hit rate:', debug.cache.hitRate);
                console.log('Cache entries:', debug.cache.totalEntries);
                console.log('');
                console.log('Screener:');
                console.log('  Normalized:', debug.screenerMetrics.exchangeInfoNormalized);
                console.log('  Full requests:', debug.screenerMetrics.exchangeInfoFullRequests);
                process.exit(0);
              });
            });
            req2.on('error', err => console.error(err));
          }, 200);
        }
      });
    });
    req.on('error', err => console.error(err));
  }, i * 10);  // slight stagger to simulate real load
});
