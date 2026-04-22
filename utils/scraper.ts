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
import * as cheerio from "cheerio";

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
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";

// ── Types ───────────────────────────────────────────────────────────────────

export interface SubtitleStream {
  url: string;
  lang: string;
  languageName: string;
  source: string;
}

export interface MirrorStream {
  url: string;
  source: string;
  quality?: string;
  headers?: Record<string, string>;
  type?: "hls" | "mp4" | "torrent";
  subtitles?: SubtitleStream[];
}

export interface ScrapeResult {
  /** Best-quality .m3u8 URL (first in the array). */
  streamUrl: string;
  /** All available fallback .m3u8 URLs. */
  streams: string[];
  /** Multiple stream mirrors from different providers. */
  mirrors?: MirrorStream[];
  /** Human-readable source identifier. */
  source: string;
  /** Heartbeat session — pass to startHeartbeat() to keep the stream alive. */
  session?: HeartbeatSession;
  /** Quality tag parsed from the release filename: CAM | TC | WEBDL | WEBRIP | BLURAY | HDTC | HD | UNKNOWN */
  qualityTag: string;
  /** Resolution parsed from the release filename: 4K | 1080p | 720p | 480p | UNKNOWN */
  resolution: string;
  /** The actual proxy URL used for the scrape (if any) — needed for manifest/heartbeat consistency. */
  proxyUsed: string | undefined;
  /** Subtitles extracted during the scrape. */
  subtitles?: SubtitleStream[];
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

// ── NetMirror Scraper ───────────────────────────────────────────────────────

const NETMIRROR_BASE = "https://net22.cc";
const NETMIRROR_PLAY = "https://net52.cc";

const YFLIX_BASE = "https://yflix.to";
const YFXENC = "https://enc-dec.app/api/enc-movies-flix";
const YFXDEC = "https://enc-dec.app/api/dec-movies-flix";

const YTS_BASE = "https://yts.am/api/v2";

/**
 * Normalizes titles for search by removing years, special characters, and 'The' prefixes.
 */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\(\d{4}\)/g, "") // Remove (2019)
    .replace(/\s+/g, " ")       // Normalize whitespace
    .replace(/^the\s+/g, "")    // Remove leading 'The '
    .replace(/[^\w\s]/g, "")    // Remove special characters
    .trim();
}

const NETMIRROR_GUEST_TOKEN = "233123f803cf02184bf6c67e149cdd50";
const NETMIRROR_UA = UA;
const NETMIRROR_HEADERS = {
  "User-Agent": UA,
  "X-Requested-With": "XMLHttpRequest",
  "Accept": "application/json, text/plain, */*",
  "Referer": `${NETMIRROR_BASE}/`
};

/**
 * Scrapes mirrors from NetMirror (Netflix/Prime/Disney/Hotstar aggregator).
 * Uses direct handshake logic to bypass authorization blocks.
 */
