import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import dotenv from "dotenv";
import axios from "axios";
import fs from "fs";
import https from "https";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import {
  MetadataCache,
  StreamCache,
  SubtitleCache,
  DiscoveryCache,
  DramaDetailCache,
  DeadPool,
} from "./models/Cache.js";
import { fetchWithCycleTLS, fetchWithGotScraping } from "./utils/bypass.js";
import { getSubtitles } from "./utils/subtitles.js";
import {
  decryptKissKHSubtitle,
  isKissKHSubtitleUrl,
} from "./utils/kisskhDecrypt.js";
import jschardet from "jschardet";
import iconv from "iconv-lite";
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

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";
import { DramacoolScraper } from "./utils/dramacool.js";
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

// ── Process Crash Guards ───────────────────────────────────────────────────
// Must be registered before any async code runs. Prevents silent process death
// from unhandled rejections in scraper/proxy callbacks.
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
  // Don't exit — Railway will restart if needed; keep serving other users.
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled promise rejection:', reason);
});

// Simple memory cache for proxy requests to speed up playback and avoid repeat bypasses
const proxyCache = new Map<
  string,
  { body: Buffer; headers: any; expires: number }
>();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const MAX_CACHE_ENTRIES = 100; // Increased to 100 now that we are in production mode (saves network)

function setProxyCache(
  key: string,
  value: { body: Buffer; headers: any; expires: number },
) {
  if (proxyCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = proxyCache.keys().next().value;
    if (oldestKey) {
      proxyCache.delete(oldestKey);
    }
  }
  proxyCache.set(key, value);
}

let cacheHits = 0;
let cacheMisses = 0;

// Pruning logic to prevent memory leaks in proxyCache
setInterval(
  () => {
    const now = Date.now();
    let pruned = 0;
    for (const [key, val] of proxyCache.entries()) {
      if (val.expires < now) {
        proxyCache.delete(key);
        pruned++;
      }
    }
    if (pruned > 0)
      console.log(
        `[CACHE] Pruned ${pruned} expired entries from proxyCache. Size: ${proxyCache.size}`,
      );
  },
  5 * 60 * 1000,
); // Every 5 minutes

// Memory Monitor & DB Heartbeat
setInterval(
  async () => {
    const used = process.memoryUsage();
    const hitRate =
      cacheHits + cacheMisses > 0
        ? ((cacheHits / (cacheHits + cacheMisses)) * 100).toFixed(1)
        : 0;

    // DB Heartbeat to prevent Atlas idle timeout (Atlas drops idle TCP after 30 mins)
    let dbStatus = "OFFLINE";
    if (mongoose.connection.readyState === 1) {
      try {
        await mongoose.connection.db?.admin().ping();
        dbStatus = "ONLINE";
      } catch (e) {
        dbStatus = "PING_FAIL";
      }
    } else if (mongoose.connection.readyState === 2) {
      dbStatus = "CONNECTING";
    }

    console.log(
      `[STATS] RAM: ${(used.rss / 1024 / 1024).toFixed(1)}MB | DB: ${dbStatus} | Cache: ${proxyCache.size}/${MAX_CACHE_ENTRIES} | HitRate: ${hitRate}%`,
    );
    // Reset counters periodically to see current performance
    if (cacheHits + cacheMisses > 1000) {
      cacheHits = 0;
      cacheMisses = 0;
    }
  },
  5 * 60 * 1000,
); // Every 5 minutes

// Warm up got-scraping to avoid delay on first request
setTimeout(async () => {
  try {
    console.log("[GOT] Warming up browser fingerprints...");
    await gotScraping.get("https://vidlink.pro", {
      timeout: { request: 5000 },
      retry: { limit: 0 },
    });
    console.log("[GOT] Warm-up complete.");
  } catch {}
}, 5000);

/**
 * Fetches a VidLink/Storm URL using raw Node.js https.request.
 * IMPORTANT: This bypasses WHATWG URL normalization (used by got/fetch/axios).
 * Storm CDN requires literal { } braces in query params — any library that
 * parses the URL with WHATWG will encode them to %7B/%7D and get a 400.
 */
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 256, // Increased from 128 to handle high concurrency segments
  maxFreeSockets: 64,
  timeout: 30000, // Increased to 30s for slower CDN segments
});

function fetchVidLinkRaw(
  rawUrl: string,
  customHeaders: any = {},
  redirectCount = 0,
): Promise<{
  statusCode: number;
  headers: any;
  body: Buffer;
  finalUrl: string;
}> {
  if (redirectCount > 5) return Promise.reject(new Error("Too many redirects"));

  return new Promise((resolve, reject) => {
    const qIdx = rawUrl.indexOf("?");
    const baseOnly = qIdx >= 0 ? rawUrl.substring(0, qIdx) : rawUrl;
    const rawQuery = qIdx >= 0 ? rawUrl.substring(qIdx) : "";

    let parsedBase: URL;
    try {
      parsedBase = new URL(baseOnly);
    } catch (e) {
      return reject(
        new Error(`fetchVidLinkRaw: invalid base URL: ${baseOnly}`),
      );
    }

    const port = parsedBase.port ? parseInt(parsedBase.port) : 443;
    const rawPath = parsedBase.pathname + rawQuery;

    const reqOptions = {
      agent: httpsAgent,
      hostname: parsedBase.hostname,
      port,
      path: rawPath,
      method: "GET",
      headers: {
        accept: "*/*",
        "accept-language": "en-US,en;q=0.9",
        referer: "https://vidlink.pro/",
        origin: "https://vidlink.pro",
        "user-agent": UA,
        ...customHeaders,
      },
    };

    const req = https.request(reqOptions, (res) => {
      if (
        res.statusCode === 301 ||
        res.statusCode === 302 ||
        res.statusCode === 307 ||
        res.statusCode === 308
      ) {
        const location = res.headers.location;
        if (location) {
          const nextUrl = location.startsWith("http")
            ? location
            : new URL(location, rawUrl).href;
          return resolve(
            fetchVidLinkRaw(nextUrl, customHeaders, redirectCount + 1),
          );
        }
      }

      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
          finalUrl: rawUrl,
        }),
      );
    });

    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error("fetchVidLinkRaw: Request timed out after 30s"));
    });

    req.on("error", (err) => {
      console.error(
        `[FETCH/raw] ✘ Request error: ${err.message} | url=${baseOnly}...`,
      );
      reject(err);
    });

    // Add a strict 15s timeout to avoid hanging the Node.js event loop
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("Request timeout"));
    });

    req.end();
  });
}

