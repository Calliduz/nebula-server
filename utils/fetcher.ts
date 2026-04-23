import axios from 'axios';
import https from 'https';
import fs from 'fs';
import path from 'path';
import type { Fetcher, FetcherResponse } from '@movie-web/providers';
import puppeteerPool from './puppeteerPool.js';

// Global axios instance with stealth headers
const client = axios.create({
    httpsAgent: new https.Agent({ keepAlive: true, rejectUnauthorized: false }),
    timeout: 20000,
    maxRedirects: 10,
});

// ── Session Store ─────────────────────────────────────────
class SessionStore {
    private sessionPath: string;
    private userAgent: string;
    private cookies: string;
    private saveTimeout: NodeJS.Timeout | null = null;

    constructor() {
        this.sessionPath = path.join(process.cwd(), 'data', 'session.json');
        this.userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
        this.cookies = '';
        const dataDir = path.dirname(this.sessionPath);
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        this.load();
    }

    update(cookies: string, ua: string) {
        let changed = false;
        if (cookies && cookies !== this.cookies) { this.cookies = cookies; changed = true; }
        if (ua && ua !== this.userAgent) { this.userAgent = ua; changed = true; }
        if (changed) this.save();
    }

    private save() {
        if (this.saveTimeout) return;
        this.saveTimeout = setTimeout(() => {
            try {
                fs.writeFileSync(this.sessionPath, JSON.stringify({ cookies: this.cookies, userAgent: this.userAgent }), 'utf8');
            } catch { /* silent */ } finally { this.saveTimeout = null; }
        }, 3000);
    }

    private load() {
        try {
            if (fs.existsSync(this.sessionPath)) {
                const data = JSON.parse(fs.readFileSync(this.sessionPath, 'utf8'));
                this.cookies = data.cookies || '';
                this.userAgent = data.userAgent || this.userAgent;
            }
        } catch { /* silent */ }
    }

    getHeaders(referer = '', extraHeaders: Record<string, string> = {}) {
        const headers: Record<string, string> = {
            'User-Agent': this.userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            ...extraHeaders,
        };
        if (this.cookies) headers['Cookie'] = this.cookies;
        if (referer) headers['Referer'] = referer;
        return headers;
    }
}

export const sessionStore = new SessionStore();

// ── Hybrid Fetch (Axios → Puppeteer on 403/530) ──────────
export async function hybridFetch(url: string, options: any = {}) {
    const { referer = '', json = false, forceBrowser = false, timeout = 15000 } = options;

    // Step 1: Try Fast HTTP first (if we have a session)
    if (!forceBrowser) {
        try {
            const headers = sessionStore.getHeaders(referer);
            if (json) headers['Accept'] = 'application/json, text/plain, */*';
            
            // Use a clean axios instance for the fast path
            const response = await axios.get(url, { 
                headers, 
                timeout: 8000,
                validateStatus: s => s < 400 
            });
            return response.data;
        } catch (error: any) {
            const status = error.response?.status;
            if (status !== 403 && status !== 530 && status !== 406) throw error;
            console.warn(`[Fetcher] 🛡️ Blocked (${status}). Engaging Browser Bypass...`);
        }
    }

    // Step 2: Browser Bypass (Always-On Browser)
    const browser = await puppeteerPool.acquire();
    const page = await browser.newPage();
    
    try {
        // ── THE BOUNCER: Block heavy/useless resources (ULTRA OPTIMIZATION) ──
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const resourceType = req.resourceType();
            const url = req.url().toLowerCase();
            
            // Block images, styles, fonts, and tracking scripts
            if (['image', 'stylesheet', 'font', 'media', 'other'].includes(resourceType) || 
                url.includes('google-analytics') || url.includes('doubleclick') || url.includes('beacon')) {
                req.abort();
            } else {
                req.continue();
            }
        });

        // Set realistic browser headers
        await page.setUserAgent(sessionStore.getHeaders()['User-Agent']);
        
        // Inject existing cookies if we have them
        if (sessionStore.getHeaders()['Cookie']) {
            const cookies = sessionStore.getHeaders()['Cookie'].split('; ').map((c: string) => {
                const [name, value] = c.split('=');
                return { name, value: value || '', domain: new URL(url).hostname };
            });
            await page.setCookie(...cookies).catch(() => {});
        }
        
        // Navigation - Fast Exit Strategy
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
        
        // Wait for Cloudflare to clear
        await page.waitForFunction(() => {
            const title = document.title.toLowerCase();
            const bodyText = document.body.innerText.toLowerCase();
            return !title.includes('just a moment') && 
                   !title.includes('cloudflare') && 
                   !bodyText.includes('checking your browser') &&
                   !bodyText.includes('enable javascript');
        }, { timeout: 10000 }).catch(() => {});

        // Save new cookies for the next fast HTTP request
        const cookiesList = await page.cookies();
        const cookieString = cookiesList.map(c => `${c.name}=${c.value}`).join('; ');
        sessionStore.update(cookieString, await page.evaluate(() => navigator.userAgent));
        
        // Extract data
        if (json) {
            const text = await page.evaluate(() => document.body.innerText);
            try { return JSON.parse(text); } catch { 
                // Fallback: search for JSON in the text
                const match = text.match(/\{[\s\S]*\}/);
                return match ? JSON.parse(match[0]) : text;
            }
        }
        return await page.content();
    } finally {
        // Always close the page, but KEEP the browser open in the pool
        await page.close().catch(() => {});
    }
}

