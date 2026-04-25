import initCycleTLS from 'cycletls';
async function run() {
  const cycleTLS = await initCycleTLS();
  const res = await cycleTLS('https://www.google.com', {}, 'get');
  console.log('Type of data:', typeof res.data);
  cycleTLS.exit();
}
run();
