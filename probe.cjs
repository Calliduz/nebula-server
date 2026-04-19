// Full 4-layer probe — L1 through L3 using plain Node.js https
const https = require('https');

function get(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        ...headers
      }
    };
    const req = https.request(opts, res => {
      let data = '';
      const cookies = res.headers['set-cookie'] || [];
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data, cookies }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('TIMEOUT')); });
    req.end();
  });
}

(async () => {
  try {
    // L1
    console.log('=== LAYER 1 ===');
    const l1 = await get('https://vsembed.ru/embed/movie/687163', { 'Referer': 'https://vsembed.ru/' });
    console.log('Status:', l1.status);
    const cloudSrc = l1.body.match(/["'](\/\/cloudnestra\.com\/rcp\/[^"']{20,})["']/);
    if (!cloudSrc) { console.log('FAIL: no cloudnestra src'); return; }
    const wrapperUrl = 'https:' + cloudSrc[1];
    console.log('OK: wrapper =', wrapperUrl.substring(0, 80) + '...');

    // L2
    console.log('\n=== LAYER 2 ===');
    const l2 = await get(wrapperUrl, { 'Referer': 'https://vsembed.ru/' });
    console.log('Status:', l2.status);
    console.log('Cookies:', l2.cookies.join(' | ').substring(0, 200));
    const prorcp = l2.body.match(/src:\s*['"](\/?prorcp\/[^'"]+)['"]/i);
    if (!prorcp) {
      console.log('FAIL: no prorcp path');
      console.log('Body sample:', l2.body.substring(0, 1000));
      return;
    }
    const prorpcPath = prorcp[1].startsWith('/') ? prorcp[1] : '/' + prorcp[1];
    const playerUrl = 'https://cloudnestra.com' + prorpcPath;
    console.log('OK: player =', playerUrl.substring(0, 80) + '...');

    // L3
    console.log('\n=== LAYER 3 ===');
    const cookieHeader = l2.cookies.map(c => c.split(';')[0]).join('; ');
    const l3 = await get(playerUrl, {
      'Referer': 'https://cloudnestra.com/',
      'Cookie': cookieHeader
    });
    console.log('Status:', l3.status);
    
    const fileMatch = l3.body.match(/file:\s*["']([^"']+)["']/i);
    if (!fileMatch) {
      console.log('FAIL: no file: property');
      console.log('Body sample:', l3.body.substring(0, 3000));
      return;
    }
    const rawFile = fileMatch[1];
    console.log('OK: raw file string =', rawFile.substring(0, 120) + '...');
    
    const streams = rawFile.split(' or ').map(s => s.trim()).filter(s => s.includes('.m3u8'));
    console.log('\nFINAL STREAMS:', streams.length);
    streams.forEach((s, i) => console.log('[' + (i+1) + ']', s.substring(0, 100)));
    
    // Ping URL
    const pingMatch = l3.body.match(/["'](\/\/[^"']+rt_ping\.php[^"']*)["']/i);
    console.log('\nPING URL:', pingMatch ? 'https:' + pingMatch[1] : 'not found (will use static fallback)');

  } catch (e) {
    console.error('Error:', e.message);
  }
})();
