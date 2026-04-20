/**
 * nebula-server/utils/scraper.ts
 *
 * 4-Layer HTTP Scraper Pipeline — vsembed → cloudnestra → m3u8
 *
 * Architecture:
 *   Layer 1 (Router)    vsembed.ru/embed/movie/{tmdbId}   → player_iframe src
 *   Layer 2 (Wrapper)   cloudnestra.com/rcp/{token}        → /prorcp/{path} via jQuery
 *   Layer 3 (PlayerJS)  cloudnestra.com/prorcp/{path}      → file:"..." + ping URL + token
 *   Layer 4 (Cleaning)  split by " or ", patch {vX} placeholders → clean m3u8 array
 *
 * Anti-detection:
 *   - Cookie Jar:    Persists Set-Cookie headers across all layers (session ID spoofing)
 *   - Heartbeat:     Replicates the rt_ping.php 60s interval with exact headers/cookies
 *   - CDN Fallback:  Auto-retries across backup CDN domains if the primary goes down
 *   - Header Parity: Every request matches what Chrome sends from cloudnestra.com
 *
 * Domain config:
 *   VIDSRC_EMBED_HOST in .env — swap if vsembed.ru ever changes domain
 */

import axios from "axios";
import { CookieJar } from "tough-cookie";
import {
  HttpCookieAgent,
  HttpsCookieAgent,
  createCookieAgent,
} from "http-cookie-agent/http";
import { SocksProxyAgent } from "socks-proxy-agent";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";

// ── Constants ───────────────────────────────────────────────────────────────

/** Internal CDN that serves the actual HLS streams. */
const CLOUDNESTRA_HOST = "https://cloudnestra.com";

/**
 * CDN fallback map — maps {v1}..{v5} placeholders to actual CDN domains.
 * Cloudnestra uses these interchangeably; if one goes down swap the domain here.
 * Discovered by probing the live pipeline.
 */
const CDN_DOMAIN_MAP: Record<string, string> = {
  "{v1}": "neonhorizonworkshops.com",
  "{v2}": "wanderlynest.com",
  "{v3}": "orchidpixelgardens.com",
  "{v4}": "cloudnestra.com",
  "{v5}": "cloudnestra.com", // app2.{v5} → app2.cloudnestra.com
};

/** Matches a real Chrome browser on Windows. Must be consistent across all requests. */
export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ── Types ───────────────────────────────────────────────────────────────────

export interface ScrapeResult {
  /** Best-quality .m3u8 URL (first in the array). */
  streamUrl: string;
  /** All available fallback .m3u8 URLs. */
  streams: string[];
  /** Human-readable source identifier. */
  source: string;
  /** Heartbeat session — pass to startHeartbeat() to keep the stream alive. */
  session: HeartbeatSession;
  /** Quality tag parsed from the release filename: CAM | TC | WEBDL | WEBRIP | BLURAY | HDTC | HD | UNKNOWN */
  qualityTag: string;
  /** Resolution parsed from the release filename: 4K | 1080p | 720p | 480p | UNKNOWN */
  resolution: string;
  /** The actual proxy URL used for the scrape (if any) — needed for manifest/heartbeat consistency. */
  proxyUsed: string | undefined;
}

export interface HeartbeatSession {
  /** Full URL to ping every 60 seconds. */
  pingUrl: string | null;
  /** Any query params extracted from the player (e.g. token, timestamp). */
  pingParams: Record<string, string>;
  /** The referer header to use when pinging. */
  pingReferer: string;
  /** Serialized cookies from the scrape session — attached to every ping. */
  cookieJar: CookieJar;
  /** Optional proxy URL to use for the heartbeat (MUST match the scrape IP). */
  proxyUrl: string | undefined;
}

// ── Heartbeat Manager ───────────────────────────────────────────────────────

/** Map of active heartbeat loops keyed by a session ID (tmdbId). */
const activeHeartbeats = new Map<string, NodeJS.Timeout>();