const app = express();
app.set("trust proxy", 1);

// ── Security Middleware ──────────────────────────────────────────────────────

// 1. Helmet: Sets various security-related HTTP headers
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }, // Allow images/videos from other domains
    contentSecurityPolicy: false, // Disable CSP if it interferes with your specific iframe/stream needs, or configure it carefully
  }),
);

// 2. Optimized CORS: Restrict to your frontend only
const allowedOrigins = [
  "https://nebula.clev.studio",
  "http://localhost:5173",
  "http://localhost:3000",
  "http://127.0.0.1:5173",
  ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [])
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (
        !origin ||
        allowedOrigins.includes(origin) ||
        origin.includes("kisskh")
      ) {
        callback(null, true);
      } else {
        console.warn(`[CORS] Rejected origin: ${origin}`);
        callback(new Error(`Not allowed by CORS Security Policy: ${origin}`));
      }
    },
    methods: ["GET", "POST", "OPTIONS"],
    credentials: true,
  }),
);

// 3. Rate Limiting: Prevent Brute-force and Scraping of your own API
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5000, // Increased to 5000 for high-frequency feed updates
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Too many requests from this IP, please try again in 15 minutes.",
  },
  skip: (req) => {
    const origin = req.get("origin") || req.get("referer");
    const isNebula = origin && allowedOrigins.some((o) => origin.startsWith(o));
    return (
      isNebula ||
      req.path.startsWith("/health") ||
      req.path.startsWith("/api/health")
    );
  },
});

// Apply the rate limiter to all requests
app.use(limiter);

app.use(express.json());

// Initialize MongoDB
const MONGODB_URI =
  process.env.MONGODB_URI || "mongodb://localhost:27017/nebula-local";
const FANART_API_KEY = process.env.FANART_API_KEY || "";
const TMDB_API_KEY = process.env.TMDB_API_KEY || "";
const ADMIN_KEY = process.env.ADMIN_KEY;
if (!ADMIN_KEY) {
  console.warn(
    "[SECURITY] ⚠️ ADMIN_KEY not set in .env. Admin features disabled.",
  );
}

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

// Mongoose Connection Event Listeners
mongoose.connection.on("disconnected", () => {
  console.warn("[DB] ❗ Lost connection to MongoDB Atlas.");
});
mongoose.connection.on("reconnected", () => {
  console.log("[DB] ✅ Re-established connection to MongoDB Atlas.");
});
mongoose.connection.on("error", (err) => {
  console.error("[DB] ❌ Mongoose connection error:", err.message);
});