// ── Embed HLS Interceptor (for fallback) ─────────────────
// Loads an embed URL in a headless browser and intercepts the m3u8 manifest
export async function extractHlsFromEmbed(embedUrl: string, timeoutMs = 15000): Promise<string | null> {
    const browser = await puppeteerPool.acquire();
    const page = await browser.newPage();
    let captured: string | null = null;

    try {
        // ── THE BOUNCER & THE TRAP ──────────────────────────────────
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const url = req.url();
            const type = req.resourceType();

            // 1. Block heavy stuff
            if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
                return req.abort();
            }

            // 2. THE TRAP: Catch m3u8 as it flies by in the request stream (faster than response)
            if (url.includes('.m3u8')) {
                captured = url;
                // Don't abort yet, we need to resolve the promise first
                req.continue(); 
                return;
            }

            req.continue();
        });

        // Also check responses for more reliability
        page.on('response', (res) => {
            const url = res.url();
            if (!captured && url.includes('.m3u8')) {
                captured = url;
            }
        });

        await page.setUserAgent(sessionStore.getHeaders()['User-Agent']);
        
        // ── Navigation ─────────────────────────────────────────────
        // We use a Promise.race to allow for "Early Exit"
        const result = await Promise.race([
            // Path A: Load the page and simulate clicks
            (async () => {
                await page.goto(embedUrl, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
                
                // Clicking triggers more dynamic requests
                const clickCenter = async () => {
                    try {
                        const { width, height } = await page.evaluate(() => ({
                            width: window.innerWidth,
                            height: window.innerHeight
                        }));
                        await page.mouse.click(Math.floor(width / 2), Math.floor(height / 2));
                    } catch { /* silent */ }
                };

                for (let i = 0; i < 3; i++) {
                    if (captured) break;
                    await clickCenter();
                    await new Promise(r => setTimeout(r, 1500));
                }
            })(),
            // Path B: Watchdog that resolves as soon as 'captured' is true
            (async () => {
                while (!captured) {
                    await new Promise(r => setTimeout(r, 200));
                    // Check if parent scope's captured was set by the listener
                }
            })(),
            // Path C: Safety timeout
            new Promise(r => setTimeout(r, timeoutMs))
        ]);

        return captured;
    } catch (e: any) {
        console.warn(`[EmbedExtractor] Failed for ${embedUrl}: ${e.message}`);
        return null;
    } finally {
        await page.close().catch(() => {});
    }
}

// ── @movie-web/providers Adapter ──────────────────────────
// The Fetcher type requires: { statusCode, headers, finalUrl, body }
export const makeHybridFetcher = (): Fetcher => {
    return async <T = unknown>(url: string, ops: any): Promise<FetcherResponse<T>> => {
        try {
            // Fix relative URLs (e.g. /search.html)
            if (url.startsWith('/')) {
                if (ops?.baseUrl) {
                    url = new URL(url, ops.baseUrl).toString();
                } else {
                    throw new Error(`Relative URL but no baseUrl provided`);
                }
            } else if (!url.startsWith('http')) {
                if (ops?.baseUrl) {
                    url = new URL(url, ops.baseUrl).toString();
                }
            }

            const customHeaders = ops?.headers ?? {};
            const isJson = (customHeaders['Accept'] ?? '').includes('json');
            const headers = sessionStore.getHeaders(customHeaders['Referer'] ?? '', customHeaders);

            const response = await client.get(url, {
                headers,
                validateStatus: () => true, // Never throw on status
                responseType: 'text',
            });

            let body: T;
            const ct = String(response.headers['content-type'] ?? '');
            if (isJson || ct.includes('json')) {
                try { body = JSON.parse(response.data) as T; }
                catch { body = response.data as T; }
            } else {
                body = response.data as T;
            }

            const finalUrl = (response.request as any)?.res?.responseUrl ?? url;

            const responseHeaders: Record<string, string> = {};
            for (const [k, v] of Object.entries(response.headers)) {
                if (v !== undefined) responseHeaders[k] = Array.isArray(v) ? v.join(', ') : String(v);
            }

            return { statusCode: response.status, headers: responseHeaders, finalUrl, body };
        } catch (e: any) {
            // Keep the console clean from normal provider connection failures
            return { statusCode: 503, headers: {}, finalUrl: url, body: null as T };
        }
    };
};
