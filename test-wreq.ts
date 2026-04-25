import wreq from '@absahmad/wreq-js';
async function run() {
  try {
    const res = await wreq('https://upload.wikimedia.org/wikipedia/commons/2/2c/Rotating_earth_%28large%29.gif', {
      impersonate: 'chrome_120'
    });
    console.log('Status:', res.status);
    const buf = await res.arrayBuffer();
    console.log('ArrayBuffer byteLength:', buf.byteLength);
  } catch (e) { console.error(e); }
}
run();