const connectDB = async (retryCount = 5) => {
  try {
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 10000,
      socketTimeoutMS: 45000, // Close sockets after 45s of inactivity (client-side)
      family: 4, // Force IPv4 to avoid slow dual-stack lookups on Oracle
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

  // Add no-cache headers to prevent mobile browsers from caching expired stream URLs
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");

  try {
    // 1. Cache Check
    const cachedRecord = await StreamCache.findOne({
      tmdbId,
      type: kind,
      season,
      episode,
    }).catch(() => null);

    if (cachedRecord) {
      if (
        !cachedRecord.streamExpiresAt ||
        new Date() < cachedRecord.streamExpiresAt
      ) {
        // If we have a streamUrl and it's likely alive (checked later for Cloudnestra, but for KissKH it's usually fine)
        // OR if we just want to return the mirrors.
        console.log(`[STREAM] Cache HIT ✔ for ${tmdbId} S${season}E${episode}`);

        // Handle subtile proxying for cached results
        const allSubtitles: any[] = [];
        if (cachedRecord.mirrors && cachedRecord.mirrors.length > 0) {
          const subMap = new Map();
          cachedRecord.mirrors.forEach((m: any) => {
            if (m.subtitles) {
              m.subtitles.forEach((s: any) => {
                const subUrl = s.url;
                if (subUrl && !subMap.has(subUrl)) subMap.set(subUrl, s);
              });
            }
          });
          allSubtitles.push(...subMap.values());
        }

        return res.json({
          streamUrl: cachedRecord.streamUrl,
          url: cachedRecord.streamUrl, // Compatibility
          source: cachedRecord.source || "cache",
          qualityTag: cachedRecord.qualityTag || "UNKNOWN",
          quality: cachedRecord.qualityTag, // Compatibility
          resolution: cachedRecord.resolution || "UNKNOWN",
          mirrors: cachedRecord.mirrors || [],
          subtitles: allSubtitles.map((s) => {
            if (
              s.url &&
              s.url.startsWith("http") &&
              !s.url.includes("/api/proxy/subtitle")
            ) {
              return {
                ...s,
                url: `/api/proxy/subtitle?url=${encodeURIComponent(s.url)}`,
              };
            }
            return s;
          }),
        });
      }
    }

    const mirrors: MirrorStream[] = [];
    let sourceName = "none";
    let qualityTag = "UNKNOWN";
    let resolution = "UNKNOWN";
    let streamUrl: string | null = null;
    let proxyUsed: string | undefined = undefined;

    const controller = new AbortController();
    const signal = controller.signal;

    req.on("close", () => {
      controller.abort();
      console.log(`[STREAM] User cancelled request. Aborting scrapers...`);
    });

    // ── Phase A: Handle Drama Section (Dramacool) ─────────────────────
    // ONLY fire for explicit drama IDs (k-prefixed slugs from Dramacool).
    // Normal TMDB TV IDs are numeric strings (e.g. "94605") and must go straight
    // to Phase B (VidLink) — the old condition fired Phase A on every TV request.
    if (tmdbId.startsWith("k")) {
      console.log(`[STREAM] Phase A: Drama ID detected (k-prefix). Checking Dramacool...`);
      try {
        const searchResults = await DramacoolScraper.search(title, undefined, signal);
        const match = searchResults[0]; // Take first result
        
        if (match) {
          const details = await DramacoolScraper.getDramaDetail(match.id, signal);
          const ep = details?.episodes?.find((e: any) => e.number === episode);
          if (ep) {
            const dramaMirrors = await DramacoolScraper.getStream(match.id, ep.url);
            if (dramaMirrors && dramaMirrors.length > 0) {
              console.log(`[STREAM] Dramacool HIT ✔`);
              mirrors.push(...dramaMirrors);
            }
          }
        }
      } catch (e: any) {
        if (e.name === 'AbortError') return;
        console.error(`[STREAM] Dramacool Phase A failed:`, e.message);
      }
    }

    // ── Phase B: Direct TMDB Path (VidLink) ──────────────────────────
    if (mirrors.length === 0) {
      console.log(`[STREAM] Phase B: Checking VidLink (Direct TMDB Path)...`);
      try {
        const vidlinkMirrors = await VidLinkScraper.getStream(
          tmdbId.toString(),
          kind as any,
          season,
          episode,
          signal
        );
        if (vidlinkMirrors && vidlinkMirrors.length > 0) {
          console.log(
            `[STREAM] VidLink HIT ✔ (Found ${vidlinkMirrors.length} mirrors)`,
          );
          const apiBase = req.headers.host
            ? (req.headers["x-forwarded-proto"] || "http") +
              "://" +
              req.headers.host
            : "";
          mirrors.push(...vidlinkMirrors);
        }
      } catch (e) {
        console.error(`[STREAM] VidLink failed:`, e);
      }
    }

    // ── Phase C: Fallback Scrapers (Dramacool Search) [CRIPPLED] ─────────
    /*
    if (mirrors.length === 0 && title) {
      console.log(
        `[STREAM] Phase C: Fallback to Dramacool Search for "${title}"...`,
      );
      try {
        const searchResults = await DramacoolScraper.search(title, undefined, signal);
        const match = searchResults.find(
          (r: any) =>
            r.title.toLowerCase().includes(title.toLowerCase()) ||
            title.toLowerCase().includes(r.title.toLowerCase()),
        );

        if (match) {
          const details = await DramacoolScraper.getDramaDetail(match.id, signal);
          const ep = details?.episodes?.find((e: any) => e.number === episode);
          if (ep) {
            const dramaMirrors = await DramacoolScraper.getStream(
              match.id,
              ep.url,
            );
            if (dramaMirrors && dramaMirrors.length > 0) {
              console.log(`[STREAM] Dramacool Fallback HIT ✔`);
              mirrors.push(...dramaMirrors);
            }
          }
        }
      } catch (e: any) {
        if (e.name === 'AbortError') return;
        console.error(`[STREAM] Dramacool Fallback failed:`, e.message);
      }
    }
    */

    if (mirrors.length === 0) {
      // Record in DeadPool
      try {
        await DeadPool.findOneAndUpdate(
          { tmdbId: tmdbId.toString(), type: kind, season, episode },
          { 
            lastChecked: new Date(), 
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) // 24h TTL
          },
          { upsert: true }
        );
      } catch (err) {
        console.error(`[DEADPOOL] Failed to log failure:`, err);
      }

      throw new Error(
        "No stream sources found. (Tried VidLink + Scrapers)",
      );
    }

    const allSubtitles: any[] = [];
    if (mirrors.length > 0) {
      streamUrl = mirrors[0]!.url;
      sourceName = mirrors[0]!.source;
      resolution = mirrors[0]!.quality || "1080p";
      qualityTag = resolution.includes("2160") ? "4K" : "HD";

      // Collect all subtitles from mirrors, deduplicating by URL
      const subMap = new Map();
      mirrors.forEach((m) => {
        if (m.subtitles) {
          m.subtitles.forEach((s: any) => {
            if (!subMap.has(s.url)) subMap.set(s.url, s);
          });
        }
      });

      // Merge with OpenSubtitles as fallback
      try {
        const osSubs = await getSubtitles(
          tmdbId,
          kind as any,
          season,
          episode,
          title,
        );
        if (osSubs && osSubs.length > 0) {
          osSubs.forEach((s: any) => {
            // Avoid duplicates if a mirror already had it
            if (!subMap.has(s.url)) subMap.set(s.url, s);
          });
        }
      } catch (e) {
        console.warn(`[STREAM] OpenSubtitles fetch failed:`, e);
      }

      allSubtitles.push(...subMap.values());

      // Sort to prioritize English and VidLink source
      allSubtitles.sort((a, b) => {
        const aIsVidLink = a.source === "VidLink";
        const bIsVidLink = b.source === "VidLink";
        const aIsEng =
          a.languageName?.toLowerCase().includes("english") ||
          a.lang?.toLowerCase().startsWith("en");
        const bIsEng =
          b.languageName?.toLowerCase().includes("english") ||
          b.lang?.toLowerCase().startsWith("en");

        // English + VidLink is highest priority
        if (aIsEng && aIsVidLink && !(bIsEng && bIsVidLink)) return -1;
        if (!(aIsEng && aIsVidLink) && bIsEng && bIsVidLink) return 1;

        // Then just English
        if (aIsEng && !bIsEng) return -1;
        if (!aIsEng && bIsEng) return 1;

        // Then VidLink (for other languages)
        if (aIsVidLink && !bIsVidLink) return -1;
        if (!aIsVidLink && bIsVidLink) return 1;

        return 0;
      });
    }

    if (mirrors.length === 0) {
      throw new Error("No stream sources found across all tiers.");
    }

    // 3. Optional: Cache the result with Intelligent Rotation
    if (streamUrl) {
      const releaseDateStr = req.query.releaseDate as string;
      const isCAM = qualityTag === "CAM" || qualityTag === "TC" || qualityTag === "UNKNOWN";
      
      let expiresAt = new Date();
      let isNewMovie = false;
      
      if (releaseDateStr) {
        try {
          const releaseDate = new Date(releaseDateStr);
          const oneMonthAgo = new Date();
          oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1);
          isNewMovie = releaseDate > oneMonthAgo;
        } catch {}
      }

      // ROTATION STRATEGY:
      // - New Movie (< 1mo) AND CAM/Low Quality: Cache for 6 hours
      // - High Quality (HD/BluRay) or Old Movie: Cache for 4 hours
      // Reduced from 30 days because CDN links are ephemeral and IP-locked.
      
      if (isNewMovie && isCAM) {
        console.log(`[CACHE] New CAM detected. Setting short TTL (6h) for rotation.`);
        expiresAt.setHours(expiresAt.getHours() + 6);
      } else {
        // High quality or old movie — cache for 4 hours
        console.log(`[CACHE] Standard movie. Setting 4h TTL.`);
        expiresAt.setHours(expiresAt.getHours() + 4);
      }

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
      ).then(() => {
        // If we found a stream, it's no longer "Dead"
        DeadPool.deleteOne({ tmdbId: tmdbId.toString(), type: kind, season, episode }).catch(() => {});
      }).catch((err) => console.error("[CACHE] Failed to save mirrors:", err));
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
        // Inject subtitle proxy for all external subs
        if (m.subtitles) {
          m.subtitles = m.subtitles.map((s) => {
            if (s.url.startsWith("http")) {
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
          if (s.url.startsWith("http")) {
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

  // Handle Drama IDs (slugs or legacy KissKH IDs)
  if (tmdbId.startsWith("k") || (isNaN(parseInt(tmdbId)) && !tmdbId.startsWith("tt"))) {
    const dramaId = tmdbId.startsWith("k") ? tmdbId.replace("k", "") : tmdbId;
    console.log(`[DRAMA] Fetching Dramacool details for: ${dramaId}`);
    try {
      const details = await DramacoolScraper.getDramaDetail(dramaId);
      if (!details) return res.status(404).json({ error: "Drama not found" });

      // Normalize to TMDB-like structure for the frontend drawer
      return res.json({
        id: tmdbId,
        name: details.title,
        number_of_seasons: 1,
        seasons: [
          {
            season_number: 1,
            episode_count: details.episodes?.length || 0,
            name: "Season 1",
          },
        ],
        episodes: (details.episodes || []).map((ep: any) => ({
          episode_number: ep.number,
          name: ep.title || `Episode ${ep.number}`,
          id: ep.id, // Full URL
        })),
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
  const title = req.query.title as string;

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

    const results = await Promise.allSettled([
      tmdbId.toString().startsWith("k") || (isNaN(parseInt(tmdbId)) && !tmdbId.startsWith("tt"))
        ? (async () => {
            const dramaId = tmdbId.toString().startsWith("k") ? tmdbId.toString().replace("k", "") : tmdbId.toString();
            const details = await DramacoolScraper.getDramaDetail(dramaId);
            const ep = details?.episodes?.find(
              (e: any) => e.number === episode,
            );
            if (ep) {
              const mirrors = await DramacoolScraper.getStream(dramaId, ep.url);
              // Extract unique subtitles from all mirrors
              const subMap = new Map();
              mirrors.forEach((m) => {
                if (m.subtitles) {
                  m.subtitles.forEach((s) => {
                    if (s.url && !subMap.has(s.url)) subMap.set(s.url, s);
                  });
                }
              });
              return Array.from(subMap.values());
            }
            return [];
          })()
        : Promise.resolve([]),
      getSubtitles(tmdbId, kind, season, episode, title),
    ]);

    const aggregated = results
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => (r as PromiseFulfilledResult<any[]>).value);

    // 2. Sort to prioritize English and VidLink source
    const sorted = aggregated.sort((a, b) => {
      const aIsVidLink = a.source === "VidLink";
      const bIsVidLink = b.source === "VidLink";
      const aIsEng =
        a.languageName?.toLowerCase().includes("english") ||
        a.lang?.toLowerCase().startsWith("en") ||
        a.language?.toLowerCase().startsWith("en");
      const bIsEng =
        b.languageName?.toLowerCase().includes("english") ||
        b.lang?.toLowerCase().startsWith("en") ||
        b.language?.toLowerCase().startsWith("en");

      // English + VidLink is highest priority
      if (aIsEng && aIsVidLink && !(bIsEng && bIsVidLink)) return -1;
      if (!(aIsEng && aIsVidLink) && bIsEng && bIsVidLink) return 1;

      // Then just English
      if (aIsEng && !bIsEng) return -1;
      if (!aIsEng && bIsEng) return 1;

      // Then VidLink (for other languages)
      if (aIsVidLink && !bIsVidLink) return -1;
      if (!aIsVidLink && bIsVidLink) return 1;

      return 0;
    });

    // 3. Save to permanent cache
    if (sorted.length > 0) {
      await SubtitleCache.findOneAndUpdate(
        { tmdbId, type: kind, season, episode },
        { subtitles: sorted, aggregatedAt: new Date() },
        { upsert: true },
      ).catch(() => null);
    }

    const proxied = sorted.map((s) => {
      if (s.url && s.url.startsWith("http")) {
        return {
          ...s,
          url: `/api/proxy/subtitle?url=${encodeURIComponent(s.url)}`,
        };
      }
      return s;
    });

    return res.json({ subtitles: proxied });
  } catch (err: any) {
    console.error(`[SUBS ERROR] ${err.message}`);
    return res.status(500).json({ error: err.message, subtitles: [] });
  }
});

// Endpoint: Subtitle Proxy (Bypasses CORS, decrypts KissKH, fixes encoding)
// All subtitle sources flow through here: KissKH (dramas), VidLink (movies/TV), OpenSubtitles (fallback)
app.get("/api/proxy/subtitle", async (req, res) => {
  const url = req.query.url as string;
  if (!url) return res.status(400).send("Missing url");

  // SSRF guard: only allow fetching from known subtitle CDNs
  try {
    const parsed = new URL(url);
    const SUBTITLE_ALLOWLIST = [
      "kisskh.do", "kisskh.co", "kisskh.me",
      "vidlink.pro", "megafiles.store", "storm.vodvidl.site",
      "opensubtitles.org", "opensubtitles.com", "sub.webseries.vip",
      "s.megafiles.store", "strem.io", "stremio.com",
    ];
    const allowed = SUBTITLE_ALLOWLIST.some(
      (domain) => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`)
    );
    if (!allowed) {
      console.warn(`[SUBS] Blocked SSRF attempt: ${parsed.hostname}`);
      return res.status(403).send("Domain not allowed");
    }
  } catch {
    return res.status(400).send("Invalid url");
  }

  try {
    let rawBuffer: Buffer;
    let finalUrl = url;

    // Use GotScraping bypass for KissKH (High-Speed)
    if (isKissKHSubtitleUrl(url)) {
      try {
        const bypass = await fetchWithGotScraping(url, {
          Referer: "https://kisskh.do",
          Origin: "https://kisskh.do",
        });

        if (bypass.statusCode >= 400) {
          console.warn(
            `[SUBS] GotScraping failed (${bypass.statusCode}). Trying CycleTLS...`,
          );
          const cycle = await fetchWithCycleTLS(url, {
            Referer: "https://kisskh.do/",
            Origin: "https://kisskh.do",
          });

          if (cycle.statusCode >= 400) {
            console.error(`[SUBS] All bypasses failed for ${url}`);
            return res
              .status(cycle.statusCode)
              .send(`Bypass failed: ${cycle.statusCode}`);
          }
          rawBuffer = cycle.body;
          finalUrl = cycle.finalUrl;
        } else {
          rawBuffer = bypass.body;
          finalUrl = bypass.finalUrl;
        }
      } catch (err: any) {
        console.error(`[SUBS] Proxy error: ${err.message}`);
        return res.status(500).send("Proxy error");
      }
    } else {
      // Standard fetch with bypass for other sources (VidLink, Megafiles, OpenSubtitles)
      const headers: any = {
        "User-Agent": UA,
        Referer: url.includes("vidlink") || url.includes("megafiles") || url.includes("storm.vodvidl.site")
          ? "https://vidlink.pro/"
          : (process.env.FRONTEND_URL || "https://nebula.clev.studio/"),
      };

      if (url.includes("vidlink") || url.includes("megafiles") || url.includes("storm.vodvidl.site")) {
        headers.Origin = "https://vidlink.pro";
      }

      let bypass: any;
      if (url.includes("storm.vodvidl.site")) {
        // Storm uses literal { } in query params which WHATWG URL (used by Got) encodes.
        // We use fetchVidLinkRaw to preserve the literal characters and avoid 403.
        const res = await fetchVidLinkRaw(url, headers);
        bypass = { statusCode: res.statusCode, headers: res.headers, body: res.body, finalUrl: res.finalUrl };
      } else {
        bypass = await fetchWithGotScraping(url, headers);
      }
      
      // If GotScraping fails, try the heavy-duty CycleTLS spoofer for Cloudflare protected domains
      if (bypass.statusCode >= 400 && (url.includes("vidlink") || url.includes("megafiles"))) {
        console.warn(`[SUBS] GotScraping failed (${bypass.statusCode}). Trying CycleTLS JA3 Spoofer...`);
        try {
          const cycle = await fetchWithCycleTLS(url, headers);
          if (cycle.statusCode < 400) {
            bypass = cycle;
          }
        } catch (cycleErr: any) {
          console.error(`[SUBS] CycleTLS failed: ${cycleErr.message}`);
        }
      }

      if (bypass.statusCode >= 400) {
        console.warn(`[SUBS] All bypasses failed for ${url} (${bypass.statusCode}). Falling back to Axios...`);
        const response = await axios.get(url, {
          timeout: 45000,
          headers,
          responseType: "arraybuffer",
        });
        rawBuffer = Buffer.from(response.data);
      } else {
        rawBuffer = bypass.body;
        finalUrl = bypass.finalUrl;
      }
    }

    let content: string;

    // ── Step 1: Decode to UTF-8 string ──────────────────────────────────
    // OpenSubtitles often serves ISO-8859-1 or Windows-1252
    const detected = jschardet.detect(rawBuffer);
    if (
      detected.encoding &&
      detected.confidence > 0.5 &&
      !detected.encoding.toLowerCase().includes("utf") &&
      !detected.encoding.toLowerCase().includes("ascii")
    ) {
      console.log(
        `[SUBS/proxy] Detected encoding: ${detected.encoding} (${(detected.confidence * 100).toFixed(0)}%) — converting to UTF-8`,
      );
      content = iconv.decode(rawBuffer, detected.encoding);
    } else {
      content = rawBuffer.toString("utf-8");
    }

    // ── Step 2: Strip BOM & normalize line endings ─────────────────────
    content = content.replace(/^\uFEFF/, ""); // BOM
    content = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n"); // Normalize

    // ── Step 3: KissKH Decryption (dramas only) ────────────────────────
    if (isKissKHSubtitleUrl(finalUrl)) {
      console.log(`[SUBS/proxy] KissKH subtitle detected — decrypting...`);
      try {
        content = decryptKissKHSubtitle(content, finalUrl);
      } catch (decErr: any) {
        console.error(
          `[SUBS/proxy] KissKH decryption failed: ${decErr.message}`,
        );
        // Fall through with raw content — better than nothing
      }
    }

    // ── Step 4: SRT → VTT conversion ───────────────────────────────────
    const trimmed = content.trim();
    if (!trimmed.startsWith("WEBVTT")) {
      // Replace SRT comma timestamps with VTT dot timestamps
      content = content.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
      // Remove SRT cue index numbers (standalone digit lines before timestamps)
      content = content.replace(/^\d+\n(?=\d{2}:\d{2}:\d{2})/gm, "");
      content = "WEBVTT\n\n" + content.trim() + "\n";
    }

    // ── Step 5: Clean up common formatting artifacts ───────────────────
    // Strip ASS/SSA style tags that sometimes leak through
    content = content.replace(/\{\\an\d+\}/g, "");
    // Strip HTML bold/italic if overly nested (but keep simple <i> and <b>)
    content = content.replace(/<font[^>]*>/gi, "").replace(/<\/font>/gi, "");
    // Remove empty cues (timestamp line followed by blank)
    content = content.replace(
      /(\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3})\n\n/g,
      "",
    );

    // ── Respond ────────────────────────────────────────────────────────
    res.setHeader("Content-Type", "text/vtt; charset=utf-8");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=86400");

    return res.send(content);
  } catch (e: any) {
    console.error(`[SUBS/proxy] Failed for ${url}: ${e.message}`);
    return res.status(500).send("Subtitle proxy failed");
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

// Random residential IP generator for spoofing
const randomIP = () => {
  const p = () => Math.floor(Math.random() * 255);
  let first = p();
  while ([0, 10, 127, 169, 172, 192].includes(first)) first = p();
  return `${first}.${p()}.${p()}.${p()}`;
};

function cdnHeaders(targetUrl?: string, isManifest: boolean = false) {
  let referer = CDN_REFERER;
  let origin = new URL(CDN_REFERER).origin;
  let cookie: string | null = null;

  // Default browser headers for fetch/CORS
  const headers: any = {
    accept: "*/*",
    "accept-language": "en-US,en;q=0.7",
    "cache-control": "no-cache",
    pragma: "no-cache",
    priority: "u=1, i",
    "sec-ch-ua":
      '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": isManifest ? "empty" : "video",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "cross-site",
    "user-agent": UA,
    "x-forwarded-for": randomIP(),
    "x-real-ip": randomIP(),
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
        if (referer === CDN_REFERER)
          referer = hostParam.endsWith("/") ? hostParam : hostParam + "/";
        if (origin === "https://cloudnestra.com")
          origin = new URL(hostParam).origin;
      }
    } catch {}

    // Final overrides for specific providers that are extremely sensitive to outer Referer
    if (
      lower.includes("storm.vodvidl.site") ||
      lower.includes("vidlink.pro") ||
      lower.includes("nightbreeze") ||
      lower.includes("thunderleaf")
    ) {
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
        streamProxy = decodeURIComponent(bakedMatch[1]!);
        // Remove the param from the URL while preserving everything else exactly
        targetUrl = targetUrl
          .replace(/[\?&]nebula_proxy=[^&]+/, "")
          .replace(/\?$/, "")
          .replace(/\?&/, "?");
      } catch {}
    }
  }

  const cacheKey = targetUrl;
  const cached = proxyCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    console.log(
      `[PROXY/stream] ⚡ Cache Hit: ${targetUrl.substring(0, 60)}...`,
    );
    res.setHeader(
      "Content-Type",
      cached.headers["content-type"] || "application/vnd.apple.mpegurl",
    );
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.send(cached.body);
  }

  const startTime = Date.now();
  console.log(
    `[PROXY/stream] ▶ ${targetUrl.substring(0, 80)} | proxy=${streamProxy ? "YES" : "NONE"}`,
  );

  const passHeaders: any = {};
  if (req.headers.range) passHeaders.range = req.headers.range;

  try {
    const isVidLink =
      targetUrl.includes("storm.vodvidl.site") ||
      targetUrl.includes("vidlink.pro");
    let upstream: any;
    if (isVidLink) {
      upstream = await fetchVidLinkRaw(targetUrl, passHeaders);
    } else {
      const streamHeaders = { ...cdnHeaders(targetUrl, true), ...passHeaders };
      // Try GotScraping first (High-Speed & Reliable)
      upstream = await fetchWithGotScraping(
        targetUrl,
        streamHeaders,
        streamProxy,
      );

      if (upstream.statusCode >= 400 && upstream.statusCode !== 404) {
        console.warn(
          `[PROXY/stream] GotScraping failed (${upstream.statusCode}). Trying CycleTLS fallback...`,
        );
        upstream = await fetchWithCycleTLS(
          targetUrl,
          streamHeaders,
          streamProxy,
        );
      }
    }
    const status = upstream.statusCode;
    const duration = Date.now() - startTime;
    if (status >= 400) {
      console.error(
        `[PROXY/stream] ✘ ${status} (${duration}ms) | url=${targetUrl.substring(0, 60)}...`,
      );
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.status(status).send(upstream.body);
    }

    const manifest = upstream.body.toString("utf-8");

    if (typeof manifest !== "string") {
      return res.status(502).send("Invalid manifest content");
    }

    // Use the actual final URL after redirects for resolving relative paths
    const actualTargetUrl = upstream.finalUrl;
    const urlObj = new URL(actualTargetUrl);
    const origin = urlObj.origin;
    const baseDir = actualTargetUrl.substring(
      0,
      actualTargetUrl.lastIndexOf("/") + 1,
    );

    // Optimized URL resolution (much faster than new URL() in a loop)
    const fastResolve = (uri: string) => {
      if (uri.startsWith("http")) return uri;
      if (uri.startsWith("//")) return `https:${uri}`;
      if (uri.startsWith("/")) return origin + uri;
      return baseDir + uri;
    };

    const withProxy = (endpoint: string, encodedUrl: string) => {
      const protocol = req.headers["x-forwarded-proto"] || req.protocol;
      const currentHost =
        process.env.API_URL || `${protocol}://${req.get("host")}`;
      const proxyParam = streamProxy
        ? `&nebula_proxy=${encodeURIComponent(streamProxy!)}`
        : "";
      return `${currentHost}${endpoint}?url=${encodedUrl}${proxyParam}`;
    };

    console.log(
      `[PROXY] Rewriting manifest: ${actualTargetUrl.substring(0, 60)}...`,
    );

    let rewrittenCount = 0;

    // 1. Rewrite URI= attributes in tags
    let proxified = manifest.replace(
      /URI=(?:"([^"]+)"|([^",\s][^,\s]*))/g,
      (match, quoted, unquoted) => {
        const uri = (quoted || unquoted).trim();
        if (!uri) return match;

        const abs = fastResolve(uri);
        const ext = abs.split("?")[0]?.split(".").pop()?.toLowerCase();
        const proxyPath =
          ext === "m3u8" ? "/api/proxy/stream" : "/api/proxy/segment";

        rewrittenCount++;
        const proxiedUrl = withProxy(proxyPath, encodeURIComponent(abs));
        return quoted ? `URI="${proxiedUrl}"` : `URI=${proxiedUrl}`;
      },
    );

    // 2. Rewrite segment/playlist lines (lines not starting with #)
    proxified = proxified.replace(/^(?!#)(.+)$/gm, (match, uri) => {
      const trimmed = uri.trim();
      if (!trimmed) return match;

      const abs = fastResolve(trimmed);
      const ext = abs.split("?")[0]?.split(".").pop()?.toLowerCase();
      const proxyPath =
        ext === "m3u8" ? "/api/proxy/stream" : "/api/proxy/segment";

      rewrittenCount++;
      return withProxy(proxyPath, encodeURIComponent(abs));
    });

    console.log(`[PROXY] Rewrote ${rewrittenCount} URLs in manifest.`);

    // Speculative Pre-fetching REMOVED: It was causing cache poisoning with raw manifests.
    // Quality switching will now always trigger a fresh, correctly rewritten manifest.
    if (rewrittenCount === 0 && manifest.length > 50) {
      console.warn(
        `[PROXY] WARNING: Zero URLs rewrote in a manifest of length ${manifest.length}! Content preview: ${manifest.substring(0, 100)}`,
      );
    } else {
      console.log(
        `[PROXY] Manifest preview (rewritten): ${proxified.substring(0, 300).replace(/\n/g, " ")}...`,
      );
    }

    // Cache successful rewritten manifest
    setProxyCache(cacheKey, {
      body: Buffer.from(proxified, "utf-8"),
      headers: upstream.headers,
      expires: Date.now() + CACHE_TTL,
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

// Proxy: raw segment / AES key — STREAMING pass-through (zero buffering)
//
// KEY DESIGN: Bytes are piped to the client the instant they arrive from the CDN.
// Buffering the entire segment in RAM (old approach) caused:
//   1. 5-6s freeze: player saw no bytes until the full 2-10MB was buffered
//   2. A/V desync: player clock advanced during the stall, video resumed late
//   3. Subtitle drift: VTT timestamps fell out of sync for the rest of the file
//
// VidLink/Storm CDN: uses native https.request so literal { } in query params
//   are not encoded (WHATWG URL API breaks these CDNs with %7B/%7D encoding).
// Other CDNs: uses axios stream mode which pipes without buffering.
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

  const startTime = Date.now();
  const passHeaders: any = {};
  if (req.headers.range) passHeaders.range = req.headers.range;

  const isVidLink =
    targetUrl.includes("storm.vodvidl.site") ||
    targetUrl.includes("vidlink.pro");

  // ── Path A: VidLink/Storm CDN — native https.request streaming pipe ──────
  // Must use raw Node https to preserve literal { } braces in query params.
  if (isVidLink) {
    const qIdx = targetUrl.indexOf("?");
    const baseOnly = qIdx >= 0 ? targetUrl.substring(0, qIdx) : targetUrl;
    const rawQuery = qIdx >= 0 ? targetUrl.substring(qIdx) : "";

    let parsedBase: URL;
    try {
      parsedBase = new URL(baseOnly);
    } catch {
      return res.status(400).send("Invalid URL");
    }

    const reqOptions = {
      agent: httpsAgent,
      hostname: parsedBase.hostname,
      port: parsedBase.port ? parseInt(parsedBase.port) : 443,
      path: parsedBase.pathname + rawQuery,
      method: "GET",
      headers: {
        accept: "*/*",
        "accept-language": "en-US,en;q=0.9",
        referer: "https://vidlink.pro/",
        origin: "https://vidlink.pro",
        "user-agent": UA,
        ...passHeaders,
      },
    };

    const startRequest = (retryCount = 0) => {
      let headersSent = false;
      const chunks: Buffer[] = [];

      const upstream = https.request(reqOptions, (upstreamRes) => {
        const status = upstreamRes.statusCode ?? 502;

        if (status >= 400) {
          if (retryCount < 3 && [502, 503, 504, 520, 521].includes(status)) {
            console.warn(`[PROXY/segment] Retrying VidLink ${status} (attempt ${retryCount + 1})...`);
            return startRequest(retryCount + 1);
          }
          console.error(`[PROXY/segment] ✘ VidLink ${status} | url=${baseOnly.substring(0, 60)}...`);
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.status(status).end();
          return;
        }

        upstreamRes.on("data", (chunk) => {
          if (!headersSent && !res.headersSent) {
            headersSent = true;
            res.status(status);
            res.setHeader("Content-Type", upstreamRes.headers["content-type"] || "video/mp2t");
            if (upstreamRes.headers["content-length"]) {
              res.setHeader("Content-Length", upstreamRes.headers["content-length"]);
            }
            if (upstreamRes.headers["content-range"]) {
              res.setHeader("Content-Range", upstreamRes.headers["content-range"]);
            }
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("X-Proxy-Mode", "Streaming");
          }
          res.write(chunk);
        });

        upstreamRes.on("end", () => {
          if (!res.writableEnded) res.end();
        });

        upstreamRes.on("error", (err) => {
          if (retryCount < 3 && !res.headersSent) {
            console.warn(`[PROXY/segment] Upstream error during download: ${err.message}. Retrying...`);
            return startRequest(retryCount + 1);
          }
          if (!res.writableEnded) res.end();
        });
      });

      upstream.on("error", (err) => {
        if (retryCount < 3 && (err.message.includes("socket hang up") || (err as any).code === "ECONNRESET" || err.message.includes("aborted"))) {
          console.warn(`[PROXY/segment] Retrying VidLink error: ${err.message} (attempt ${retryCount + 1})...`);
          return startRequest(retryCount + 1);
        }
        console.error(`[PROXY/segment] VidLink request error: ${err.message}`);
        if (!res.headersSent) {
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.status(502).send("Proxy error");
        }
      });

      upstream.setTimeout(30000, () => {
        upstream.destroy();
        if (retryCount < 3) {
          console.warn(`[PROXY/segment] Retrying VidLink timeout (attempt ${retryCount + 1})...`);
          return startRequest(retryCount + 1);
        }
        if (!res.headersSent) {
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.status(504).send("Upstream timeout");
        }
      });

      req.on("close", () => {
        if (!upstream.destroyed) upstream.destroy();
      });

      upstream.end();
    };

    startRequest();
    return;
  }

  // ── Path B: All other CDNs — axios stream pipe with proxy fallback ────────
  const streamSegment = async (useProxy: boolean, retryCount = 0): Promise<void> => {
    const headers = { ...cdnHeaders(targetUrl, false), ...passHeaders };
    const proxyUrl = useProxy && segProxy
      ? (segProxy.startsWith("http") ? segProxy : `http://${segProxy}`)
      : undefined;

    try {
      const axiosResponse = await axios.get(targetUrl, {
        headers,
        responseType: "stream",
        timeout: 20000,
        proxy: false, // disable axios auto-proxy; we set it via httpsAgent if needed
        httpsAgent: proxyUrl
          ? new (await import("https-proxy-agent")).HttpsProxyAgent(proxyUrl)
          : createHardenedAgent(),
        maxRedirects: 5,
      });

      const status = axiosResponse.status;

      // On first attempt 403 + proxy available → retry through proxy
      if (status === 403 && !useProxy && segProxy) {
        (axiosResponse.data as any).destroy();
        return streamSegment(true);
      }

      if (status >= 400) {
        console.error(
          `[PROXY/segment] ✘ ${status} | proxy=${useProxy ? "YES" : "NO"} | url=${targetUrl.substring(0, 60)}...`,
        );
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.status(status).end();
        return;
      }

      // Forward headers then pipe — no buffering
      res.status(status);
      res.setHeader(
        "Content-Type",
        axiosResponse.headers["content-type"] || "video/mp2t",
      );
      res.setHeader("Access-Control-Allow-Origin", "*");
      if (axiosResponse.headers["content-length"]) {
        res.setHeader("Content-Length", axiosResponse.headers["content-length"]);
      }
      if (axiosResponse.headers["content-range"]) {
        res.setHeader("Content-Range", axiosResponse.headers["content-range"]);
      }

      // STREAM: pipe bytes directly to client as they arrive
      const dataStream = axiosResponse.data as import("stream").Readable;
      dataStream.pipe(res);

      dataStream.on("error", (err: Error) => {
        console.error(`[PROXY/segment] Stream error: ${err.message}`);
        if (!res.writableEnded) res.end();
      });

      // Kill upstream if player disconnects (seek/quality switch)
      req.on("close", () => {
        dataStream.destroy();
      });
    } catch (e: any) {
      const status = e?.response?.status || e?.response?.statusCode || 0;
      
      // Retry logic for network errors (socket hang up, timeout, etc) and specific 5xx errors
      const isRetryableError = e.code === "ECONNRESET" || 
                              e.code === "ETIMEDOUT" || 
                              e.code === "ESOCKETTIMEDOUT" || 
                              e.message?.includes("socket hang up") ||
                              e.message?.includes("aborted");
      
      const isRetryableStatus = [502, 503, 504, 520, 521].includes(status);

      if (retryCount < 3 && (isRetryableError || isRetryableStatus)) {
        console.warn(`[PROXY/segment] Retrying Path B error: ${e.message} (status: ${status}, attempt ${retryCount + 1})...`);
        return streamSegment(useProxy, retryCount + 1);
      }

      // 403 retry logic for non-axios errors
      if (!useProxy && segProxy && (status === 403 || e.code === "ERR_BAD_REQUEST")) {
        return streamSegment(true);
      }
      console.error(
        `[PROXY/segment] ✘ ${status || "no-status"} | proxy=${useProxy ? "YES" : "NO"} | error=${e.code} | message=${e.message} | url=${targetUrl.substring(0, 60)}...`,
      );
      if (!res.headersSent) {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.status(502).send("Proxy segment error");
      }
    }
  };

  await streamSegment(false);
});


app.all("/api/cache/clear", async (req, res) => {
  const key = req.headers["x-admin-key"] || req.query.key;
  if (key !== ADMIN_KEY)
    return res
      .status(401)
      .json({ error: "Unauthorized access — specify ?key= in URL" });

  try {
    proxyCache.clear();
    await Promise.all([
      MetadataCache.deleteMany({}),
      DiscoveryCache.deleteMany({}),
      DramaDetailCache.deleteMany({}),
      SubtitleCache.deleteMany({}),
      StreamCache.deleteMany({}),
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

app.get("/api/stream/availability", async (req, res) => {
  const ids = req.query.ids as string;
  if (!ids) return res.json({ results: [] });

  const tmdbIds = ids.split(",").filter((id) => id.trim());
  try {
    const [cachedStreams, deadPool] = await Promise.all([
      StreamCache.find({ tmdbId: { $in: tmdbIds } }),
      DeadPool.find({ tmdbId: { $in: tmdbIds } })
    ]);

    const cachedIds = new Set(cachedStreams.map(s => s.tmdbId));
    const deadIds = new Set(deadPool.map(d => d.tmdbId));
    
    const results = tmdbIds.map(id => ({
      id,
      isVerified: cachedIds.has(id),
      isDead: deadIds.has(id)
    }));
    
    res.json({ results });
  } catch (error) {
    res.status(500).json({ error: "Failed to check availability" });
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

// Endpoint: Drama Discovery (Synced with Dramacool)
app.get("/api/drama/list", async (req, res) => {
  const page = parseInt(req.query.page as string) || 1;
  const countryId = req.query.country as string;
  
  // Map frontend country IDs to Dramacool slugs
  const countryMap: Record<string, string> = {
    "1": "korean",
    "2": "chinese",
    "4": "japanese-a",
    "7": "thailand",
    "8": "philippines",
    "5": "taiwanese",
    "6": "hong-kong",
    "3": "other-asia"
  };

  const countrySlug = countryId ? countryMap[countryId] : undefined;
  const cacheKey = `drama-list-${page}-${countryId || "all"}`;

  try {
    const cached = await DiscoveryCache.findOne({ key: cacheKey });
    if (cached) {
      console.log(`[DRAMA] Cache HIT for list ${cacheKey}`);
      return res.json({ results: cached.results });
    }

    console.log(`[DRAMA] Cache MISS for list ${cacheKey}. Fetching Dramacool...`);
    const results = await DramacoolScraper.getExploreList(page, countrySlug);
    
    await DiscoveryCache.findOneAndUpdate(
      { key: cacheKey },
      {
        results,
        expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 6), // 6 hours
      },
      { upsert: true },
    ).catch(() => null);

    return res.json({ results });
  } catch (err: any) {
    console.error(`[DRAMA LIST ERROR] ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

app.get("/api/drama/detail/:id", async (req, res) => {
  const { id } = req.params;
  const dramaId = id.startsWith("k") ? id.replace("k", "") : id;

  try {
    const cached = await DramaDetailCache.findOne({ dramaId });
    if (cached) {
      console.log(`[DRAMA] Cache HIT for detail ${id}`);
      return res.json(cached.detail);
    }

    console.log(`[DRAMA] Cache MISS for detail ${id}. Fetching...`);
    const details = await DramacoolScraper.getDramaDetail(dramaId);
    if (!details) return res.status(404).json({ error: "Drama not found" });

    // Normalize episodes
    const normalized = {
      ...details,
      episodes: (details.episodes || [])
        .map((ep: any) => ({
          episode_number: ep.number,
          name: ep.title || `Episode ${ep.number}`,
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
// Allowlist of domains the image proxy may fetch from.
// Prevents SSRF: attackers cannot use this to reach internal network endpoints.
const IMAGE_PROXY_ALLOWLIST = [
  "image.tmdb.org",
  "media.themoviedb.org",
  "assets.fanart.tv",
  "webservice.fanart.tv",
  "assets.kisskh.co",
  "kisskh.do",
  "dramacooll.fun",
];

app.get("/api/image", async (req, res) => {
  const url = req.query.url as string;
  if (!url) return res.status(400).send("Missing url");

  // SSRF guard: only allow fetching from known media CDNs
  try {
    const parsed = new URL(url);
    const allowed = IMAGE_PROXY_ALLOWLIST.some(
      (domain) => parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`)
    );
    if (!allowed) {
      console.warn(`[IMAGE] Blocked SSRF attempt: ${parsed.hostname}`);
      return res.status(403).send("Domain not allowed");
    }
  } catch {
    return res.status(400).send("Invalid url");
  }

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
const server = app.listen(PORT, () => {
  console.log(`Nebula Backend Array active on http://localhost:${PORT}`);
  console.log(
    `Modes: Fanart [${FANART_API_KEY === "your_fanart_api_key_here" ? "DISABLED" : "ACTIVE"}], Scraper [ACTIVE]`,
  );
});

// ── Graceful Shutdown ────────────────────────────────────────────────────────
// systemd / pm2 sends SIGTERM before stopping the process on Oracle Ubuntu.
// We stop accepting new connections but let in-flight HLS pipes drain.
process.on('SIGTERM', () => {
  console.log('[SHUTDOWN] SIGTERM received — draining connections...');
  server.close(() => {
    console.log('[SHUTDOWN] All connections closed. Exiting.');
    process.exit(0);
  });
  // Force-exit after 10s if connections don't drain
  setTimeout(() => {
    console.error('[SHUTDOWN] Force exit after 10s drain timeout.');
    process.exit(1);
  }, 10_000);
});
