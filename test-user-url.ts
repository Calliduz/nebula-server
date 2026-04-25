import initCycleTLS from 'cycletls';
async function run() {
  const cycleTLS = await initCycleTLS();
  const url = 'https://storm.vodvidl.site/proxy/file2/N~RXyv7wClo~jaGeCt++b~zszNQYAQfjqNG41UbrRwPKzf2PzBp9WTawGPg0qQmCv9G+sudil4I1SZQfYkszeVzGG8XUrxbCn3iF7qecePB~c+RRaSXea6Hj0wh5oKKcbH1euZtiy8lxrP34HxBzPP4P3Pw9QHyH2TfF4lGqnMA=/cGxheWxpc3QubTN1OA==.m3u8';
  try {
    const res = await cycleTLS(url, {
      headers: {
        'referer': 'https://vidlink.pro/',
        'origin': 'https://vidlink.pro',
      },
      ja3: '771,4865-4867-4866-49195-49199-52393-52392-49196-49200-49162-49161-49171-49172-51-57-47-53-10,0-23-65281-10-11-35-16-5-51-43-13-45-28-21,29-23-30-25-24,0-1-2',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }, 'get');
    console.log('Status:', res.status);
    console.log('Body:', typeof res.data === 'string' ? res.data.substring(0, 100) : 'binary');
  } catch (e: any) {
    console.error('Error:', e.message);
  }
  cycleTLS.exit();
}
run();
