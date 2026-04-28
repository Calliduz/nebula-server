import axios from "axios";
import https from "https";
import fs from "fs";
import path from "path";
import type { Fetcher, FetcherResponse } from "@movie-web/providers";
import puppeteerPool from "./puppeteerPool.js";
import {
  fetchWithCycleTLS,
  fetchWithGotScraping,
  sharedCookieJar,
} from "./bypass.js";

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
    this.sessionPath = path.join(process.cwd(), "data", "session.json");
    this.userAgent =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";
    this.cookies = "";
    const dataDir = path.dirname(this.sessionPath);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    this.load();
  }

  update(cookies: string, ua: string) {
    let changed = false;
    if (cookies && cookies !== this.cookies) {
      this.cookies = cookies;
      changed = true;
    }
    if (ua && ua !== this.userAgent) {
      this.userAgent = ua;
      changed = true;
    }
    if (changed) this.save();
  }

  private save() {
    if (this.saveTimeout) return;
    this.saveTimeout = setTimeout(() => {
      try {
        fs.writeFileSync(
          this.sessionPath,
          JSON.stringify({ cookies: this.cookies, userAgent: this.userAgent }),
          "utf8",
        );
      } catch {
        /* silent */
      } finally {
        this.saveTimeout = null;
      }
    }, 3000);
  }

  private load() {
    try {
      if (fs.existsSync(this.sessionPath)) {
        const data = JSON.parse(fs.readFileSync(this.sessionPath, "utf8"));
        this.cookies = data.cookies || "";
        this.userAgent = data.userAgent || this.userAgent;

        // Also seed the shared cookie jar
        if (this.cookies) {
          this.cookies.split(";").forEach((c) => {
            try {
              sharedCookieJar.setCookieSync(c.trim(), "https://kisskh.do");
            } catch {}
          });
        }
      }
    } catch {
      /* silent */
    }
  }

  getHeaders(referer = "", extraHeaders: Record<string, string> = {}) {
    const headers: Record<string, string> = {
      "User-Agent": this.userAgent,
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      Connection: "keep-alive",
      ...extraHeaders,
    };
    if (this.cookies) headers["Cookie"] = this.cookies;
    if (referer) headers["Referer"] = referer;
    return headers;
  }
}

export const sessionStore = new SessionStore();

let isBypassing = false;

