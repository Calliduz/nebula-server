const fetch = require('node-fetch');

async function clearCache() {
  console.log('📡 Sending cache clear pulse...');
  try {
    const res = await fetch('http://localhost:4000/api/cache/clear', {
      method: 'POST'
    });
    
    if (res.ok) {
      const data = await res.json();
      console.log('✅ PROTOCOL SUCCESS:', data.message);
    } else {
      console.error('❌ PROTOCOL ERROR:', res.status, res.statusText);
    }
  } catch (err) {
    console.error('❌ CONNECTION FAILED: Make sure the server is running on port 4000.');
    console.error(err.message);
  }
}

clearCache();
