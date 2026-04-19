const axios = require('axios');
const jar = require('tough-cookie').CookieJar;
const wrapper = require('axios-cookiejar-support').wrapper;

async function fetchTest() {
  try {
    const client = wrapper(axios.create({ jar: new jar() }));
    const ref = 'https://vsembed.ru/';
    
    const r1 = await client.get('https://vsembed.ru/embed/movie/693134', { headers: {'User-Agent': 'Mozilla/5.0'} });
    const match1 = r1.data.match(/src=["']\/\/cloudnestra\.com\/rcp\/([^"']+)["']/i);
    const wrapUrl = 'https://cloudnestra.com/rcp/' + match1[1];
    
    const r2 = await client.get(wrapUrl, { headers: {'Referer': ref, 'User-Agent': 'Mozilla/5.0'} });
    const match2 = r2.data.match(/src:\s*["'](\/\S+)["']/);
    
    const playUrl = 'https://cloudnestra.com' + match2[1];
    const r3 = await client.get(playUrl, { headers: {'Referer': 'https://cloudnestra.com/', 'User-Agent': 'Mozilla/5.0'} });
    
    console.log('[HTML Length]', r3.data.length);
    
    const subMatch = r3.data.match(/(subtitle|tracks):\s*(["'][^"']+["']|\[[^\]]+\])/i);
    if (subMatch) {
      console.log('--- FOUND SUBTITLES ---');
      console.log(subMatch[0].substring(0, 500));
    } else {
      console.log('No subtitle key found.');
    }

  } catch(e) {
    console.error('err', e.message);
  }
}
fetchTest();