// ── Hybrid Fetch (Axios → Got → Puppeteer) ──────────────
export async function hybridFetch(url: string, options: any = {}) {
  const {
    referer = "",
    json = false,
    forceBrowser = false,
    timeout = 30000,
    signal = null,
  } = options;

  const logPrefix = `[Fetcher] [${new URL(url).pathname.split("/").pop()}]`;

  // 1. Try standard Axios (Bypass A)
  if (!forceBrowser) {
    try {
      const headers = sessionStore.getHeaders(referer);
      const response = await axios.get(url, { headers, timeout: 8000 });
      return response.data;
    } catch (error: any) {
      const status = error.response?.status;
      if (
        status &&
        status >= 400 &&
        status !== 403 &&
        status !== 530 &&
        status !== 406
      ) {
        console.error(`${logPrefix} ✘ Axios failed with ${status}: ${url}`);
        throw error;
      }

      // 2. Try High-Speed Got-Scraping (Bypass B - VidLink Style)
      try {
        console.log(`${logPrefix} ⚡ High-Speed Bypass (Got) engaged...`);
        const bypass = await fetchWithGotScraping(
          url,
          sessionStore.getHeaders(referer),
        );

        if (bypass.statusCode < 400) {
          console.log(`${logPrefix} ✅ Got Bypass Success!`);
          const text = bypass.body.toString("utf-8");
          if (json) {
            try {
              return JSON.parse(text);
            } catch {
              return text;
            }
          }
          return text;
        }

        if (bypass.statusCode === 404) {
          console.warn(
            `${logPrefix} ✘ 404 Not Found (Got). Path might be invalid.`,
          );
        } else {
          console.warn(
            `${logPrefix} ✘ Got Bypass failed (${bypass.statusCode}). Trying CycleTLS...`,
          );
        }

        // 3. Try CycleTLS (Bypass C)
        const cycleBypass = await fetchWithCycleTLS(
          url,
          sessionStore.getHeaders(referer),
        );
        if (cycleBypass.statusCode < 400) {
          console.log(`${logPrefix} ✅ CycleTLS Bypass Success!`);
          const text = cycleBypass.body.toString("utf-8");
          if (json) {
            try {
              return JSON.parse(text);
            } catch {
              return text;
            }
          }
          return text;
        }
        console.warn(
          `${logPrefix} ✘ CycleTLS Bypass failed (${cycleBypass.statusCode}). Falling back to Puppeteer...`,
        );

        if (cycleBypass.statusCode === 403) {
          const bodySnippet = cycleBypass.body
            .toString("utf-8")
            .substring(0, 300);
          if (
            bodySnippet.includes("Turnstile") ||
            bodySnippet.includes("cloudflare")
          ) {
            console.log(
              `${logPrefix} 🛡️ Cloudflare Challenge Detected in response.`,
            );
          }
        }
      } catch (e: any) {
        console.warn(
          `${logPrefix} ✘ Rapid Bypass error: ${e.message}. Falling back to Puppeteer...`,
        );
      }
    }
  }

  // 4. Try Puppeteer (Bypass D - Slow)
  if (signal?.aborted) return null;
  
  if (isBypassing) {
    console.log(`${logPrefix} ⏳ Queueing for active browser bypass...`);
    while (isBypassing) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (signal?.aborted) return null;
    }
    console.log(`${logPrefix} 🚀 Browser bypass finished, retrying with new cookies...`);
    // Retry once with the fast methods now that we (hopefully) have new cookies
    return hybridFetch(url, { ...options, forceBrowser: false });
  }

  isBypassing = true;
  const browser = await puppeteerPool.acquire();
  puppeteerPool.trackPageOpen();
  const page = await browser.newPage();

  let cookieTimer: NodeJS.Timeout | null = null;
  let clickInterval: NodeJS.Timeout | null = null;

  try {
    if (signal?.aborted) throw new Error("Aborted");

    await page.setUserAgent(sessionStore.getHeaders()["User-Agent"]);
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      "sec-ch-ua":
        '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
    });

    const origin = new URL(url).origin;
    cookieTimer = setInterval(async () => {
      try {
        if (page.isClosed()) return;
        const cookies = await page.cookies();
        if (cookies.some((c) => c.name === "cf_clearance")) {
          const cookieStr = cookies
            .map((c) => `${c.name}=${c.value}`)
            .join("; ");
          sessionStore.update(
            cookieStr,
            await page.evaluate(() => navigator.userAgent),
          );
        }
      } catch (e) {}
    }, 1000);

    // 1. Visit Home (Always clear Cloudflare if we hit this stage)
    console.log(`[Fetcher] 🏠 Clearing Cloudflare for ${origin}...`);
    await page.goto(origin, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    // Turnstile Auto-Clicker Loop
    clickInterval = setInterval(async () => {
      try {
        const iframe = await page.$("iframe");
        if (iframe) {
          const box = await iframe.boundingBox();
          if (box && box.width > 0) {
            await page.mouse.click(
              box.x + box.width / 2,
              box.y + box.height / 2,
            );
          }
        }
      } catch (e) {}
    }, 2000);

    await page
      .waitForFunction(
        () => {
          const t = document.title.toLowerCase();
          return (
            t.includes("kisskh |") || 
            t.includes("asian dramas & movies") ||
            t.includes("vidlink") ||
            t.includes("vsembed")
          );
        },
        { timeout: 15000 },
      )
      .catch(() => {
        console.warn(`[Fetcher] ⚠️ Cloudflare wait timed out, proceeding anyway...`);
      });

    if (clickInterval) clearInterval(clickInterval);
    if (cookieTimer) clearInterval(cookieTimer);
    if (signal?.aborted) throw new Error("Aborted");

    // 2. Navigation to Target
    console.log(`${logPrefix} 🎯 Targeted Navigation: ${url}`);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

    // If JSON is expected, wait for the body to contain JSON-like structure
    if (json) {
      await page
        .waitForFunction(
          () => {
            const text = document.body.innerText.trim();
            return text.startsWith("[") || text.startsWith("{");
          },
          { timeout: 10000 },
        )
        .catch(() => {});
    }

    const finalCookies = await page.cookies();
    const finalCookieStr = finalCookies
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
    sessionStore.update(
      finalCookieStr,
      await page.evaluate(() => navigator.userAgent),
    );

    const text = await page.evaluate(() => document.body.innerText);
    if (json) {
      try {
        return JSON.parse(text);
      } catch {
        console.error(`${logPrefix} ✘ Failed to parse JSON. Content: ${text.substring(0, 100)}...`);
        return null;
      }
    }
    return text;
  } finally {
    if (cookieTimer) clearInterval(cookieTimer);
    if (clickInterval) clearInterval(clickInterval);
    isBypassing = false;
    await page.close().catch(() => {});
    puppeteerPool.trackPageClose();
  }
}