/**
 * startHeartbeat
 *
 * Begins the 60-second rt_ping.php loop for a given stream session.
 * Call immediately after scrapeVsembed() succeeds.
 *
 * @param sessionId  Unique key (use tmdbId) — used to cancel the loop later.
 * @param session    HeartbeatSession returned by scrapeVsembed().
 * @param proxyUrl   (Optional) The proxy used for the initial scrape.
 * @param userIp     (Optional) The IP of the user (enables multi-user support).
 */
export function startHeartbeat(
  sessionId: string,
  session: HeartbeatSession,
  proxyUrl?: string,
  userIp = "direct",
): void {
  if (!session.pingUrl) {
    console.log(
      `[HEARTBEAT] No ping URL found for session ${sessionId}. Skipping.`,
    );
    return;
  }

  // Cancel any existing heartbeat for THIS SPECIFIC USER and session before starting a new one
  const compositeKey = `${sessionId}:${userIp}`;
  stopHeartbeat(sessionId, userIp);

  const ping = async () => {
    try {
      // Build the correct agent: proxy + cookies must be composed together.
      // WRONG pattern: new HttpCookieAgent({ agent: new HttpsProxyAgent(...) })
      //   — HttpCookieAgent ignores the nested .agent property, proxy is silently dropped.
      // CORRECT pattern: createCookieAgent(HttpsProxyAgent) — same as createSession().
      const rawProxy = proxyUrl || session.proxyUrl;
      let httpAgent: any;
      let httpsAgent: any;

      if (rawProxy) {
        const sanitizedProxy = rawProxy.endsWith("/") ? rawProxy.slice(0, -1) : rawProxy;
        const HttpsCookieProxyAgent = createCookieAgent(HttpsProxyAgent);
        const proxyAgent = new HttpsCookieProxyAgent(sanitizedProxy, {
          cookies: { jar: session.cookieJar as any },
        });
        // Use the same composed agent for both HTTP and HTTPS
        httpAgent = proxyAgent;
        httpsAgent = proxyAgent;
      } else {
        // No proxy — still send cookies via plain cookie agents
        httpAgent = new HttpCookieAgent({ cookies: { jar: session.cookieJar as any } });
        httpsAgent = new HttpsCookieAgent({ cookies: { jar: session.cookieJar as any } });
      }

      const client = axios.create({ httpAgent, httpsAgent });

      await client.get(session.pingUrl!, {
        params: session.pingParams,
        headers: {
          "User-Agent": UA,
          Referer: session.pingReferer,
          Origin: new URL(session.pingUrl!).origin,
          Accept: "*/*",
          "Accept-Language": "en-US,en;q=0.9",
        },
        timeout: 8000,
      });
      console.log(
        `[HEARTBEAT] ♥ Ping sent for session ${sessionId} (IP: ${userIp})`,
      );
    } catch (e: any) {
      console.error(`[HEARTBEAT] Ping failed: ${e.message}`);
    }
  };

  // Send the first ping immediately, then every 55 seconds (5s buffer before their 60s kill)
  ping();
  const interval = setInterval(ping, 55_000);
  activeHeartbeats.set(compositeKey, interval);

  // Safety Kill: Automatically stop heartbeats after 4 hours to prevent "zombie" loops
  // if the user closes the tab without notifying the server.
  setTimeout(
    () => {
      if (activeHeartbeats.get(compositeKey) === interval) {
        console.log(
          `[HEARTBEAT] Hard timeout (4h) reached for session ${compositeKey}. Stopping.`,
        );
        stopHeartbeat(sessionId, userIp);
      }
    },
    4 * 60 * 60 * 1000,
  );

  console.log(
    `[HEARTBEAT] Started for session ${sessionId} (IP: ${userIp}) (Safety timeout: 4h)`,
  );
}

/**
 * stopHeartbeat
 *
 * Cancels the ping loop for a given session.
 * Call when the user stops watching or the player is closed.
 * @param sessionId  The tmdbId of the session.
 * @param userIp     The IP of the user (distinguishes between users).
 */
