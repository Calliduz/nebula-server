import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser } from 'puppeteer';

puppeteer.use(StealthPlugin());

class PuppeteerPool {
    private browser: Browser | null = null;
    private initializing: Promise<Browser> | null = null;
    private requestCount = 0;
    private readonly MAX_REQUESTS = 100;
    private activePages = 0;

    async acquire(): Promise<Browser> {
        this.requestCount++;
        if (this.browser && this.requestCount >= this.MAX_REQUESTS && this.activePages === 0) {
            console.log(`[Browser] Request limit reached (${this.requestCount}). Restarting...`);
            await this.shutdown();
        }
        if (this.browser) return this.browser;
        if (this.initializing) return this.initializing;

        this.initializing = puppeteer.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', // Corrects crashes on Render's shared memory limit
                '--disable-gpu',           // Saves RAM by disabling hardware acceleration
                '--disable-infobars',
                '--window-position=0,0',
                '--ignore-certifcate-errors',
                '--ignore-certifcate-errors-spki-list',
                '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
            ]
        }) as unknown as Promise<Browser>;

        this.browser = await this.initializing;
        this.initializing = null;

        this.browser.on('disconnected', () => {
            console.log('[Browser] Instance disconnected. Purging from pool.');
            this.browser = null;
            this.activePages = 0;
        });

        return this.browser;
    }

    trackPageOpen() { this.activePages++; }
    trackPageClose() { this.activePages = Math.max(0, this.activePages - 1); }

    async shutdown() {
        if (this.browser) {
            console.log('[Browser] Shutting down instance...');
            const browserRef = this.browser;
            this.browser = null; // Prevent new acquisitions
            this.activePages = 0;

            try {
                // Racing close against a 5s timeout to prevent hanging the process
                await Promise.race([
                    browserRef.close(),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Browser close timeout')), 5000))
                ]);
                console.log('[Browser] Shutdown successful.');
            } catch (e: any) {
                console.error('[Browser] Shutdown forced/timed out:', e.message);
            }
        }
    }
}

export default new PuppeteerPool();