export async function scrapeNetMirror(
  tmdbId: string,
  title: string,
  kind: "movie" | "tv",
  season?: number,
  episode?: number
): Promise<MirrorStream[]> {
  const mirrors: MirrorStream[] = [];
  const jar = new CookieJar();
  
  // No proxy needed for NetMirror as it doesn't block data-center IPs as aggressively
  const client = axios.create({
    headers: { 
      "User-Agent": UA,
      "X-Requested-With": "XMLHttpRequest" 
    },
    httpAgent: new HttpCookieAgent({ cookies: { jar: jar as any } }),
    httpsAgent: new HttpsCookieAgent({ cookies: { jar: jar as any } }),
    timeout: 20000,
  });

  try {
    console.log(`[NETMIRROR] Initializing session...`);
    console.log(`[NETMIRROR] Performing handshake/bypass on ${NETMIRROR_PLAY}...`);
    const handshakeHeaders = {
      "User-Agent": UA,
      "X-Requested-With": "XMLHttpRequest",
      "Referer": `${NETMIRROR_BASE}/`,
      "Accept": "application/json, text/plain, */*",
      "Connection": "keep-alive"
    };

    const handshakeRes = await client.post(`${NETMIRROR_PLAY}/tv/p.php`, "", { 
      headers: handshakeHeaders
    });

    let globalHash = "";
    const setCookie = handshakeRes.headers['set-cookie'] || handshakeRes.headers['Set-Cookie'] || [];
    const cookieStrArr = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const cookie of cookieStrArr) {
      const match = cookie.match(/t_hash_t=([^;]+)/);
      if (match) {
        globalHash = decodeURIComponent(match[1]);
        break;
      }
    }

    const ottTypes = ["nf", "pv", "dp", "hs"];
    let resultsFound = false;

    for (const ott of ottTypes) {
      if (resultsFound) break;
      console.log(`[NETMIRROR] Attempting OTT type: ${ott}`);
      
      const bypassUrl = `${NETMIRROR_PLAY}/tv/p.php`;
      const handshakeRes = await client.post(bypassUrl, "", {
         headers: { "Referer": `${NETMIRROR_BASE}/` }
      });
      
      const setCookie = handshakeRes.headers['set-cookie'] || [];
      const hashMatch = setCookie.join("; ").match(/t_hash_t=([^;]+)/);
      if (!hashMatch) continue;
      const globalHash = decodeURIComponent(hashMatch[1]);
      // Extract user_token automatically if not provided
      let userToken = process.env.NETMIRROR_GUEST_TOKEN || "guest";
      if (userToken === "guest") {
         const mainPage = await client.get(`${NETMIRROR_BASE}/`);
         const tokenMatch = mainPage.data.match(/user_token\s*=\s*'([^']+)'/);
         if (tokenMatch) userToken = tokenMatch[1];
      }

      const baseCookieStr = `t_hash_t=${globalHash}; ott=${ott}; user_token=${userToken}; hd=on`;
      
      const query = normalizeTitle(title);
      const searchUrl = `${NETMIRROR_BASE}/search.php?s=${encodeURIComponent(query)}&t=${Math.floor(Date.now() / 1000)}`;
      const searchRes = await client.get(searchUrl, {
        headers: { "Referer": `${NETMIRROR_BASE}/`, "Cookie": baseCookieStr }
      });

      if (!searchRes.data.searchResult || searchRes.data.searchResult.length === 0) continue;
      
      const matchFound = searchRes.data.searchResult[0];
      const targetIdBase = matchFound.id;
      let targetId = targetIdBase;

      const postRes = await client.get(`${NETMIRROR_BASE}/post.php?id=${targetIdBase}&t=${Math.floor(Date.now() / 1000)}`, {
        headers: { "Referer": `${NETMIRROR_BASE}/`, "Cookie": baseCookieStr }
      });

      if (kind === "tv" && season && episode && postRes.data.episodes) {
          const episodes = postRes.data.episodes || [];
          const epMatch = episodes.find((e: any) => {
             if (!e) return false;
             const sVal = String(e.s || "").match(/\d+/);
             const eVal = String(e.ep || "").match(/\d+/);
             return sVal && parseInt(sVal[0]) === season && eVal && parseInt(eVal[0]) === episode;
          });
          if (epMatch) targetId = epMatch.id;
          else continue;
      }

      const pPostRes = await client.post(`${NETMIRROR_BASE}/play.php`, `id=${targetId}`, {
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Referer": `${NETMIRROR_BASE}/`, "Cookie": baseCookieStr }
      });
      const { h } = pPostRes.data;
      if (!h) continue;

      const iUrl = `${NETMIRROR_PLAY}/play.php?id=${targetId}&${h}`;
      const iRes = await client.get(iUrl, { 
        headers: { ...NETMIRROR_HEADERS, "Referer": `${NETMIRROR_BASE}/post.php?id=${targetId}`, "Cookie": baseCookieStr } 
      });

      const tokenMatch = iRes.data.match(/data-h="([^"]+)"/);
      if (!tokenMatch) continue;
      const token = tokenMatch[1];

      const pUrl = `${NETMIRROR_PLAY}/playlist.php?id=${targetId}&t=${encodeURIComponent(matchFound.t)}&tm=${Math.floor(Date.now() / 1000)}&h=${token}`;
      const listRes = await client.get(pUrl, {
        headers: { "Referer": `${NETMIRROR_PLAY}/`, "Cookie": baseCookieStr }
      });

      if (Array.isArray(listRes.data)) {
        listRes.data.forEach((item: any) => {
          if (item.sources) {
            item.sources.forEach((src: any) => {
              mirrors.push({
                url: `${NETMIRROR_PLAY}${src.file.startsWith('/') ? '' : '/'}${src.file}`,
                source: `NetMirror [${src.label}] (${ott.toUpperCase()})`,
                quality: src.label.includes("1080") ? "1080p" : (src.label.includes("2160") ? "2160p" : "720p"),
                type: "hls",
                headers: { "Referer": `${NETMIRROR_PLAY}/`, "Cookie": baseCookieStr }
              });
            });
          }
        });
        if (mirrors.length > 0) resultsFound = true;
      }
    }
  } catch (err: any) {
    console.error("[NETMIRROR] Error:", err.message);
  }
  return mirrors;
}

