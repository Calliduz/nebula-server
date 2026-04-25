import initCycleTLS from 'cycletls';
async function run() {
  const cycleTLS = await initCycleTLS();
  const res = await cycleTLS('https://upload.wikimedia.org/wikipedia/commons/2/2c/Rotating_earth_%28large%29.gif', {}, 'get');
  const buf = Buffer.from(Object.values(res.data) as number[]);
  console.log('Buffer size:', buf.length);
  cycleTLS.exit();
}
run();
