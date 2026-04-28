import initCycleTLS from 'cycletls';
import { gotScraping } from "got-scraping";
import { CookieJar } from "tough-cookie";

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

let cycleTLSInstance: any = null;
const cycleTLSPromise = (initCycleTLS as any)().then((c: any) => {
  cycleTLSInstance = c;
  console.log('[BYPASS] 🛡️ CycleTLS JA3 Spoofer Initialized.');
  return c;
}).catch((err: any) => {
  console.error('[BYPASS] ✘ CycleTLS Init Failed:', err);
});

export const sharedCookieJar = new CookieJar();

export async function fetchWithCycleTLS(url: string, headers: any = {}, proxy?: string, method: string = 'get', body?: any) {
  const instance = cycleTLSInstance || await cycleTLSPromise;
  if (!instance) throw new Error("CycleTLS not initialized");
  
  const defaultHeaders = {
    'accept': '*/*',
    'accept-language': 'en-US,en;q=0.7',
    'cache-control': 'no-cache',
    'user-agent': UA
  };

  const finalHeaders = { ...defaultHeaders, ...headers };

  const options: any = {
    headers: finalHeaders,
    ja3: '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-21,29-23-24,0',
    userAgent: finalHeaders['user-agent'] || UA,
    timeout: 30
  };
  
  if (body) options.body = typeof body === 'string' ? body : JSON.stringify(body);
  if (proxy) options.proxy = proxy.startsWith("http") ? proxy : `http://${proxy}`;

  const res = await instance(url, options, method.toLowerCase() as any);
  
  let bodyBuffer: Buffer;
  if (typeof res.data === 'string') {
    bodyBuffer = Buffer.from(res.data, 'utf-8');
  } else if (res.data && typeof res.data === 'object') {
    bodyBuffer = Buffer.from(Object.values(res.data) as number[]);
  } else {
    bodyBuffer = Buffer.from('');
  }
  
  return {
    statusCode: res.status || 500,
    headers: res.headers || {},
    body: bodyBuffer,
    finalUrl: res.finalUrl || url
  };
}

export async function fetchWithGotScraping(url: string, headers: any = {}, proxy?: string, method: string = 'get', body?: any) {
  const origin = new URL(url).origin;
  const options: any = {
    method: method.toUpperCase(),
    headers: { 
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'en-US,en;q=0.9',
      'sec-ch-ua': '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'user-agent': UA,
      ...headers 
    },
    cookieJar: sharedCookieJar,
    responseType: 'buffer',
    retry: { limit: 0 },
    timeout: { request: 15000 },
    http2: true
  };

  if (body) options.body = typeof body === 'string' ? body : JSON.stringify(body);
  if (proxy) options.proxyUrl = proxy.startsWith("http") ? proxy : `http://${proxy}`;

  try {
    const response = await gotScraping(url, options);
    return {
      statusCode: response.statusCode,
      headers: response.headers,
      body: response.body,
      finalUrl: response.url
    };
  } catch (err: any) {
    if (err.response) {
      return {
        statusCode: err.response.statusCode,
        headers: err.response.headers,
        body: err.response.body,
        finalUrl: err.response.url
      };
    }
    throw err;
  }
}