// ── YTS Scraper ─────────────────────────────────────────────────────────────

/**
 * Scrapes YTS for magnet torrents (High quality movies).
 */
export async function scrapeYTS(title: string): Promise<MirrorStream[]> {
  const mirrors: MirrorStream[] = [];
  const YTS_MIRRORS = [YTS_BASE, "https://yts.mx/api/v2"]; // Fallback mirrors if needed
  
  try {
    const res = await axios.get(`${YTS_BASE}/list_movies.json?query_term=${encodeURIComponent(title)}&limit=1`, {
      timeout: 10000,
      headers: { "User-Agent": UA }
    });

    const body = res.data;
    if (body.status !== "ok" || !body.data.movies || body.data.movies.length === 0) {
      return [];
    }

    const movie = body.data.movies[0];
    const trackers = "&tr=udp://open.demonii.com:1337/announce&tr=udp://tracker.openbittorrent.com:80&tr=udp://tracker.coppersurfer.tk:6969&tr=udp://glotorrents.pw:6969/announce&tr=udp://tracker.opentrackr.org:1337/announce&tr=udp://torrent.gresille.org:80/announce&tr=p4p.arenabg.com:1337&tr=udp://tracker.leechers-paradise.org:6969";

    for (const torrent of movie.torrents) {
      const magnet = `magnet:?xt=urn:btih:${torrent.hash}&dn=${encodeURIComponent(movie.title)}&tr=${trackers}`;
      mirrors.push({
        source: `YTS [${torrent.quality}] (${torrent.type})`,
        url: magnet,
        quality: torrent.quality,
        type: "torrent"
      });
    }

    return mirrors;
  } catch (err: any) {
    console.error("[YTS] Error:", err.message);
    return [];
  }
}

// ── YFlix Scraper ───────────────────────────────────────────────────────────

const YFLIX_UA = UA;

export async function scrapeYFlix(
  title: string,
  kind: "movie" | "tv",
  season?: number,
  episode?: number
): Promise<MirrorStream[]> {
  /*
   * YFlix is currently under heavy DDoS protection and refresh loops.
   * Paused until stable bypass is implemented.
   */
  return [];
}

// ── Mirror Resolver Helpers ──────────────────────────────────────────────────

function rot13(str: string) {
  return (str || "").replace(/[a-zA-Z]/g, (c: any) => {
    return String.fromCharCode((c <= "Z" ? 90 : 122) >= (c = c.charCodeAt(0) + 13) ? c : c - 26);
  });
}

function atob(str: string) { return Buffer.from(str, 'base64').toString('binary'); }
function btoa(str: string) { return Buffer.from(str, 'binary').toString('base64'); }

/**
 * Validates if a link is an actual media stream or file.
 */
