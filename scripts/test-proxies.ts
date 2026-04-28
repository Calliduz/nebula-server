import fs from 'fs';
import axios from 'axios';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpProxyAgent } from 'http-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';

// CONFIGURATION
const TARGET_URL = 'https://cloudnestra.com/';
const TIMEOUT = 4000; // 4s is enough for a good proxy
const CONCURRENCY = 200; 
const OUTPUT_FILE = './proxies_verified.json';

interface ProxyItem {
    url: string;
    protocol: string;
}

async function loadProxies(): Promise<ProxyItem[]> {
    const list: ProxyItem[] = [];
    
    const files = [
        { name: 'http.txt', protocol: 'http' },
        { name: 'socks4.txt', protocol: 'socks4' },
        { name: 'socks5.txt', protocol: 'socks5' }
    ];

    for (const file of files) {
        if (fs.existsSync(file.name)) {
            const content = fs.readFileSync(file.name, 'utf-8');
            const lines = content.split(/\r?\n/).filter(l => l.trim().includes(':'));
            lines.forEach(l => {
                list.push({ url: `${file.protocol}://${l.trim()}`, protocol: file.protocol });
            });
            console.log(`Loaded ${lines.length} from ${file.name}`);
        }
    }

    console.log(`Total proxies to check: ${list.length}`);
    return list;
}

async function testProxy(proxy: ProxyItem): Promise<boolean> {
    try {
        let agent;
        if (proxy.protocol.startsWith('socks')) {
            agent = new SocksProxyAgent(proxy.url);
        } else if (proxy.protocol === 'http') {
            agent = new HttpProxyAgent(proxy.url);
        } else {
            agent = new HttpsProxyAgent(proxy.url);
        }

        const response = await axios.get(TARGET_URL, {
            httpAgent: agent,
            httpsAgent: agent,
            timeout: TIMEOUT,
            // 403 Forbidden means Cloudflare detected the scraper, we want proxies that AVOID 403
            // 200 or 404 is technically "unblocked" by IP filter
            validateStatus: (s) => (s >= 200 && s < 400) || s === 404,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
            }
        });

        if (response.status < 400 || response.status === 404) {
             return true;
        }
        return false;
    } catch (e) {
        return false;
    }
}

async function main() {
    const proxies = await loadProxies();
    const working: string[] = [];
    let processed = 0;
    
    console.log(`Starting validation against ${TARGET_URL}...`);
    
    // Create output file early
    fs.writeFileSync(OUTPUT_FILE, '[]');

    for (let i = 0; i < proxies.length; i += CONCURRENCY) {
        const batch = proxies.slice(i, i + CONCURRENCY);
        const startTime = Date.now();
        
        const results = await Promise.all(batch.map(async (p) => {
            const ok = await testProxy(p);
            if (ok) {
                working.push(p.url);
                // Log only successes to avoid flooding, but keep terminal alive
                process.stdout.write('✔'); 
            } else {
                process.stdout.write('.');
            }
            return ok;
        }));
        
        processed += batch.length;
        const elapsed = (Date.now() - startTime) / 1000;
        
        console.log(`\nBatch done. Progress: ${processed}/${proxies.length}. Found ${working.length} working. (${elapsed.toFixed(1)}s)`);
        
        if (working.length > 0) {
            fs.writeFileSync(OUTPUT_FILE, JSON.stringify(working, null, 2));
        }
    }

    console.log(`\n\nFinished! Total working proxies: ${working.length}`);
}

main().catch(console.error);
