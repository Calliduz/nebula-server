import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

const proxyServer = "global-pr.talordata.net:5000";
const agent = new HttpsProxyAgent(`http://${proxyServer}`);

async function test() {
    console.log(`Testing residential proxy with provider URL: ${proxyServer}...`);
    try {
        const response = await axios.get('http://ipinfo.talordata.com', {
            httpAgent: agent,
            httpsAgent: agent,
            timeout: 10000
        });
        console.log('SUCCESS!');
        console.log('Response:', response.data);
    } catch (err) {
        console.error('FAILED!');
        console.error(err.message);
    }
}

test();
