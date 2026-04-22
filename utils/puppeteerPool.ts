import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import type { Browser } from 'puppeteer';

puppeteer.use(StealthPlugin());

class PuppeteerPool {
    private browser: Browser | null = null;
    private initializing: Promise<Browser> | null = null;

    async acquire(): Promise<Browser> {
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
        });

        return this.browser;
    }

    async shutdown() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
        }
    }
}

export default new PuppeteerPool();