async function probeLink(url: string, referer: string = ""): Promise<boolean> {
  // Filter out unplayable formats immediately
  if (url.match(/\.(mkv|avi|wmv|zip|rar|tar|7z)(\?|$)/i)) return false;

  try {
    // Many CDNs block HEAD, so we use GET but with a timeout and we only care about status.
    const res = await axios.get(url, { 
      timeout: 3000, 
      headers: { "User-Agent": UA, "Referer": referer },
      maxContentLength: 1000, 
      validateStatus: (s) => s < 400
    });
    return res.status < 400;
  } catch {
    return false;
  }
}

async function hubCloudExtractor(url: string, referer: string = ""): Promise<string[]> {
  try {
    let currentUrl = url.replace("hubcloud.ink", "hubcloud.dad");
    const res = await axios.get(currentUrl, { headers: { "User-Agent": UA, "Referer": referer } });
    let pageData = res.data;
    
    if (!currentUrl.includes("hubcloud.php")) {
       const $ = cheerio.load(pageData);
       let nextHref = $("#download").attr("href");
       if (!nextHref) {
          const match = pageData.match(/var url = '([^']*)'/);
          if (match) nextHref = match[1];
       }
       if (nextHref) {
          if (!nextHref.startsWith("http")) nextHref = new URL(currentUrl).origin + "/" + nextHref.replace(/^\//, "");
          const res2 = await axios.get(nextHref, { headers: { "User-Agent": UA, "Referer": currentUrl } });
          pageData = res2.data;
       }
    }

    const $ = cheerio.load(pageData);
    const links: string[] = [];
    $("a.btn").each((_, el) => {
       const href = $(el).attr("href");
       const text = $(el).text().toLowerCase();
       if (href && (text.includes("download") || text.includes("server") || text.includes("fsl") || text.includes("10gbps") || href.includes("pixeldrain"))) {
          if (href.includes("pixeldrain")) {
             links.push(href.includes("?download") ? href : `https://pixeldrain.com/api/file/${href.split('/').pop()}?download`);
          } else {
             links.push(href);
          }
       }
    });
    return links;
  } catch { return []; }
}

async function getRedirectLinks(url: string): Promise<string | null> {
  try {
    const res = await axios.get(url, { headers: { "User-Agent": UA } });
    const doc = res.data;
    
    // 1. Look for encoded tokens (Base64 -> Rot13 -> Base64 -> Final)
    const allBase64 = doc.match(/[A-Za-z0-9+/=]{50,}/g) || [];
    for (const token of allBase64) {
      try {
        const decoded = atob(rot13(atob(token)));
        if (decoded && decoded.includes("{")) {
           const json = JSON.parse(decoded);
           const encodedUrl = json.o ? atob(json.o).trim() : null;
           if (encodedUrl && encodedUrl.startsWith("http")) return encodedUrl;
        }
      } catch {}
    }

    // 2. Look for script/meta redirects
    const nextMatch = doc.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]|URL\s*=\s*['"]([^'"]+)['"]/i);
    if (nextMatch) {
       let nextUrl = nextMatch[1] || nextMatch[2];
       if (nextUrl && !nextUrl.startsWith("http")) {
          const origin = new URL(url).origin;
          nextUrl = origin + (nextUrl.startsWith("/") ? "" : "/") + nextUrl;
       }
       if (nextUrl && nextUrl !== url) return await getRedirectLinks(nextUrl);
    }
    
    // 3. Look for "techyboy" style anchors
    const $ = cheerio.load(doc);
    const nextAnchor = $("a[href*='techyboy'], a[href*='gadgetsweb'], a[href*='cryptoinsights']").attr("href");
    if (nextAnchor && nextAnchor !== url) return await getRedirectLinks(nextAnchor);

    return null;
  } catch { return null; }
}

async function resolveMirrorLink(url: string, referer: string = ""): Promise<string[]> {
  try {
    const hostname = new URL(url).hostname;
    // Known redirectors
    if (url.includes("?id=") || ["techyboy", "gadgetsweb", "cryptoinsights", "bloggingvector"].some(h => hostname.includes(h))) {
       const resolved = await getRedirectLinks(url);
       if (resolved) return await resolveMirrorLink(resolved, url);
    }

    if (hostname.includes("hubcloud") || hostname.includes("hubdrive")) return await hubCloudExtractor(url, referer);
    if (hostname.includes("pixeldrain")) return [url.includes("?download") ? url : `https://pixeldrain.com/api/file/${url.split('/').pop()}?download` ];
    
    return [url];
  } catch { return []; }
}

