import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import dotenv from "dotenv";
import axios from "axios";
import fs from "fs";
import https from "https";
import {
  MetadataCache,
  StreamCache,
  SubtitleCache,
  DiscoveryCache,
  DramaDetailCache,
} from "./models/Cache.js";
import { getSubtitles } from "./utils/subtitles.js";
import {
  scrapeVsembed,
  scrapeNetMirror,
  scrapeHDHub4U,
  scrapeFourKHDHub,
  scrapeStreamflix,
  startHeartbeat,
  stopHeartbeat,
  type MirrorStream,
} from "./utils/scraper.js";

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
import { KissKHScraper } from "./utils/kisskh.js";
import { VidLinkScraper } from "./utils/vidlink.js";
import { HttpsProxyAgent } from "https-proxy-agent";
import {
  HttpCookieAgent,
  HttpsCookieAgent,
  createCookieAgent,
} from "http-cookie-agent/http";
import { gotScraping } from "got-scraping";
import { CookieJar } from "tough-cookie";

// Load Environment Variables
dotenv.config();

import initCycleTLS from 'cycletls';

let cycleTLS: any = null;
initCycleTLS().then(c => {
  cycleTLS = c;
  console.log('[PROXY] 🛡️ CycleTLS JA3 Spoofer Initialized.');
}).catch(console.error);

// Simple memory cache for proxy requests to speed up playback and avoid repeat bypasses
const proxyCache = new Map<string, { body: Buffer, headers: any, expires: number }>();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const SEGMENT_TTL = 30 * 60 * 1000; // 30 minutes for video segments

// Warm up got-scraping to avoid delay on first request
setTimeout(async () => {
  try {
    console.log('[GOT] Warming up browser fingerprints...');
    await gotScraping.get('https://vidlink.pro', { timeout: { request: 5000 }, retry: { limit: 0 } });
    console.log('[GOT] Warm-up complete.');
  } catch {}
}, 5000);

/**
 * Fetches a VidLink/Storm URL using raw Node.js https.request.
 * IMPORTANT: This bypasses WHATWG URL normalization (used by got/fetch/axios).
 * Storm CDN requires literal { } braces in query params — any library that
 * parses the URL with WHATWG will encode them to %7B/%7D and get a 400.
 */
const httpsAgent = new https.Agent({ keepAlive: true });

function fetchVidLinkRaw(rawUrl: string): Promise<{ statusCode: number; headers: any; body: Buffer, finalUrl: string }> {
  return new Promise((resolve, reject) => {
    // Split BEFORE the '?' so WHATWG URL never touches the query string
    const qIdx = rawUrl.indexOf('?');
    const baseOnly = qIdx >= 0 ? rawUrl.substring(0, qIdx) : rawUrl;
    const rawQuery = qIdx >= 0 ? rawUrl.substring(qIdx) : '';

    // Only parse the base (path) part — safe since it has no special chars
    let parsedBase: URL;
    try {
      parsedBase = new URL(baseOnly);
    } catch (e) {
      return reject(new Error(`fetchVidLinkRaw: invalid base URL: ${baseOnly}`));
    }

    const port = parsedBase.port ? parseInt(parsedBase.port) : 443;
    const rawPath = parsedBase.pathname + rawQuery; // preserve query string exactly

    const reqOptions = {
      agent: httpsAgent,
      hostname: parsedBase.hostname,
      port,
      path: rawPath,
      method: 'GET',
      headers: {
        'accept': '*/*',
        'accept-language': 'en-US,en;q=0.9',
        'cache-control': 'no-cache',
        'pragma': 'no-cache',
        'referer': 'https://vidlink.pro/',
        'origin': 'https://vidlink.pro',
        'user-agent': UA,
      },
    };

    const req = https.request(reqOptions, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
        finalUrl: rawUrl
      }));
    });

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('VidLink fetch timeout')); });
    req.end();
  });
}


