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

// Random residential IP generator for spoofing
const randomIP = () => {
  const p = () => Math.floor(Math.random() * 255);
  // Avoid private/reserved ranges (simplified)
  let first = p();
  while ([0, 10, 127, 169, 172, 192].includes(first)) first = p();
  return `${first}.${p()}.${p()}.${p()}`;
};

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
    const spoofedIP = randomIP();
    const headers: Record<string, string> = {
      "User-Agent": this.userAgent,
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      Connection: "keep-alive",
      "X-Forwarded-For": spoofedIP,
      "X-Real-IP": spoofedIP,
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

  // 4. Puppeteer (DISABLED to save RAM)
  console.warn(`${logPrefix} ✘ Rapid Bypass failed. Browser fallback is DISABLED to save RAM.`);
  return null;
}

// ── Embed HLS Interceptor (DISABLED to save RAM) ─────────
export async function extractHlsFromEmbed(
  embedUrl: string,
  timeoutMs = 15000,
): Promise<string | null> {
  console.warn(`[EmbedExtractor] Browser-based extraction is DISABLED to save RAM.`);
  return null;
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
        headers: new Headers(responseHeaders) as any,
        finalUrl,
        body,
      };
    } catch (e: any) {
      // Keep the console clean from normal provider connection failures
      return { 
        statusCode: 503, 
        headers: new Headers() as any, 
        finalUrl: url, 
        body: null as T 
      };
    }
  };
};