// ── Embed HLS Interceptor (for fallback) ─────────────────
// Loads an embed URL in a headless browser and intercepts the m3u8 manifest
export async function extractHlsFromEmbed(
  embedUrl: string,
  timeoutMs = 15000,
): Promise<string | null> {
  const browser = await puppeteerPool.acquire();
  puppeteerPool.trackPageOpen();
  const page = await browser.newPage();
  let captured: string | null = null;

  try {
    // ── THE BOUNCER & THE TRAP ──────────────────────────────────
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const url = req.url();
      const type = req.resourceType();

      // 1. Block heavy stuff
      if (["image", "stylesheet", "font", "media"].includes(type)) {
        return req.abort();
      }

      // 2. THE TRAP: Catch m3u8 as it flies by in the request stream (faster than response)
      if (url.includes(".m3u8")) {
        captured = url;
        // Don't abort yet, we need to resolve the promise first
        req.continue();
        return;
      }

      req.continue();
    });

    // Also check responses for more reliability
    page.on("response", (res) => {
      const url = res.url();
      if (!captured && url.includes(".m3u8")) {
        captured = url;
      }
    });

    await page.setUserAgent(sessionStore.getHeaders()["User-Agent"]);

    // ── Navigation ─────────────────────────────────────────────
    // We use a Promise.race to allow for "Early Exit"
    const result = await Promise.race([
      // Path A: Load the page and simulate clicks
      (async () => {
        await page
          .goto(embedUrl, { waitUntil: "domcontentloaded", timeout: 10000 })
          .catch(() => {});

        // Clicking triggers more dynamic requests
        const clickCenter = async () => {
          try {
            const { width, height } = await page.evaluate(() => ({
              width: window.innerWidth,
              height: window.innerHeight,
            }));
            await page.mouse.click(
              Math.floor(width / 2),
              Math.floor(height / 2),
            );
          } catch {
            /* silent */
          }
        };

        for (let i = 0; i < 3; i++) {
          if (captured) break;
          await clickCenter();
          await new Promise((r) => setTimeout(r, 1500));
        }
      })(),
      // Path B: Watchdog that resolves as soon as 'captured' is true
      (async () => {
        while (!captured) {
          await new Promise((r) => setTimeout(r, 200));
          // Check if parent scope's captured was set by the listener
        }
      })(),
      // Path C: Safety timeout
      new Promise((r) => setTimeout(r, timeoutMs)),
    ]);

    return captured;
  } catch (e: any) {
    console.warn(`[EmbedExtractor] Failed for ${embedUrl}: ${e.message}`);
    return null;
  } finally {
    await page.close().catch(() => {});
    puppeteerPool.trackPageClose();
  }
}

// ── @movie-web/providers Adapter ──────────────────────────
// The Fetcher type requires: { statusCode, headers, finalUrl, body }
export const makeHybridFetcher = (): Fetcher => {
  return async <T = unknown>(
    url: string,
    ops: any,
  ): Promise<FetcherResponse<T>> => {
    try {
      // Fix relative URLs (e.g. /search.html)
      if (url.startsWith("/")) {
        if (ops?.baseUrl) {
          url = new URL(url, ops.baseUrl).toString();
        } else {
          throw new Error(`Relative URL but no baseUrl provided`);
        }
      } else if (!url.startsWith("http")) {
        if (ops?.baseUrl) {
          url = new URL(url, ops.baseUrl).toString();
        }
      }

      const customHeaders = ops?.headers ?? {};
      const isJson = (customHeaders["Accept"] ?? "").includes("json");
      const headers = sessionStore.getHeaders(
        customHeaders["Referer"] ?? "",
        customHeaders,
      );

      const response = await client.get(url, {
        headers,
        validateStatus: () => true, // Never throw on status
        responseType: "text",
      });

      let body: T;
      const ct = String(response.headers["content-type"] ?? "");
      if (isJson || ct.includes("json")) {
        try {
          body = JSON.parse(response.data) as T;
        } catch {
          body = response.data as T;
        }
      } else {
        body = response.data as T;
      }

      const finalUrl = (response.request as any)?.res?.responseUrl ?? url;

      const responseHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(response.headers)) {
        if (v !== undefined)
          responseHeaders[k] = Array.isArray(v) ? v.join(", ") : String(v);
      }

      return {
        statusCode: response.status,
        headers: responseHeaders,
        finalUrl,
        body,
      };
    } catch (e: any) {
      // Keep the console clean from normal provider connection failures
      return { statusCode: 503, headers: {}, finalUrl: url, body: null as T };
    }
  };
};