// Helper function to safely fetch using cycletls
async function fetchWithCycleTLS(url: string, headers: any, proxy?: string, method: string = 'get', body?: any) {
  if (!cycleTLS) throw new Error("CycleTLS not initialized yet");
  
  const defaultHeaders = {
    'accept': '*/*',
    'accept-language': 'en-US,en;q=0.7',
    'cache-control': 'no-cache',
    'pragma': 'no-cache',
    'priority': 'u=1, i',
    'sec-ch-ua': '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'cross-site',
    'user-agent': UA
  };

  // Merge headers, allowing overrides
  const finalHeaders = {
    ...defaultHeaders,
    ...headers
  };

  // Remove navigate/video headers if we are doing a CORS fetch (standard for segments/manifests)
  if (finalHeaders['sec-fetch-mode'] === 'cors') {
    delete finalHeaders['upgrade-insecure-requests'];
  }

  const options: any = {
    headers: finalHeaders,
    ja3: '771,4865-4866-4867-49195-49199-49196-49200-52393-52392-49171-49172-156-157-47-53,0-23-65281-10-11-35-16-5-13-18-51-45-43-21,29-23-24,0',
    userAgent: finalHeaders['user-agent'] || UA,
    timeout: 30
  };
  
  if (body) {
    options.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  if (proxy) {
    options.proxy = proxy.startsWith("http") ? proxy : `http://${proxy}`;
  }

  const res = await cycleTLS(url, options, method.toLowerCase() as any);
  
  if (!res) {
    throw new Error("CycleTLS returned no response");
  }

  let bodyBuffer: Buffer;
  if (typeof res.data === 'string') {
    bodyBuffer = Buffer.from(res.data, 'utf-8');
  } else if (res.data && typeof res.data === 'object') {
    // Convert Go-style byte array object to Node Buffer
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

async function fetchWithGotScraping(url: string, headers: any, proxy?: string, method: string = 'get', body?: any) {
  try {
    const options: any = {
      method: method.toUpperCase(),
      headers: {
        ...headers,
        'user-agent': headers['user-agent'] || UA
      },
      responseType: 'buffer',
      retry: { limit: 0 },
      timeout: { request: 30000 },
      http2: true
    };

    if (body) {
      options.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    if (proxy) {
      const proxyUrl = proxy.startsWith("http") ? proxy : `http://${proxy}`;
      options.proxyUrl = proxyUrl;
    }

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

const app = express();
app.use(cors());
app.use(express.json());

// Initialize MongoDB
const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/nebula-local";
const FANART_API_KEY = process.env.FANART_API_KEY || "";
const TMDB_API_KEY = process.env.TMDB_API_KEY || "";
const ADMIN_KEY = process.env.ADMIN_KEY || "nebula-admin-2026";

// app.listen(...)
// Note: Puppeteer pool initialization removed to save resources.
const VIDSRC_EMBED_HOST = (
  process.env.VIDSRC_EMBED_HOST || "https://vsembed.ru"
).replace(/\/$/, "");

// Residential Proxy Fallback
const RESIDENTIAL_PROXY = process.env.RESIDENTIAL_PROXY;
let residentialProxyCooldown = 0;

// ── Proxy Management ────────────────────────────────────────────────────────
const PROXIES_FILE = "./proxies_verified.json";
let proxyPool: string[] = [];

function loadProxyPool() {
  if (fs.existsSync(PROXIES_FILE)) {
    try {
      proxyPool = JSON.parse(fs.readFileSync(PROXIES_FILE, "utf-8"));
      console.log(
        `[PROXY] Pool loaded: ${proxyPool.length} proxies available.`,
      );
    } catch (e: any) {
      console.error(`[PROXY] Failed to parse ${PROXIES_FILE}:`, e.message);
    }
  } else {
    console.log(`[PROXY] No proxy file found. Using direct connection.`);
  }
}

function getRandomProxy(): string | undefined {
  if (proxyPool.length === 0) return undefined;
  return proxyPool[Math.floor(Math.random() * proxyPool.length)];
}

/**
 * Generates a sticky session URL for the residential proxy.
 * This ensures that L1 (Router), L2 (Wrapper), and Heartbeat all use the same IP.
 */
function getStickyProxy(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    const url = new URL(baseUrl);
    // Append sessid if it's a rotating proxy (containing 'flux' or similar)
    if (url.username && !url.username.includes("sessid")) {
      const sessionId = Math.random().toString(36).substring(2, 10);
      url.username = `${url.username}-sessid-${sessionId}-sesstime-5`;
    }
    return url.href;
  } catch (e) {
    return baseUrl;
  }
}

loadProxyPool();
// Optional: Auto-reload every 30 mins
setInterval(loadProxyPool, 30 * 60 * 1000);

const connectDB = async (retryCount = 5) => {
  try {
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 10000,
    });
    console.log("MongoDB Uplink Established");
  } catch (err: any) {
    if (retryCount > 0) {
      console.warn(
        `[DB] Uplink Failed. Retrying in 5s... (${retryCount} left)`,
      );
      setTimeout(() => connectDB(retryCount - 1), 5000);
    } else {
      console.error(
        "[DB] Uplink Failed Permanently. Running in volatile mode.",
        err.message,
      );
    }
  }
};

connectDB();

// Endpoint: Health Check (Lightweight, No Rate Limit)
app.get("/api/health", (req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

// Endpoint: Fetch Media Stream
app.get("/api/stream", async (req, res) => {
  const tmdbId = req.query.tmdbId as string;
  const kind = req.query.type as "movie" | "tv";
  const title = (req.query.title as string) || "";
  const season = parseInt((req.query.season as string) || "1", 10);
  const episode = parseInt((req.query.episode as string) || "1", 10);

  if (!tmdbId || !kind) {
    return res.status(400).json({ error: "Missing tmdbId or type" });
  }

  try {
    // 1. Check the stream cache first (expires every 4 hours)
    const cachedRecord = await StreamCache.findOne({
      tmdbId,
      type: kind,
      season,
      episode,
    }).catch(() => null);
    if (cachedRecord?.streamUrl && cachedRecord?.streamExpiresAt) {
      if (new Date() < cachedRecord.streamExpiresAt) {
        // Liveness check — probe the .m3u8 with a HEAD request to confirm the token is still valid.
        // Cloudnestra tokens can die early (IP rotation, CDN purge). If dead, fall through to re-scrape.
        let linkAlive = false;
        try {
          const probe = await axios.head(cachedRecord.streamUrl, {
            timeout: 4000,
            headers: {
              "User-Agent": "Mozilla/5.0",
              Referer: "https://cloudnestra.com/",
            },
            validateStatus: (s) => s < 400,
          });
          linkAlive = probe.status < 400;
        } catch {
          linkAlive = false;
        }

        if (linkAlive) {
          console.log(
            `[STREAM] Cache HIT ✔ (link alive) for ${tmdbId} S${season}E${episode}`,
          );
          return res.json({
            streamUrl: cachedRecord.streamUrl,
            source: cachedRecord.source || "cache",
            qualityTag: cachedRecord.qualityTag || "UNKNOWN",
            resolution: cachedRecord.resolution || "UNKNOWN",
            mirrors: cachedRecord.mirrors || [],
          });
        } else {
          console.warn(
            `[STREAM] Cache HIT ✘ (dead token) for ${tmdbId} — re-scraping...`,
          );
          // Invalidate the dead record immediately so the TTL index doesn't hold it longer
          await StreamCache.findOneAndUpdate(
            { tmdbId, type: kind, season, episode },
            { streamUrl: null, streamExpiresAt: new Date(0) },
          ).catch(() => null);
        }
      }
    }

    // 1. Cache Check (skipped for now for debugging, but let's keep it disabled if mirrors are requested)
    // We will bypass cache if we want fresh mirrors, but for now let's prioritize direct results.

    const mirrors: MirrorStream[] = [];
    let sourceName = "none";
    let qualityTag = "UNKNOWN";
    let resolution = "UNKNOWN";
    let streamUrl: string | null = null;
    let proxyUsed: string | undefined = undefined;

    const controller = new AbortController();
    const signal = controller.signal;

    req.on('close', () => {
      controller.abort();
      console.log(`[STREAM] User cancelled request. Aborting scrapers...`);
    });

    // ── Tier 0: Direct TMDB Path (VidLink) ──────────────────────────
    console.log(`[STREAM] Phase 0: Checking VidLink (Direct TMDB Path)...`);
    try {
      const vidlinkMirrors = await VidLinkScraper.getStream(
        tmdbId.toString(),
        kind as any,
        parseInt(season.toString()),
        parseInt(episode.toString())
      );
      if (vidlinkMirrors && vidlinkMirrors.length > 0) {
        console.log(`[STREAM] VidLink HIT ✔ (Found ${vidlinkMirrors.length} mirrors)`);
        mirrors.push(...vidlinkMirrors);
        streamUrl = vidlinkMirrors[0]!.url;
        sourceName = "VidLink";

        // Cache the result for 4 hours
        const exp = new Date();
        exp.setHours(exp.getHours() + 4);
        await StreamCache.findOneAndUpdate(
          { tmdbId, type: kind, season, episode },
          { streamUrl, source: sourceName, mirrors: vidlinkMirrors, streamExpiresAt: exp },
          { upsert: true }
        ).catch(() => null);

        return res.json({
          streamUrl,
          source: sourceName,
          qualityTag: "UNKNOWN",
          resolution: "UNKNOWN",
          mirrors: vidlinkMirrors
        });
      }
    } catch (e) {
      console.error(`[STREAM] VidLink failed:`, e);
    }

    // ── Tier 1+ Fallbacks (Fully Disabled by User Request) ──────────────
    if (mirrors.length === 0) {
      console.log(`[STREAM] VidLink failed and fallbacks are disabled.`);
      throw new Error("No stream sources found. (VidLink returned no mirrors)");
    }

    const allSubtitles: any[] = [];
    if (mirrors.length > 0) {
      streamUrl = mirrors[0].url;
      sourceName = mirrors[0].source;
      resolution = mirrors[0].quality || "1080p";
      qualityTag = resolution.includes("2160") ? "4K" : "HD";

      // Collect all subtitles from mirrors
      mirrors.forEach((m) => {
        if (m.subtitles) {
          allSubtitles.push(...m.subtitles);
        }
      });
    }

    if (mirrors.length === 0) {
      throw new Error("No stream sources found across all tiers.");
    }

    // 3. Optional: Cache the result (TODO: cache mirrors array in DB)
    // For now we don't cache mirrors, only the primary streamUrl for backward compatibility
    if (streamUrl) {
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 4);
      StreamCache.findOneAndUpdate(
        { tmdbId, type: kind, season, episode },
        {
          streamUrl,
          source: sourceName,
          qualityTag,
          resolution,
          mirrors,
          streamExpiresAt: expiresAt,
        },
        { upsert: true },
      ).catch((err) => console.error("[CACHE] Failed to save mirrors:", err));
    }

    // 4. Proxy URL injection — only for non-KissKH sources that used a proxy during scrape
    let finalUrl = streamUrl;
    if (finalUrl && proxyUsed && !finalUrl.includes("cdnvideo11.shop")) {
      try {
        const urlObj = new URL(finalUrl);
        urlObj.searchParams.set("nebula_proxy", proxyUsed);
        finalUrl = urlObj.href;
      } catch {}
    }

    console.log(
      `[STREAM] ✔ Found ${mirrors.length} mirrors. Primary source: ${sourceName}`,
    );

    return res.json({
      streamUrl: finalUrl,
      streams: [finalUrl],
      mirrors: mirrors.map((m) => {
        // Inject proxy if needed for the specific mirror (vsembed)
        if (m.source.includes("vsembed") && proxyUsed) {
          try {
            const u = new URL(m.url);
            u.searchParams.set("nebula_proxy", proxyUsed);
            m.url = u.href;
          } catch {}
        }
        // Inject subtitle proxy for .srt or KissKH subs
        if (m.subtitles) {
          m.subtitles = m.subtitles.map((s) => {
            if (s.url.toLowerCase().endsWith(".srt") || s.source === "KissKH") {
              return {
                ...s,
                url: `/api/proxy/subtitle?url=${encodeURIComponent(s.url)}`,
              };
            }
            return s;
          });
        }

        return m;
      }),
      subtitles: (allSubtitles.length > 0 ? allSubtitles : undefined)?.map(
        (s) => {
          if (s.url.toLowerCase().endsWith(".srt") || s.source === "KissKH") {
            return {
              ...s,
              url: `/api/proxy/subtitle?url=${encodeURIComponent(s.url)}`,
            };
          }
          return s;
        },
      ),
      source: sourceName,
      qualityTag,
      resolution,
    });
  } catch (error: any) {
    console.error(`[STREAM] ✘ Failed for tmdbId=${tmdbId}: ${error.message}`);
    return res
      .status(404)
      .json({ error: error.message || "No stream sources found." });
  }
});

// Endpoint: TV Show Details (episode counts per season)
// Proxies TMDB so the API key never lives in the frontend bundle.
app.get("/api/tv-details/:tmdbId", async (req, res) => {
  const { tmdbId } = req.params;
  
  // Handle KissKH IDs (prefixed with 'k')
  if (tmdbId.startsWith('k')) {
    const dramaId = parseInt(tmdbId.replace('k', ''));
    console.log(`[DRAMA] Fetching KissKH details for proxy: ${dramaId}`);
    try {
      const details = await KissKHScraper.getDramaDetail(dramaId);
      if (!details) return res.status(404).json({ error: "Drama not found" });
      
      // Normalize to TMDB-like structure for the frontend drawer
      return res.json({
        number_of_seasons: 1, // KissKH usually treats all episodes as one season or handles them differently
        seasons: [{
          season_number: 1,
          episode_count: details.episodes?.length || 0,
          name: "Season 1"
        }],
        episodes: (details.episodes || []).map((ep: any) => ({
          episode_number: ep.number,
          name: `Episode ${ep.number}`,
          id: ep.id
        }))
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (!TMDB_API_KEY)
    return res.status(500).json({ error: "TMDB_API_KEY not configured" });
  try {
    const r = await axios.get(`https://api.themoviedb.org/3/tv/${tmdbId}`, {
      headers: { Authorization: `Bearer ${TMDB_API_KEY}` },
      timeout: 8000,
    });
    return res.json(r.data);
  } catch (err: any) {
    return res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// Endpoint: Fetch Subtitles (Lazy Load / Aggregated Background Request)
app.get("/api/subtitles", async (req, res) => {
  const tmdbId = req.query.tmdbId as string;
  const kind = req.query.type as "movie" | "tv";
  const season = parseInt((req.query.season as string) || "1", 10);
  const episode = parseInt((req.query.episode as string) || "1", 10);

  if (!tmdbId || !kind) {
    return res.status(400).json({ error: "Missing tmdbId or type" });
  }

  try {
    // 1. Check permanent cache first
    const cached = await SubtitleCache.findOne({
      tmdbId,
      type: kind,
      season,
      episode,
    });
    if (cached && cached.subtitles?.length > 0) {
      console.log(`[SUBS] Cache HIT for ${tmdbId} S${season}E${episode}`);
      return res.json({ subtitles: cached.subtitles });
    }

    // 2. Aggregate from trackers in parallel
    console.log(
      `[SUBS] Aggregating tracks for ${tmdbId} S${season}E${episode}...`,
    );

    // Using allSettled so one tracker failing doesn't kill the whole request
    const results = await Promise.allSettled([
      getSubtitles(tmdbId, kind, season, episode),
      // Future trackers (e.g. Subscene, OpenSubtitles Direct) would go here
    ]);

    const aggregated = results
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => (r as PromiseFulfilledResult<any[]>).value);

    // 3. Save to permanent cache
    if (aggregated.length > 0) {
      await SubtitleCache.findOneAndUpdate(
        { tmdbId, type: kind, season, episode },
        { subtitles: aggregated, aggregatedAt: new Date() },
        { upsert: true },
      ).catch(() => null);
    }

    const proxied = aggregated.map((s) => {
      if (s.url.toLowerCase().endsWith(".srt")) {
        return {
          ...s,
          url: `/api/proxy/subtitle?url=${encodeURIComponent(s.url)}`,
        };
      }
      return s;
    });

    return res.json({ subtitles: proxied });
  } catch (error: any) {
    console.warn(`[SUBS] ✘ Aggregation issue for ${tmdbId}: ${error.message}`);
    return res.json({ subtitles: [] }); // Always return [] instead of error to prevent player crash
  }
});

// Endpoint: Stop stream heartbeat (call when player closes/user leaves)
app.get("/api/stream/stop", (req, res) => {
  const tmdbId = req.query.tmdbId as string;
  if (!tmdbId) return res.status(400).json({ error: "Missing tmdbId" });
  stopHeartbeat(tmdbId, req.ip);
  return res.json({ ok: true });
});

// Endpoint: Flush stream cache (force re-scrape on next play)
app.post("/api/stream/flush", async (req, res) => {
  const tmdbId = req.body?.tmdbId as string;
  if (!tmdbId) return res.status(400).json({ error: "Missing tmdbId" });
  await StreamCache.findOneAndUpdate(
    { tmdbId },
    { streamUrl: null, streamExpiresAt: null, subtitles: [] },
    {},
  ).catch(() => null);
  return res.json({ ok: true, message: "Stream cache cleared for " + tmdbId });
});

// ─────────────────────────────────────────────────────────────────────────────
// HLS Proxy — relays CDN requests with correct Referer/Origin headers.
//
// The Cloudnestra CDN blocks direct browser fetch (CORS + Referer check).
// hls.js in the browser points at this proxy instead of the raw CDN URL.
//
// Routes:
//   GET /api/proxy/stream?url=<encoded_m3u8_url>
//     — Fetches the master/variant m3u8, rewrites all segment URLs to also
//       go through this proxy, and returns the modified manifest.
//
//   GET /api/proxy/segment?url=<encoded_ts_or_key_url>
//     — Fetches a raw .ts segment or AES key and streams it back as-is.
// ─────────────────────────────────────────────────────────────────────────────

const CDN_REFERER = "https://cloudnestra.com/";

function cdnHeaders(targetUrl?: string, isManifest: boolean = false) {
  let referer = CDN_REFERER;
  let origin = new URL(CDN_REFERER).origin;
  let cookie: string | null = null;

  // Default browser headers for fetch/CORS
  const headers: any = {
    'accept': '*/*',
    'accept-language': 'en-US,en;q=0.7',
    'cache-control': 'no-cache',
    'pragma': 'no-cache',
    'priority': 'u=1, i',
    'sec-ch-ua': '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': isManifest ? 'empty' : 'video',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'cross-site',
    'user-agent': UA
  };

  if (targetUrl) {
    const lower = targetUrl.toLowerCase();
    
    // Extract embedded headers if present (VidLink/Storm CDNs use this for inner requests)
    try {
      const urlObj = new URL(targetUrl);
      const customHeaders = urlObj.searchParams.get("headers");
      const hostParam = urlObj.searchParams.get("host");

      if (customHeaders) {
        const parsed = JSON.parse(customHeaders);
        if (parsed.referer) referer = parsed.referer;
        if (parsed.origin) origin = parsed.origin;
        if (parsed.cookie) cookie = parsed.cookie;
      }
      
      // If a host param is provided, it might be the target host for the proxy
      if (hostParam) {
        // Use it only if not already set by customHeaders
        if (referer === CDN_REFERER) referer = hostParam.endsWith('/') ? hostParam : hostParam + '/';
        if (origin === "https://cloudnestra.com") origin = new URL(hostParam).origin;
      }
    } catch {}

    // Final overrides for specific providers that are extremely sensitive to outer Referer
    if (lower.includes("storm.vodvidl.site") || lower.includes("vidlink.pro") || lower.includes("nightbreeze") || lower.includes("thunderleaf")) {
      referer = "https://vidlink.pro/";
      origin = "https://vidlink.pro";
    }

    // Auto-detect KissKH CDNs
    if (
      lower.includes("kisskh") ||
      lower.includes("cdnvideo") ||
      /stream\d+\.store/.test(lower) ||
      lower.includes("stream.store")
    ) {
      referer = "https://kisskh.do";
      origin = "https://kisskh.do";
    }
  }

  headers["referer"] = referer;
  headers["origin"] = origin;

  if (cookie) headers["cookie"] = cookie;

  return headers;
}

/**
 * Creates a TLS-hardened agent that mimics a browser's JA3 fingerprint.
 * This helps bypass CDN blocks that detect standard Node.js handshakes.
 */
function createHardenedAgent(proxyUrl?: string) {
  // Chrome 131 Cipher Suite
  const ciphers = [
    "TLS_AES_128_GCM_SHA256",
    "TLS_AES_256_GCM_SHA384",
    "TLS_CHACHA20_POLY1305_SHA256",
    "ECDHE-ECDSA-AES128-GCM-SHA256",
    "ECDHE-RSA-AES128-GCM-SHA256",
    "ECDHE-ECDSA-AES256-GCM-SHA384",
    "ECDHE-RSA-AES256-GCM-SHA384",
    "ECDHE-ECDSA-CHACHA20-POLY1305",
    "ECDHE-RSA-CHACHA20-POLY1305",
    "ECDHE-RSA-AES128-SHA",
    "ECDHE-RSA-AES256-SHA",
    "AES128-GCM-SHA256",
    "AES256-GCM-SHA384",
    "AES128-SHA",
    "AES256-SHA",
  ].join(":");

  const tlsOptions: https.AgentOptions = {
    ciphers,
    honorCipherOrder: true,
    minVersion: "TLSv1.2",
    maxVersion: "TLSv1.3",
    ecdhCurve: "X25519:P-256:P-384",
  };

  if (proxyUrl) {
    const safeProxy = proxyUrl.endsWith("/") ? proxyUrl.slice(0, -1) : proxyUrl;
    const JarlessHttpsCookieProxyAgent = createCookieAgent(HttpsProxyAgent);
    return new JarlessHttpsCookieProxyAgent(safeProxy, {
      ...tlsOptions,
      cookies: { jar: new CookieJar() as any },
    });
  }

  const JarlessHttpsCookieAgent = createCookieAgent(https.Agent);
  return new JarlessHttpsCookieAgent({
    ...tlsOptions,
    cookies: { jar: new CookieJar() as any },
  });
}

// Proxy: .m3u8 manifest — fetches and rewrites segment/variant URLs
app.get("/api/proxy/stream", async (req, res) => {
  const raw = req.query.url as string;
  if (!raw) return res.status(400).send("Missing url");

  let targetUrl = raw;
  if (!targetUrl.startsWith("http")) {
    try {
      targetUrl = decodeURIComponent(targetUrl);
    } catch {
      return res.status(400).send("Invalid url encoding");
    }
  }

  // Extract proxy from two possible locations:
  // 1. Baked into the target CDN URL as ?nebula_proxy=... (master playlist, set by /api/stream)
  // 2. As a direct query param of this endpoint (?nebula_proxy=...) (variant sub-playlists, set by withProxy())
  let streamProxy: string | undefined;

  // Check direct request param first (variant playlists)
  const directProxy = req.query.nebula_proxy as string | undefined;
  if (directProxy) {
    try {
      streamProxy = decodeURIComponent(directProxy);
    } catch {}
  }

  console.log(`[PROXY/stream] Incoming Original URL: ${req.originalUrl}`);
  
  // Fall back to baked-in param inside the target URL (master playlist)
  if (!streamProxy) {
    const bakedMatch = targetUrl.match(/[\?&]nebula_proxy=([^&]+)/);
    if (bakedMatch) {
      try {
        streamProxy = decodeURIComponent(bakedMatch[1]);
        // Remove the param from the URL while preserving everything else exactly
        targetUrl = targetUrl.replace(/[\?&]nebula_proxy=[^&]+/, '').replace(/\?$/, '').replace(/\?&/, '?');
      } catch {}
    }
  }

  const cacheKey = targetUrl;
  const cached = proxyCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    console.log(`[PROXY/stream] ⚡ Cache Hit: ${targetUrl.substring(0, 60)}...`);
    res.setHeader("Content-Type", cached.headers["content-type"] || "application/vnd.apple.mpegurl");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.send(cached.body);
  }

  const startTime = Date.now();
  console.log(
    `[PROXY/stream] ▶ ${targetUrl.substring(0, 80)} | proxy=${streamProxy ? "YES" : "NONE"}`,
  );

  try {
    const isVidLink = targetUrl.includes("storm.vodvidl.site") || targetUrl.includes("vidlink.pro");
    let upstream: any;
    if (isVidLink) {
      upstream = await fetchVidLinkRaw(targetUrl);
    } else {
      const streamHeaders = cdnHeaders(targetUrl, true);
      upstream = await fetchWithCycleTLS(targetUrl, streamHeaders, streamProxy);
    }
    const status = upstream.statusCode;
    const duration = Date.now() - startTime;
    if (status >= 400) {
      console.error(`[PROXY/stream] ✘ ${status} (${duration}ms) | url=${targetUrl.substring(0, 60)}...`);
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.status(status).send(upstream.body);
    }

    const manifest = upstream.body.toString('utf-8');
    
    if (typeof manifest !== "string") {
      return res.status(502).send("Invalid manifest content");
    }

    // Use the actual final URL after redirects for resolving relative paths
    const actualTargetUrl = upstream.finalUrl;
    const urlObj = new URL(actualTargetUrl);
    const origin = urlObj.origin;
    const baseDir = actualTargetUrl.substring(0, actualTargetUrl.lastIndexOf('/') + 1);

    // Optimized URL resolution (much faster than new URL() in a loop)
    const fastResolve = (uri: string) => {
      if (uri.startsWith('http')) return uri;
      if (uri.startsWith('//')) return `https:${uri}`;
      if (uri.startsWith('/')) return origin + uri;
      return baseDir + uri;
    };

    const withProxy = (endpoint: string, encodedUrl: string) => {
      const protocol = req.headers["x-forwarded-proto"] || req.protocol;
      const currentHost = process.env.API_URL || `${protocol}://${req.get("host")}`;
      const proxyParam = streamProxy ? `&nebula_proxy=${encodeURIComponent(streamProxy!)}` : "";
      return `${currentHost}${endpoint}?url=${encodedUrl}${proxyParam}`;
    };

    console.log(`[PROXY] Rewriting manifest: ${actualTargetUrl.substring(0, 60)}...`);

    let rewrittenCount = 0;
    
    // 1. Rewrite URI= attributes in tags
    let proxified = manifest.replace(/URI=(?:"([^"]+)"|([^",\s][^,\s]*))/g, (match, quoted, unquoted) => {
      const uri = (quoted || unquoted).trim();
      if (!uri) return match;
      
      const abs = fastResolve(uri);
      const ext = abs.split('?')[0]?.split('.').pop()?.toLowerCase();
      const proxyPath = ext === "m3u8" ? "/api/proxy/stream" : "/api/proxy/segment";
      
      rewrittenCount++;
      const proxiedUrl = withProxy(proxyPath, encodeURIComponent(abs));
      return quoted ? `URI="${proxiedUrl}"` : `URI=${proxiedUrl}`;
    });

    // 2. Rewrite segment/playlist lines (lines not starting with #)
    proxified = proxified.replace(/^(?!#)(.+)$/gm, (match, uri) => {
      const trimmed = uri.trim();
      if (!trimmed) return match;

      const abs = fastResolve(trimmed);
      const ext = abs.split('?')[0]?.split('.').pop()?.toLowerCase();
      const proxyPath = ext === "m3u8" ? "/api/proxy/stream" : "/api/proxy/segment";

      rewrittenCount++;
      return withProxy(proxyPath, encodeURIComponent(abs));
    });

    console.log(`[PROXY] Rewrote ${rewrittenCount} URLs in manifest.`);
    if (rewrittenCount === 0 && manifest.length > 50) {
      console.warn(`[PROXY] WARNING: Zero URLs rewrote in a manifest of length ${manifest.length}! Content preview: ${manifest.substring(0, 100)}`);
    } else {
      console.log(`[PROXY] Manifest preview (rewritten): ${proxified.substring(0, 300).replace(/\n/g, ' ')}...`);
    }

    // Cache successful rewritten manifest
    proxyCache.set(cacheKey, {
      body: Buffer.from(proxified, 'utf-8'),
      headers: upstream.headers,
      expires: Date.now() + CACHE_TTL
    });

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    return res.send(proxified);
  } catch (e: any) {
    const status = e?.response?.statusCode ?? "no-response";
    const body = String(e?.response?.body ?? "").substring(0, 200);
    const url = targetUrl.substring(0, 100);
    console.error(
      `[PROXY/stream] ✘ ${status} | proxy=${streamProxy ? "YES" : "NONE"} | error=${e.code} | message=${e.message} | url=${url}`,
    );
    if (body) console.error(`[PROXY/stream] CDN response: ${body}`);
    
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(502).send("Proxy upstream error");
  }
});

// Proxy: raw segment / AES key — pass-through binary stream
// Uses residential proxy only when nebula_proxy is passed (IP-auth CDNs like roilandrelic.website)
app.get("/api/proxy/segment", async (req, res) => {
  const raw = req.query.url as string;
  if (!raw) return res.status(400).send("Missing url");

  let targetUrl = raw;
  if (!targetUrl.startsWith("http")) {
    try {
      targetUrl = decodeURIComponent(targetUrl);
    } catch {
      return res.status(400).send("Invalid url encoding");
    }
  }

  // Read the proxy param if the manifest rewriter passed one
  const rawProxy = req.query.nebula_proxy as string | undefined;
  let segProxy: string | undefined;
  if (rawProxy) {
    try {
      segProxy = decodeURIComponent(rawProxy);
    } catch {}
  }

  const cacheKey = targetUrl;
  const cached = proxyCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    res.setHeader("Content-Type", cached.headers["content-type"] || "video/mp2t");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.status(200).end(cached.body);
  }

  const startTime = Date.now();
  const fetchSegment = async (targetUrl: string, useProxy: boolean): Promise<any> => {
    const isVidLink = targetUrl.includes("storm.vodvidl.site") || targetUrl.includes("vidlink.pro");
    if (isVidLink) {
      return fetchVidLinkRaw(targetUrl);
    }
    return fetchWithCycleTLS(targetUrl, cdnHeaders(targetUrl, false), useProxy ? segProxy : undefined);
  };

  try {
    // Try direct first. If 403 AND proxy available, retry through proxy.
    const response = await fetchSegment(targetUrl, false);
    const status = response.statusCode;

    if (status === 403 && segProxy) {
      const proxyResponse = await fetchSegment(targetUrl, true);
      const duration = Date.now() - startTime;
      if (proxyResponse.statusCode >= 400) {
        console.log(`[PROXY/segment] ◀ ${proxyResponse.statusCode} (proxy, ${duration}ms)`);
      }
      
      if (proxyResponse.statusCode === 200) {
        proxyCache.set(cacheKey, {
          body: proxyResponse.body,
          headers: proxyResponse.headers,
          expires: Date.now() + SEGMENT_TTL
        });
      }
      
      res.setHeader("Content-Type", proxyResponse.headers["content-type"] || "video/mp2t");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.status(proxyResponse.statusCode).send(proxyResponse.body);
    } else {
      const duration = Date.now() - startTime;
      if (status >= 400) {
        console.error(`[PROXY/segment] ✘ ${status} | url=${targetUrl.substring(0, 60)}...`);
      }

      if (status === 200) {
        proxyCache.set(cacheKey, {
          body: response.body,
          headers: response.headers,
          expires: Date.now() + SEGMENT_TTL
        });
      }

      res.setHeader("Content-Type", response.headers["content-type"] || "video/mp2t");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.status(status).end(response.body);
    }
  } catch (e: any) {
    const status = e?.response?.statusCode ?? "no-response";
    const url = targetUrl.substring(0, 100);
    console.error(
      `[PROXY/segment] ✘ ${status} | proxy=${segProxy ? "YES" : "NONE"} | error=${e.code} | message=${e.message} | url=${url}`,
    );
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(502).send("Proxy segment error");
  }
});

// Proxy: subtitles — fetches SRT/VTT, converts SRT to VTT if needed
app.get("/api/proxy/subtitle", async (req, res) => {
  const raw = req.query.url as string;
  if (!raw) return res.status(400).send("Missing url");

  let targetUrl: string;
  try {
    targetUrl = decodeURIComponent(raw);
  } catch {
    return res.status(400).send("Invalid url encoding");
  }

  console.log(`[PROXY/sub] ▶ ${targetUrl.substring(0, 80)}`);

  try {
    const upstream = await axios.get(targetUrl, {
      responseType: "text",
      timeout: 15000,
      headers: {
        "User-Agent": UA,
        Referer: "https://kisskh.do/",
        Origin: "https://kisskh.do",
      },
    });

    let content: string = upstream.data;

    // SRT → VTT conversion
    if (
      targetUrl.toLowerCase().endsWith(".srt") ||
      (!content.startsWith("WEBVTT") && content.includes(" --> "))
    ) {
      if (!content.startsWith("WEBVTT")) {
        content = "WEBVTT\n\n" + content;
      }
      // Convert SRT timestamps: 00:00:20,000 → 00:00:20.000
      content = content.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
    }

    res.setHeader("Content-Type", "text/vtt");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=86400");
    return res.send(content);
  } catch (e: any) {
    console.error(`[PROXY/sub] ✘ Error: ${e.message}`);
    return res.status(502).send("Subtitle proxy error");
  }
});

app.all("/api/cache/clear", async (req, res) => {
  const key = req.headers["x-admin-key"] || req.query.key;
  if (key !== ADMIN_KEY)
    return res
      .status(401)
      .json({ error: "Unauthorized access — specify ?key= in URL" });

  try {
    await Promise.all([
      MetadataCache.deleteMany({}),
      DiscoveryCache.deleteMany({}),
      DramaDetailCache.deleteMany({}),
    ]);
    console.log("Registry Cache Flushed Successfully");
    res.json({
      success: true,
      message: "Registry cache cleared successfully.",
    });
  } catch (err) {
    res.status(500).json({ error: "Cache flush failure" });
  }
});

app.get("/api/metadata", async (req, res) => {
  const tmdbId = req.query.tmdbId as string;
  const isBatch = req.query.batch as string;
  const type = (req.query.type as any) || "movie";

  if (isBatch) {
    const combos = isBatch.split(",").filter((id) => id.trim());
    const results = await Promise.all(
      combos.map(async (combo) => {
        const parts = combo.split(":");
        const id = parts[0] || "";
        const subType = parts[1] || "movie";
        const meta = await getFanartMetadata(id, (subType as any) || "movie");
        return { id, ...meta };
      }),
    );
    return res.json({ results });
  }

  if (!tmdbId) return res.status(400).json({ error: "Missing tmdbId" });

  try {
    const result = await getFanartMetadata(tmdbId, type);
    return res.json(result || { logoUrl: null, backgroundUrl: null });
  } catch (error: any) {
    console.error(`[METADATA ERROR] ${error.message}`);
    return res.status(500).json({ error: "Failed to extract metadata" });
  }
});

// Endpoint: KissKH Drama Discovery (with Caching)
app.get("/api/drama/list", async (req, res) => {
  const type = parseInt(req.query.type as string) || 0;
  const country = parseInt(req.query.country as string) || 0;
  const page = parseInt(req.query.page as string) || 1;
  const order = parseInt(req.query.order as string) || 1;

  const cacheKey = `discover-${country}-${type}-${page}-${order}`;

  try {
    // Check Cache
    const cached = await DiscoveryCache.findOne({ key: cacheKey });
    if (cached) {
      console.log(`[DISCOVERY] Cache HIT for ${cacheKey}`);
      return res.json({ results: cached.results });
    }

    console.log(`[DISCOVERY] Cache MISS. Fetching KissKH Explore...`);
    const list = await KissKHScraper.getExploreList(type, country, page, order);
    const results = list.map((d) => ({
      id: `k${d.id}`,
      title: d.title,
      image: d.thumbnail,
      type: "tv",
      genre: "Drama",
      rating: d.rating,
      countryId: d.countryId || (country ? parseInt(country.toString()) : 0),
      origin: "kisskh",
      isDrama: true,
    }));

    // Save to Cache (1 hour)
    const expires = new Date();
    expires.setHours(expires.getHours() + 1);
    await DiscoveryCache.findOneAndUpdate(
      { key: cacheKey },
      { results, expiresAt: expires },
      { upsert: true },
    ).catch(() => null);

    return res.json({ results });
  } catch (e: any) {
    console.error(`[DRAMA LIST ERROR] ${e.message}`);
    return res.json({ results: [] });
  }
});

app.get("/api/drama/detail/:id", async (req, res) => {
  const { id } = req.params;
  const dramaId = parseInt(id.replace("k", ""));

  try {
    const cached = await DramaDetailCache.findOne({ dramaId });
    if (cached) {
      console.log(`[DRAMA] Cache HIT for detail ${id}`);
      return res.json(cached.detail);
    }

    console.log(`[DRAMA] Cache MISS for detail ${id}. Fetching...`);
    const details = await KissKHScraper.getDramaDetail(dramaId);
    if (!details) return res.status(404).json({ error: "Drama not found" });

    // Normalize episodes
    const normalized = {
      ...details,
      episodes: (details.episodes || [])
        .map((ep: any) => ({
          episode_number: ep.number,
          name: `Episode ${ep.number}`,
          overview: "",
          still_path: details.thumbnail,
          air_date: "",
          id: ep.id,
        }))
        .sort((a: any, b: any) => a.episode_number - b.episode_number),
    };

    await DramaDetailCache.findOneAndUpdate(
      { dramaId },
      {
        detail: normalized,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
      },
      { upsert: true },
    ).catch(() => null);

    return res.json(normalized);
  } catch (e: any) {
    return res.status(500).json({ error: e.message });
  }
});

// Endpoint: Image Proxy (Bypasses TMDB Blocks/CORS)
app.get("/api/image", async (req, res) => {
  const url = req.query.url as string;
  if (!url) return res.status(400).send("Missing url");

  try {
    const agent = createHardenedAgent();
    const response = await axios.get(url, {
      responseType: "stream",
      timeout: 10000,
      headers: { "User-Agent": UA },
      httpAgent: agent,
      httpsAgent: agent,
    });
    
    // Pass along content type
    const contentType = response.headers["content-type"];
    if (contentType) res.setHeader("Content-Type", contentType);

    // Add long caching
    res.setHeader("Cache-Control", "public, max-age=31536000");

    response.data.pipe(res);
  } catch (e: any) {
    res.status(500).send("Image proxy failed");
  }
});

async function getIMDBId(tmdbId: string) {
  try {
    const res = await axios.get(
      `https://api.themoviedb.org/3/movie/${tmdbId}`,
      {
        headers: { Authorization: `Bearer ${TMDB_API_KEY}` },
      },
    );
    return res.data.imdb_id;
  } catch (e) {
    return null;
  }
}

async function getTVDBId(tmdbId: string) {
  try {
    const res = await axios.get(
      `https://api.themoviedb.org/3/tv/${tmdbId}/external_ids`,
      {
        headers: { Authorization: `Bearer ${TMDB_API_KEY}` },
      },
    );
    return res.data.tvdb_id;
  } catch (e) {
    return null;
  }
}

async function getFanartMetadata(
  tmdbId: string,
  type: "movie" | "tv" = "movie",
) {
  if (!FANART_API_KEY || FANART_API_KEY === "your_fanart_api_key_here") {
    return { logoUrl: null, backgroundUrl: null };
  }

  // Check Cache (Type-aware)
  const cached = await MetadataCache.findOne({ tmdbId, type }).catch(
    () => null,
  );
  if (cached && cached.logoFetchedAt) {
    // If it was fetched more than 24h ago, we might want to retry if logo was null
    const wasEmpty = !cached.logoUrl;
    const isOld =
      Date.now() - new Date(cached.logoFetchedAt).getTime() >
      1000 * 60 * 60 * 24;

    if (!wasEmpty || !isOld) {
      return { logoUrl: cached.logoUrl, backgroundUrl: cached.backgroundUrl };
    }
    console.log(`[FANART] Retrying empty/old cache for ${tmdbId}`);
  }

  try {
    let finalId = tmdbId;
    if (type === "tv") {
      const tvdbId = await getTVDBId(tmdbId);
      if (!tvdbId) return { logoUrl: null, backgroundUrl: null };
      finalId = tvdbId.toString();
    }

    const endpoint = type === "tv" ? "tv" : "movies";
    const fanartUrl = `https://webservice.fanart.tv/v3/${endpoint}/${finalId}?api_key=${FANART_API_KEY}`;

    console.log(
      `[FANART] Fetching for ${type}: ${finalId} -> ${fanartUrl.replace(FANART_API_KEY!, "***")}`,
    );
    let raw = await fetch(fanartUrl);

    if (!raw.ok) {
      console.warn(`[FANART] API returned ${raw.status} for ${finalId}`);
      // Fallback: If TVDB failed or returned 404, try TMDB ID directly as some TV entries exist under TMDB ID on Fanart
      if (type === "tv" && finalId !== tmdbId) {
        const tmdbFanartUrl = `https://webservice.fanart.tv/v3/tv/${tmdbId}?api_key=${FANART_API_KEY}`;
        console.log(`[FANART] Falling back to TMDB ID: ${tmdbId}`);
        raw = await fetch(tmdbFanartUrl);
      }

      if (!raw.ok) return { logoUrl: null, backgroundUrl: null };
    }

    let data: any = {};
    try {
      data = await raw.json();
    } catch (err) {
      console.error(`[FANART] Failed to parse JSON for ${finalId}`);
      return { logoUrl: null, backgroundUrl: null };
    }

    // Secondary Fallback for Movies: IMDB ID
    if (type === "movie" && !data.hdmovielogo && !data.movielogo) {
      const imdbId = await getIMDBId(tmdbId);
      if (imdbId) {
        const imdbUrl = `https://webservice.fanart.tv/v3/movies/${imdbId}?api_key=${FANART_API_KEY}`;
        const imdbRaw = await fetch(imdbUrl);
        const imdbData = await imdbRaw.json();
        if (imdbData.hdmovielogo || imdbData.movielogo) {
          data = imdbData;
        }
      }
    }

    let hdLogo = null;
    let backgroundUrl = null;

    const sortByLikes = (arr: any[] = []) =>
      [...arr].sort(
        (a, b) =>
          (parseInt(b.likes || b.vote_count) || 0) -
          (parseInt(a.likes || a.vote_count) || 0),
      );

    // LAST RESORT FALLBACK: TMDB Images (if Fanart has nothing)
    if (
      !data.hdtvlogo &&
      !data.clearlogo &&
      !data.hdmovielogo &&
      !data.movielogo
    ) {
      console.log(
        `[FANART] No logo on Fanart for ${tmdbId}, trying TMDB fallback...`,
      );
      try {
        const tmdbImgUrl = `https://api.themoviedb.org/3/${type}/${tmdbId}/images?include_image_language=en,null`;
        const tmdbRes = await axios.get(tmdbImgUrl, {
          headers: { Authorization: `Bearer ${TMDB_API_KEY}` },
        });
        const tmdbLogos = sortByLikes(tmdbRes.data.logos || []);
        if (tmdbLogos.length > 0) {
          hdLogo = `https://image.tmdb.org/t/p/original${tmdbLogos[0].file_path}`;
          console.log(`[FANART] Found TMDB logo fallback: ${hdLogo}`);
        }
      } catch (e) {
        console.error(`[FANART] TMDB fallback failed for ${tmdbId}`);
      }
    }

    if (type === "tv") {
      const hdtvlogo = sortByLikes(data.hdtvlogo || []);
      const clearlogo = sortByLikes(data.clearlogo || []);

      // User Priority: HD ClearLOGO (hdtvlogo) first
      const logoChoices = [...hdtvlogo, ...clearlogo];

      if (logoChoices.length > 0) {
        // Tie-breaker: English -> Neutral -> Most Liked
        const preferred =
          logoChoices.find((l: any) => l.lang === "en") ||
          logoChoices.find(
            (l: any) => !l.lang || l.lang === "00" || l.lang === "",
          ) ||
          logoChoices[0];
        hdLogo = preferred.url;
      }

      const selection = data.showbackground?.length
        ? { url: sortByLikes(data.showbackground)[0].url, cat: "show-bg" }
        : data.tvbackground?.length
          ? { url: sortByLikes(data.tvbackground)[0].url, cat: "tv-bg" }
          : data.tvthumb?.length
            ? { url: sortByLikes(data.tvthumb)[0].url, cat: "thumb" }
            : null;

      if (selection) backgroundUrl = selection.url;
    } else {
      const hdmovielogo = sortByLikes(data.hdmovielogo || []);
      const movielogo = sortByLikes(data.movielogo || []);
      const hdmovieclearlogo = sortByLikes(data.hdmovieclearlogo || []);
      const movieclearlogo = sortByLikes(data.movieclearlogo || []);

      // User Priority: HD ClearLOGO (hdmovielogo/hdmovieclearlogo) first
      const logoChoices = [
        ...hdmovielogo,
        ...hdmovieclearlogo,
        ...movielogo,
        ...movieclearlogo,
      ];

      if (logoChoices.length > 0) {
        const preferred =
          logoChoices.find((l: any) => l.lang === "en") ||
          logoChoices.find(
            (l: any) => !l.lang || l.lang === "00" || l.lang === "",
          ) ||
          logoChoices[0];
        hdLogo = preferred.url;
      }

      const selection = data.moviebackground?.length
        ? { url: sortByLikes(data.moviebackground)[0].url, cat: "movie-bg" }
        : data.moviethumb?.length
          ? { url: sortByLikes(data.moviethumb)[0].url, cat: "movie-thumb" }
          : data.moviebanner?.length
            ? { url: sortByLikes(data.moviebanner)[0].url, cat: "movie-banner" }
            : null;

      if (selection) backgroundUrl = selection.url;
    }

    // Save to Cache with Type
    await MetadataCache.findOneAndUpdate(
      { tmdbId, type },
      { logoUrl: hdLogo, backgroundUrl, logoFetchedAt: new Date(), type },
      { upsert: true },
    ).catch(() => null);

    // Final Fallback: If Fanart failed, try TMDB's own image registry for logos
    if (!hdLogo) {
      try {
        const tmdbLogoUrl = `https://api.themoviedb.org/3/${type === "tv" ? "tv" : "movie"}/${tmdbId}/images?include_image_language=en,null`;
        const tmdbRes = await axios.get(tmdbLogoUrl, {
          headers: { Authorization: `Bearer ${TMDB_API_KEY}` },
        });
        const logos = tmdbRes.data?.logos || [];
        if (logos.length > 0) {
          // Sort by vote count or width
          const bestTmdbLogo = logos.sort(
            (a: any, b: any) => (b.vote_average || 0) - (a.vote_average || 0),
          )[0];
          hdLogo = `https://image.tmdb.org/t/p/original${bestTmdbLogo.file_path}`;
        }
      } catch (tmdbErr) {
        // Silently fail TMDB fallback
      }
    }

    return { logoUrl: hdLogo, backgroundUrl };
  } catch (e: any) {
    console.error(`[FANART ERROR] ${type}:${tmdbId} -> ${e.message}`);
    return { logoUrl: null, backgroundUrl: null };
  }
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Nebula Backend Array active on http://localhost:${PORT}`);
  console.log(
    `Modes: Fanart [${FANART_API_KEY === "your_fanart_api_key_here" ? "DISABLED" : "ACTIVE"}], Scraper [ACTIVE]`,
  );
});
