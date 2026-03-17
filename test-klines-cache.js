const http = require('http');

console.log('=== Klines caching test (preview charts) ===');
console.log('');

// Test 1: First klines request
console.log('1. First BTCUSDT 1h klines request (limit=100)...');
const startTime1 = Date.now();
const req1 = http.get('http://localhost:3000/api/binance/futures/v1/klines?symbol=BTCUSDT&interval=1h&limit=100', res1 => {
  let data1 = '';
  res1.on('data', chunk => { data1 += chunk; });
  res1.on('end', () => {
    const time1 = Date.now() - startTime1;
    console.log(`   Status: ${res1.statusCode}`);
    console.log(`   Cache: ${res1.headers['x-proxy-cache']}`);
    console.log(`   Time: ${time1}ms`);
    console.log(`   Size: ${(data1.length/1024).toFixed(1)}KB`);
    console.log('');
    
    // Test 2: Same request again (should hit cache)
    setTimeout(() => {
      console.log('2. Same request again (should hit cache)...');
      const startTime2 = Date.now();
      const req2 = http.get('http://localhost:3000/api/binance/futures/v1/klines?symbol=BTCUSDT&interval=1h&limit=100', res2 => {
        let data2 = '';
        res2.on('data', chunk => { data2 += chunk; });
        res2.on('end', () => {
          const time2 = Date.now() - startTime2;
          console.log(`   Status: ${res2.statusCode}`);
          console.log(`   Cache: ${res2.headers['x-proxy-cache']}`);
          console.log(`   Time: ${time2}ms`);
          console.log(`   Size: ${(data2.length/1024).toFixed(1)}KB`);
          console.log(`   Speedup: ${(time1/time2).toFixed(1)}x`);
          console.log('');
          
          // Test 3: Different symbol (new request)
          setTimeout(() => {
            console.log('3. Different symbol ETHUSDT...');
            const startTime3 = Date.now();
            const req3 = http.get('http://localhost:3000/api/binance/futures/v1/klines?symbol=ETHUSDT&interval=1h&limit=100', res3 => {
              let data3 = '';
              res3.on('data', chunk => { data3 += chunk; });
              res3.on('end', () => {
                const time3 = Date.now() - startTime3;
                console.log(`   Status: ${res3.statusCode}`);
                console.log(`   Cache: ${res3.headers['x-proxy-cache']}`);
                console.log(`   Time: ${time3}ms`);
                console.log('');
                
                // Check debug metrics
                setTimeout(() => {
                  const req4 = http.get('http://localhost:3000/api/binance/debug', res4 => {
                    let data4 = '';
                    res4.on('data', chunk => { data4 += chunk; });
                    res4.on('end', () => {
                      const debug = JSON.parse(data4);
                      console.log('=== Final Metrics ===');
                      console.log('Cache hits:', debug.cache.hits);
                      console.log('Cache misses:', debug.cache.misses);
                      console.log('Hit rate:', debug.cache.hitRate);
                      console.log('Cache entries:', debug.cache.totalEntries);
                      console.log('');
                      console.log('Screener klines preview cache hits:', debug.screenerMetrics.klinesPreviewCacheHits);
                      console.log('');
                      console.log('Request counts:');
                      Object.entries(debug.requestCounts).sort((a,b) => b[1]-a[1]).slice(0, 5).forEach(([k,v]) => {
                        console.log(`  ${k}: ${v}`);
                      });
                      process.exit(0);
                    });
                  });
                  req4.on('error', err => console.error(err));
                }, 100);
              });
            });
            req3.on('error', err => console.error(err));
          }, 100);
        });
      });
      req2.on('error', err => console.error(err));
    }, 100);
  });
});
req1.on('error', err => console.error(err));