// ── HDHub4U Scraper ──────────────────────────────────────────────────────────

const HDHUB_BASE = "https://new6.hdhub4u.fo";
const HDHUB_API = "https://search.pingora.fyi/collections/post/documents/search";

export async function scrapeHDHub4U(title: string, kind: string, season?: number, episode?: number): Promise<MirrorStream[]> {
  const mirrors: MirrorStream[] = [];
  try {
    const query = normalizeTitle(title);
    const today = new Date().toISOString().split("T")[0];
    const res = await axios.get(`${HDHUB_API}?q=${encodeURIComponent(query)}&query_by=post_title,category&query_by_weights=4,2&sort_by=sort_by_date:desc&limit=15&analytics_tag=${today}`, {
      headers: { 
        "x-typesense-api-key": "pingora",
        "User-Agent": UA,
        "Referer": `${HDHUB_BASE}/`,
        "Cookie": "xla=s4t"
      }
    });
    
    const hits = res.data.hits || [];
    
    const hit = hits.find((h: any) => {
        const hitTitle = (h.document.post_title || "").toLowerCase();
        const normHit = normalizeTitle(hitTitle);
        // If TV show, prioritize hits that mention the specific season
        if (kind === "tv" && season) {
           const sQuery = `season ${season}`;
           const sQueryAlt = `s${season}`;
           if (!hitTitle.includes(sQuery) && !hitTitle.includes(sQueryAlt)) return false;
        }
        return normHit.includes(query) || query.includes(normHit);
    });
    if (!hit) return [];
    
    const pageRes = await axios.get(HDHUB_BASE + hit.document.permalink);
    const $ = cheerio.load(pageRes.data);
    
    const links: { url: string, name: string }[] = [];
    $("a").each((_, el) => {
       const href = $(el).attr("href");
       const text = $(el).text().trim();
       if (href && (href.includes("hubcloud") || href.includes("hubdrive") || href.includes("hdstream4u") || href.includes("hubstream") || text.match(/480|720|1080|2160|4k/i))) {
          if (!href.includes(HDHUB_BASE)) {
             // If TV show, filter by episode text or surrounding context (for tables)
             if (kind === "tv" && episode) {
                const epPattern = new RegExp(`(E|Episode|Ep|episode)\\s*0*${episode}(\\s|\\D|$)`, 'i');
                const parentText = $(el).closest('tr, td, p, div').text().trim();
                // Broader check for Season packs
                if (epPattern.test(text) || epPattern.test(parentText) || text.toLowerCase().includes("all episodes")) {
                   links.push({ url: href, name: text });
                }
             } else {
                links.push({ url: href, name: text });
             }
          }
       }
    });

    const resolvedLinks = await Promise.all(links.slice(0, 8).map(l => resolveMirrorLink(l.url)));
    for (let i = 0; i < resolvedLinks.length; i++) {
       const urls = resolvedLinks[i];
       const originalName = links[i].name;
       for (const u of urls) {
          if (await probeLink(u)) {
             mirrors.push({ 
                url: u, 
                source: "HDHub Mirror", 
                quality: originalName.match(/2160|4k/i) ? "2160p" : (originalName.match(/1080/i) ? "1080p" : "720p")
             });
          }
       }
    }
    return mirrors;
  } catch { return []; }
}

// ── 4KHDHub Scraper ──────────────────────────────────────────────────────────

const FOURK_BASE = "https://4khdhub.click";