export function stopHeartbeat(sessionId: string, userIp = "direct"): void {
  const compositeKey = `${sessionId}:${userIp}`;
  const interval = activeHeartbeats.get(compositeKey);
  if (interval) {
    clearInterval(interval);
    activeHeartbeats.delete(compositeKey);
    console.log(`[HEARTBEAT] Stopped for session ${compositeKey}`);
  }
}

// ── Quality Tag Parser ─────────────────────────────────────────────────────

/**
 * parseQualityFromFilename
 *
 * Decodes the base64-encoded `flnm` variable from Cloudnestra's playerJS HTML
 * and extracts a quality classification and resolution string.
 *
 * Priority order (most specific → least specific):
 *   CAM / TS / TELESYNC / HDTS → qualityTag = 'CAM'
 *   TC / HDTC               → qualityTag = 'TC'
 *   WEB-DL / WEBDL           → qualityTag = 'WEBDL'
 *   WEBRip / WEBRIP          → qualityTag = 'WEBRIP'
 *   BluRay / BLURAY / BDRip  → qualityTag = 'BLURAY'
 *   HDRip / HDRIP            → qualityTag = 'HDRIP'
 *   WEB (generic)            → qualityTag = 'WEBDL'
 *
 * @param playerHtml  Raw HTML from the Cloudnestra /prorcp/ page.
 * @returns           { qualityTag, resolution, rawFilename }
 */
