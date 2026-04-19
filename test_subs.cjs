const axios = require('axios');
const fs = require('fs');

async function fetchTest() {
  try {
    const r1 = await axios.get('https://vsembed.ru/embed/movie/693134', { headers: {'User-Agent': 'Mozilla/5.0'} });
    fs.writeFileSync('dump_vsembed.html', r1.data);
    console.log('Dump written to file!');
  } catch(e) {
    console.error('err', e.message);
  }
}
fetchTest();