export async function scrapeFourKHDHub(title: string, kind: string, season?: number, episode?: number): Promise<MirrorStream[]> {
  const mirrors: MirrorStream[] = [];
  try {
    // 4KHDHub WordPress search is very sensitive; try both normalized and raw
    const query = normalizeTitle(title);
    let res = await axios.get(`${FOURK_BASE}/?s=${encodeURIComponent(query)}`, { headers: { "User-Agent": UA } });
    let $ = cheerio.load(res.data);
    let firstMatch = $("a.movie-card").first().attr("href");
    
    if (!firstMatch) {
       res = await axios.get(`${FOURK_BASE}/?s=${encodeURIComponent(title)}`, { headers: { "User-Agent": UA } });
       $ = cheerio.load(res.data);
       firstMatch = $("a.movie-card").first().attr("href");
    }
    
    if (!firstMatch) return [];
    
    const pageRes = await axios.get(firstMatch, { headers: { "User-Agent": UA } });
    const $p = cheerio.load(pageRes.data);
    
    const links: { url: string, name: string }[] = [];
    $p("a").each((_, el) => {
       const href = $p(el).attr("href");
       const text = $p(el).text().trim();
       if (href && (href.includes("hubcloud") || href.includes("hubdrive") || href.includes("hubstream") || text.match(/480|720|1080|2160|4k/i))) {
          if (!href.includes(FOURK_BASE)) {
             if (kind === "tv" && episode) {
                const epPattern = new RegExp(`(E|Episode|Ep|episode)\\s*0*${episode}(\\s|\\D|$)`, 'i');
                const parentText = $p(el).closest('tr, td, p, div').text().trim();
                if (epPattern.test(text) || epPattern.test(parentText)) {
                    links.push({ url: href, name: text });
                }
             } else {
                links.push({ url: href, name: text });
             }
          }
       }
    });

    const resolvedLinks = await Promise.all(links.slice(0, 8).map(l => resolveMirrorLink(l.url)));
    for (let i = 0; i < resolvedLinks.length; i++) {
       const urls = resolvedLinks[i];
       const originalName = links[i].name;
       for (const u of urls) {
          if (await probeLink(u)) {
             mirrors.push({ 
                url: u, 
                source: "4KHD Mirror", 
                quality: originalName.match(/2160|4k/i) ? "2160p" : (originalName.match(/1080/i) ? "1080p" : "720p")
             });
          }
       }
    }
    return mirrors;
  } catch { return []; }
}

// ── Streamflix Scraper ───────────────────────────────────────────────────────

const STREAMFLIX_BASE = "https://api.streamflix.app";

export async function scrapeStreamflix(title: string, kind: string, season?: number, episode?: number): Promise<MirrorStream[]> {
  const mirrors: MirrorStream[] = [];
  try {
    const [dataRes, configRes] = await Promise.all([
       axios.get(`${STREAMFLIX_BASE}/data.json`),
       axios.get(`${STREAMFLIX_BASE}/config/config-streamflixapp.json`)
    ]);
    
    
    const query = normalizeTitle(title);
    const queryWords = query.split(/\s+/).filter(w => w.length > 2);
    const items = (dataRes.data.data || []).filter((x: any) => {
        const movieName = normalizeTitle(x.moviename || "");
        // Strict word check: all long words from query must be in target name
        return movieName === query || queryWords.every(word => movieName.includes(word));
    });
    
    let item = items[0];
    if (kind === "tv" && season && episode) {
       const sStr = season.toString().padStart(2, "0");
       const eStr = episode.toString().padStart(2, "0");
       // Try multiple formats: S01E06, S1 E6, Season 1 Episode 6
       const matched = items.find((x: any) => {
          const n = (x.moviename || "").toLowerCase();
          return (n.includes(`s${sStr}e${eStr}`) || 
                  n.includes(`s${season} e${episode}`) ||
                  (n.includes(`${season}`) && n.includes(`${episode}`)) ||
                  n.includes(`episode ${episode}`));
       });
       if (!matched) return []; 
       item = matched;
    }

    if (!item || !item.movielink) return [];
    
    const config = configRes.data;
    const servers = [...(config.premium || []), ...(config.movies || []), ...(config.tv || [])];
    
    servers.forEach((srv: string) => {
        mirrors.push({
           url: srv + item.movielink,
           source: "Streamflix Server",
           quality: srv.includes("premium") ? "1080p" : "720p"
        });
    });
    
    return mirrors;
  } catch { return []; }
}