function parseQualityFromFilename(playerHtml: string): {
  qualityTag: string;
  resolution: string;
  rawFilename: string;
} {
  // Try to find var flnm = removeExtension(atob('...')); or just atob('...')
  const b64Match = playerHtml.match(/atob\(["']([A-Za-z0-9+/=]+)["']\)/i);

  if (!b64Match?.[1]) {
    console.log("[QUALITY] No base64 filename found — defaulting to UNKNOWN");
    return { qualityTag: "UNKNOWN", resolution: "UNKNOWN", rawFilename: "" };
  }

  let rawFilename = "";
  try {
    rawFilename = Buffer.from(b64Match[1], "base64").toString("utf-8");
  } catch {
    return { qualityTag: "UNKNOWN", resolution: "UNKNOWN", rawFilename: "" };
  }

  const upper = rawFilename.toUpperCase();
  console.log(`[QUALITY] Release name: ${rawFilename.substring(0, 80)}`);

  // ─ Resolution ─────────────────────────────────────────────────────────
  let resolution = "UNKNOWN";
  if (
    upper.includes("2160P") ||
    upper.includes("4K") ||
    upper.includes("UHD")
  ) {
    resolution = "4K";
  } else if (upper.includes("1080P")) {
    resolution = "1080p";
  } else if (upper.includes("720P")) {
    resolution = "720p";
  } else if (upper.includes("480P")) {
    resolution = "480p";
  }

  // ─ Source (most specific wins) ────────────────────────────────────────
  let qualityTag = "UNKNOWN";
  if (
    upper.includes("CAM") ||
    upper.includes("CAMRIP") ||
    upper.includes("HDCAM")
  ) {
    qualityTag = "CAM";
  } else if (
    upper.includes("TELESYNC") ||
    (upper.includes("TS") && !upper.includes("WEB")) ||
    upper.includes("HDTS")
  ) {
    qualityTag = "CAM";
  } else if (
    upper.includes("HDTC") ||
    (upper.includes("TC") && !upper.includes("DTC"))
  ) {
    qualityTag = "TC";
  } else if (upper.includes("WEB-DL") || upper.includes("WEBDL")) {
    qualityTag = "WEBDL";
  } else if (
    upper.includes("WEBRIP") ||
    upper.includes("WEB-RIP") ||
    upper.includes("WEBSCR")
  ) {
    qualityTag = "WEBRIP";
  } else if (
    upper.includes("BLURAY") ||
    upper.includes("BLU-RAY") ||
    upper.includes("BDRIP") ||
    upper.includes("BRRIP")
  ) {
    qualityTag = "BLURAY";
  } else if (upper.includes("HDRIP")) {
    qualityTag = "HDRIP";
  } else if (upper.includes("WEB")) {
    qualityTag = "WEBDL"; // Generic WEB → treat as WebDL
  }

  console.log(`[QUALITY] → qualityTag=${qualityTag}  resolution=${resolution}`);
  return { qualityTag, resolution, rawFilename };
}

// ── Internal Axios factory ──────────────────────────────────────────────────

/**
 * Creates a new axios instance with a shared CookieJar and optional proxy.
 * Uses http-cookie-agent to combine both functionalities.
 */
function createSession(proxyUrl?: string): {
  client: import("axios").AxiosInstance;
  jar: CookieJar;
} {
  const jar = new CookieJar();

  let httpAgent;
  let httpsAgent;

  if (proxyUrl) {
    if (proxyUrl.startsWith("socks")) {
      const BaseAgent = SocksProxyAgent;
      const CookieSocksAgent = createCookieAgent(BaseAgent);
      // http-cookie-agent v7 takes (urlOrOptions, { cookies: { jar } })
      httpsAgent = new CookieSocksAgent(proxyUrl, { cookies: { jar: jar as any } });
      httpAgent = httpsAgent;
    } else {
      const HttpCookieProxyAgent = createCookieAgent(HttpProxyAgent);
      const HttpsCookieProxyAgent = createCookieAgent(HttpsProxyAgent);

      httpAgent = new HttpCookieProxyAgent(proxyUrl, { cookies: { jar: jar as any } });
      httpsAgent = new HttpsCookieProxyAgent(proxyUrl, { cookies: { jar: jar as any } });
    }
  } else {
    // No proxy, still need cookie support
    httpAgent = new HttpCookieAgent({ cookies: { jar: jar as any } });
    httpsAgent = new HttpsCookieAgent({ cookies: { jar: jar as any } });
  }

  const client = axios.create({
    timeout: 20000, // 20s for residential/free proxy latency
    responseType: "text",
    maxRedirects: 5,
    httpAgent,
    httpsAgent,
  });

  return { client, jar };
}

function buildHeaders(
  referer: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    "User-Agent": UA,
    Accept:
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    Connection: "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Ch-Ua":
      '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    ...extra,
  };

  if (referer) {
    headers["Referer"] = referer;
    // Only add Origin for POST requests or cross-site navigations that require it
    // For simple GET, it can be a fingerprinting signal if mismatched
  }

  return headers;
}

// ── Main Pipeline ───────────────────────────────────────────────────────────

/**
 * Entry point: Scrapes a movie or episode from the vsembed pipeline.
 */
export async function scrapeVsembed(
  tmdbId: string,
  kind: "movie" | "tv",
  embedHost: string,
  season = 1,
  episode = 1,
  proxyUrl?: string,
): Promise<ScrapeResult> {
  console.log(
    `[SCRAPER] scrapeVsembed called with: tmdbId=${tmdbId}, kind=${kind}, embedHost=${embedHost}, proxyUrl=${proxyUrl}`,
  );
  const { client, jar } = createSession(proxyUrl);

  if (!embedHost) {
    throw new Error("embedHost is undefined in scrapeVsembed");
  }
  const cleanEmbedHost = embedHost.replace(/\/$/, "");

  // ── Layer 1: The Router ────────────────────────────────────────────────
  // Fetches the vsembed page and extracts the cloudnestra iframe src.

  const routerUrl =
    kind === "tv"
      ? `${cleanEmbedHost}/embed/tv/${tmdbId}/${season}/${episode}`
      : `${cleanEmbedHost}/embed/movie/${tmdbId}`;

  console.log(`[SCRAPER] L1 Router  → ${routerUrl}`);
  const routerRes = await client.get(routerUrl, {
    headers: buildHeaders(""), // No referer for the first hop
  });
  const routerHtml: string = routerRes.data;

  // Match src="//cloudnestra.com/rcp/..." directly - the page may not have id="player_iframe"
  const iframeMatch =
    routerHtml.match(/["'](\/\/cloudnestra\.com\/rcp\/[^"']+)["']/i) ||
    routerHtml.match(/id=["']player_iframe["'][^>]+src=["']([^"']+)["']/i) ||
    routerHtml.match(/src=["']([^"']+)["'][^>]+id=["']player_iframe["']/i);

  if (!iframeMatch?.[1]) {
    throw new Error(
      "L1: cloudnestra iframe src not found — vsembed page structure may have changed",
    );
  }

  let wrapperUrl = iframeMatch[1];
  if (wrapperUrl.startsWith("//")) wrapperUrl = "https:" + wrapperUrl;
  if (wrapperUrl.startsWith("/")) wrapperUrl = CLOUDNESTRA_HOST + wrapperUrl;

  console.log(`[SCRAPER] L1     ✔  iframe → ${wrapperUrl}`);

  // ── Layer 2: The Wrapper ───────────────────────────────────────────────
  // Fetches the cloudnestra /rcp/ page with the vsembed referer.
  // CRITICAL: Without the correct Referer, cloudnestra returns 404.

  console.log(`[SCRAPER] L2 Wrapper → ${wrapperUrl}`);
  const wrapperRes = await client.get(wrapperUrl, {
    headers: buildHeaders(cleanEmbedHost + "/"),
  });
  const wrapperHtml: string = wrapperRes.data;

  // Match the jQuery-loaded iframe path — try multiple patterns in order of specificity.
  // Cloudnestra has used several structures over time; we cascade through all known ones.
  const prorpcMatch =
    wrapperHtml.match(/src:\s*['"](\/prorcp\/[^'"]+)['"]/i) || // src: '/prorcp/...'
    wrapperHtml.match(/url:\s*['"](\/prorcp\/[^'"]+)['"]/i) || // url: '/prorcp/...'
    wrapperHtml.match(/href:\s*['"](\/prorcp\/[^'"]+)['"]/i) || // href: '/prorcp/...'
    wrapperHtml.match(/fetch\(['"](\/prorcp\/[^'"]+)['"]/i) || // fetch('/prorcp/...')
    wrapperHtml.match(/\.load\(['"](\/prorcp\/[^'"]+)['"]/i) || // .load('/prorcp/...')
    wrapperHtml.match(/(?:ajax|get).*?['"](\/prorcp\/[^'"]+)['"]/i) || // $.ajax / $.get
    wrapperHtml.match(/['"](prorcp\/[^'"]+)['"]/); // bare 'prorcp/...'

  if (!prorpcMatch?.[1]) {
    // Dump first 500 chars of the wrapper response to help debug future structure changes
    console.error(
      "[SCRAPER] L2 FAIL — wrapper HTML snippet:",
      wrapperHtml.substring(0, 500),
    );
    throw new Error(
      "L2: /prorcp/ path not found — cloudnestra wrapper structure may have changed",
    );
  }

  const prorpcPath = prorpcMatch[1].startsWith("/")
    ? prorpcMatch[1]
    : "/" + prorpcMatch[1];
  const playerUrl = CLOUDNESTRA_HOST + prorpcPath;

  console.log(`[SCRAPER] L2     ✔  prorcp → ${playerUrl}`);

  // ── Layer 3: The PlayerJS Config ──────────────────────────────────────
  // Fetches the actual PlayerJS configuration page.
  // CRITICAL: Referer MUST be the /rcp/ wrapper URL (wrapperUrl), NOT just cloudnestra.com/
  // Cloudnestra validates that the request came from the wrapper page before returning the player config.
  // Confirmed via Proxyman: requests with Referer=rcp_url → 200 OK; Referer=cloudnestra.com/ → blocked.

  console.log(`[SCRAPER] L3 PlayerJS → ${playerUrl}`);
  const playerRes = await client.get(playerUrl, {
    headers: buildHeaders(wrapperUrl, {
      "Sec-Fetch-Dest": "iframe",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "same-origin", // rcp → prorcp = same origin
    }),
  });
  const playerHtml: string = playerRes.data;

  // Extract: file: "https://cdn.../master.m3u8 or https://cdn2.../..."
  const fileMatch = playerHtml.match(/file:\s*["']([^"']+)["']/i);
  if (!fileMatch?.[1]) {
    throw new Error("L3: `file:` property not found in PlayerJS config");
  }
  const rawFileString = fileMatch[1];
  console.log(
    `[SCRAPER] L3     ✔  file string (${rawFileString.length} chars)`,
  );

  // Extract ping URL — e.g. var ping_url = "//tmstr4.cloudnestra.com/rt_ping.php"
  let pingUrl: string | null = null;
  const pingMatch =
    playerHtml.match(/(?:ping_url|rt_ping)\s*[=:]\s*["']([^"']+)["']/i) ||
    playerHtml.match(/["'](\/\/[^"']+rt_ping\.php[^"']*)["']/i);
  if (pingMatch?.[1]) {
    pingUrl = pingMatch[1].startsWith("//")
      ? "https:" + pingMatch[1]
      : pingMatch[1];
    console.log(`[SCRAPER] L3     ✔  ping → ${pingUrl}`);
  } else {
    // Common static fallback — still send pings even without explicit URL
    pingUrl = "https://tmstr4.cloudnestra.com/rt_ping.php";
    console.log(
      `[SCRAPER] L3     ⚑  ping URL not found, using static fallback`,
    );
  }

  // Extract dynamic token if present — e.g. var csrf = "A8f9..."
  const pingParams: Record<string, string> = {};
  const tokenMatch = playerHtml.match(
    /(?:csrf|_token|ping_token)\s*[=:]\s*["']([^"']{8,})["']/i,
  );
  if (tokenMatch?.[1]) {
    pingParams["t"] = tokenMatch[1];
    console.log(`[SCRAPER] L3     ✔  token extracted`);
  }

  // ── Quality Tag Extraction ────────────────────────────────────────────
  // Decode the base64 `flnm` variable from the PlayerJS HTML to classify the stream.
  const { qualityTag, resolution } = parseQualityFromFilename(playerHtml);

  // ── Layer 4: Data Cleaning ─────────────────────────────────────────────
  // Split " or " fallbacks, replace {vX} CDN placeholders, filter valid m3u8.

  const rawStreams = rawFileString.split(" or ").map((s) => s.trim());
  const streams: string[] = [];

  for (const raw of rawStreams) {
    // Replace {vX} placeholder with the corresponding CDN domain
    let resolved = raw;
    for (const [placeholder, domain] of Object.entries(CDN_DOMAIN_MAP)) {
      resolved = resolved.replace(placeholder, domain);
    }
    if (resolved.includes(".m3u8") || resolved.match(/\/pl\//)) {
      streams.push(resolved);
    }
  }

  const validStreams = streams.filter((s) => s.includes(".m3u8"));

  if (validStreams.length === 0) {
    throw new Error("L4: No valid .m3u8 URLs found after cleaning");
  }

  console.log(`[SCRAPER] L4     ✔  ${validStreams.length} stream(s) resolved`);
  validStreams.forEach((s, i) =>
    console.log(`         [${i + 1}] ${s.substring(0, 90)}`),
  );

  return {
    streamUrl: validStreams[0] || "",
    streams: validStreams,
    source: "vsembed-cloudnestra",
    qualityTag,
    resolution,
    proxyUsed: proxyUrl,
    session: {
      pingUrl: pingUrl || null,
      pingParams,
      pingReferer: CLOUDNESTRA_HOST + "/",
      cookieJar: jar as any,
      proxyUrl: proxyUrl,
    },
  };
}
