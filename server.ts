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
  TmdbCache,
} from "./models/Cache.js";
import {
  fetchWithCycleTLS,
  fetchWithGotScraping,
  shutdownCycleTLS,
} from "./utils/bypass.js";

import { getSubtitles } from "./utils/subtitles.js";
import {
  fetchVidVaultDownloads,
  formatBytes,
  parseSizeToBytes,
  parseAndFormatSize,
  getMediaTitleAndYear,
  VIDVAULT_BASE,
  VIDVAULT_UA,
  fetchVidVaultToken,
  type VidVaultCaption,
  type VidVaultDownload,
} from "./utils/vidvault.js";
import { createSubtitleRouter } from "./routes/subtitles.js";
import { cdnHeaders } from "./utils/cdn.js";

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
process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err);
  // Don't exit — Railway will restart if needed; keep serving other users.
});
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled promise rejection:", reason);
});

// Simple memory cache for proxy requests to speed up playback and avoid repeat bypasses
const proxyCache = new Map<
  string,
  { body: Buffer; headers: any; expires: number }
>();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes
// 500 entries supports ~125 concurrent viewers (1 master + ~4 variant manifests each).
const MAX_CACHE_ENTRIES = 500;

/**
 * LRU-aware setter: re-inserts the key at the end of the Map so that
 * Map's insertion-order iteration gives us LRU eviction for free.
 */
function setProxyCache(
  key: string,
  value: { body: Buffer; headers: any; expires: number },
) {
  // Remove before re-inserting to move to the end (LRU semantics)
  proxyCache.delete(key);
  if (proxyCache.size >= MAX_CACHE_ENTRIES) {
    // Evict the least-recently-used (first in insertion order)
    const lruKey = proxyCache.keys().next().value;
    if (lruKey) proxyCache.delete(lruKey);
  }
  proxyCache.set(key, value);
}

/**
 * LRU-aware getter: moves the hit entry to the end so it survives
 * the next eviction cycle. Returns null on miss or expiry.
 */
function getProxyCache(key: string) {
  const entry = proxyCache.get(key);
  if (!entry) return null;
  if (entry.expires < Date.now()) {
    proxyCache.delete(key);
    return null;
  }
  // LRU touch: re-insert at end
  proxyCache.delete(key);
  proxyCache.set(key, entry);
  return entry;
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

// Shared TLS-hardened agent for non-VidLink CDN segment requests.
// Created once at startup so every segment request reuses the same
// socket pool instead of allocating a new TLS context per request.
let _sharedHardenedAgent: ReturnType<typeof createHardenedAgent> | null = null;
function getSharedHardenedAgent() {
  if (!_sharedHardenedAgent) _sharedHardenedAgent = createHardenedAgent();
  return _sharedHardenedAgent;
}

// Cache proxy agents to prevent memory and socket leaks from allocating new agents per segment request
const proxyAgentsMap = new Map<string, any>();
async function getProxyAgent(proxyUrl: string) {
  let agent = proxyAgentsMap.get(proxyUrl);
  if (!agent) {
    const HttpsProxyAgentClass = (await import("https-proxy-agent"))
      .HttpsProxyAgent;
    agent = new HttpsProxyAgentClass(proxyUrl, {
      keepAlive: true,
      maxSockets: 64,
      timeout: 30000,
    });
    proxyAgentsMap.set(proxyUrl, agent);
  }
  return agent;
}

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

    // Note: Only one setTimeout is registered (30s). A second 15s call
    // was previously overriding this one silently — removed.

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
  "https://nebulawatch.tech",
  "https://www.nebulawatch.tech",
  "https://nebula.clev.studio",
  "http://localhost:5173",
  "http://localhost:3000",
  "http://127.0.0.1:5173",
  ...(process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(",")
    : []),
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

// express.json() is applied per-route (only POST/mutation routes need body parsing).
// Applying it globally wastes CPU on every GET proxy/segment request that never has a body.

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
      serverSelectionTimeoutMS: 15000, // Avoid false drops on event loop lag or network spikes
      heartbeatFrequencyMS: 30000, // Reduce monitoring ping frequency to save CPU and connections
      connectTimeoutMS: 15000,
      socketTimeoutMS: 45000, // Close sockets after 45s of inactivity (client-side)
      family: 4, // Force IPv4 to avoid slow dual-stack lookups on Oracle
      // Connection pool tuning: default of 5 is too small for concurrent
      // scrape + cache + metadata lookups under burst traffic.
      maxPoolSize: 20,
      minPoolSize: 5,
      maxIdleTimeMS: 30000, // Match Atlas idle timeout (Atlas drops TCP after 30min)
    });
    console.log("MongoDB Uplink Established");

    // One-time migration: drop the old TTL index on streamExpiresAt (4-6h)
    // so documents aren't reaped before the new 14-day expiresAt TTL kicks in.
    // Mongoose will auto-create the new expiresAt TTL index from the schema.
    // Once the old index is gone, this dropIndex call is a harmless no-op.
    try {
      const db = mongoose.connection.db;
      if (db) {
        await db.collection("streamcaches").dropIndex("streamExpiresAt_1");
        console.log(
          "[DB] Dropped old streamExpiresAt TTL index (migrated to expiresAt)",
        );
      }
    } catch (e: any) {
      // Index doesn't exist (already migrated) — ignore
      if (!e.message?.includes("index not found")) {
        console.warn("[DB] Index migration note:", e.message);
      }
    }
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

// For coalescing concurrent stream scrape requests
interface InFlightStreamEntry {
  promise: Promise<any>;
  abortController: AbortController;
  refCount: number;
}
const inFlightStreams = new Map<string, InFlightStreamEntry>();

// Endpoint: Health Check (Lightweight, No Rate Limit)
app.get(["/health", "/api/health"], (req, res) => {
  res.status(200).json({ status: "ok", timestamp: new Date().toISOString() });
});

// In-memory cache for external IDs (IMDB/TVDB). These IDs are permanent
// for any given title so there is no need for TTL-based expiry.
const _externalIdCache = new Map<string, string | null>();

async function getExternalIMDBId(tmdbId: string, type: "movie" | "tv") {
  const cacheKey = `imdb-${tmdbId}-${type}`;
  if (_externalIdCache.has(cacheKey)) return _externalIdCache.get(cacheKey)!;
  try {
    let imdbId: string | null = null;
    if (type === "movie") {
      const res = await axios.get(
        `https://api.themoviedb.org/3/movie/${tmdbId}`,
        {
          headers: { Authorization: `Bearer ${TMDB_API_KEY}` },
        },
      );
      imdbId = res.data.imdb_id || null;
    } else {
      const res = await axios.get(
        `https://api.themoviedb.org/3/tv/${tmdbId}/external_ids`,
        {
          headers: { Authorization: `Bearer ${TMDB_API_KEY}` },
        },
      );
      imdbId = res.data.imdb_id || null;
    }

    if (_externalIdCache.size >= 10000) {
      const oldestKey = _externalIdCache.keys().next().value;
      if (oldestKey) _externalIdCache.delete(oldestKey);
    }
    _externalIdCache.set(cacheKey, imdbId);
    return imdbId;
  } catch (e) {
    // Do NOT cache failures — let them retry on the next request
    return null;
  }
}

// formatBytes, parseSizeToBytes, parseAndFormatSize, VidVault helpers
// → moved to utils/vidvault.ts

function parseTorrentioTitle(title: string) {
  const parts = title.split("\n");
  const filename = parts[0] || "Unknown Title";
  const statsLine = parts[1] || "";

  let seeds = 0;
  let peers = 0;
  let size = "Unknown Size";
  let provider = "Torrentio";

  const seedsMatch = statsLine.match(/👤\s*(\d+)/);
  if (seedsMatch && seedsMatch[1]) seeds = parseInt(seedsMatch[1]) || 0;

  const peersMatch =
    statsLine.match(/👥\s*(\d+)/) || statsLine.match(/👤\s*\d+\s*(\d+)/);
  if (peersMatch && peersMatch[1]) peers = parseInt(peersMatch[1]) || 0;

  const sizeMatch =
    statsLine.match(/💾\s*([\d\.]+\s*[MGB]+)/i) ||
    statsLine.match(/💾\s*([^⚙️\n]+)/);
  if (sizeMatch && sizeMatch[1]) size = sizeMatch[1].trim();

  const providerMatch = statsLine.match(/⚙️\s*([^\n\r]+)/);
  if (providerMatch && providerMatch[1]) provider = providerMatch[1].trim();

  return { filename, seeds, peers, size, provider };
}

// Endpoint: Stream Proxy for direct downloads (bypasses hotlink protection & sets friendly filenames)
app.get("/api/download/stream-file", async (req, res) => {
  let targetUrl = req.query.url as string;
  const filename = (req.query.name as string) || "download";

  if (!targetUrl) {
    return res.status(400).json({ error: "Missing url parameter" });
  }

  // Route hakunaymatata.com CDN requests through Cloudflare worker to bypass datacenter IP blocks
  if (
    targetUrl.includes("hakunaymatata.com") &&
    !targetUrl.includes("workers.dev")
  ) {
    targetUrl = `https://dreadnought.47qzoobg8k.workers.dev/${encodeURIComponent(targetUrl)}`;
  } else if (targetUrl.includes("dl.gemlelispe.workers.dev")) {
    targetUrl = targetUrl.replace(
      "dl.gemlelispe.workers.dev",
      "dreadnought.47qzoobg8k.workers.dev",
    );
  }

  try {
    // Set headers to trigger a file download in the browser with friendly filename
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(filename)}"`,
    );
    res.setHeader("Content-Type", "application/octet-stream");

    const response = await axios({
      method: "get",
      url: targetUrl,
      responseType: "stream",
      headers: {
        "User-Agent": VIDVAULT_UA,
        Referer: "https://vidvault.ru/",
        Origin: "https://vidvault.ru",
        Accept: "*/*",
      },
    });

    if (response.headers["content-length"]) {
      res.setHeader("Content-Length", response.headers["content-length"]);
    }

    response.data.pipe(res);
  } catch (error: any) {
    console.error(
      `[STREAM PROXY ERROR] Failed to stream ${targetUrl}: ${error.message}`,
    );
    if (!res.headersSent) {
      res.status(500).json({ error: "Failed to download file" });
    }
  }
});

// Endpoint: Download Torrent Links
app.get("/api/download", async (req, res) => {
  const tmdbId = req.query.tmdbId as string;
  const kind = req.query.type as "movie" | "tv";

  if (!tmdbId || !kind) {
    return res.status(400).json({ error: "Missing tmdbId or type" });
  }

  const cacheKey = `torrent-downloads-${tmdbId}-${kind}`;

  try {
    // 1. Cache Check
    const cached = await TmdbCache.findOne({
      key: cacheKey,
      expiresAt: { $gt: new Date() },
    });
    if (cached) {
      return res.json(cached.data);
    }

    // 2. Resolve IMDB ID
    let imdbId = await getExternalIMDBId(tmdbId, kind);
    if (!imdbId) {
      return res
        .status(404)
        .json({ error: "IMDB ID not found for this title" });
    }

    let torrents: any[] = [];
    let title = "";

    if (kind === "movie") {
      // 1. YTS API (Primary)
      try {
        const ytsUrl = `https://yts.bz/api/v2/movie_details.json?imdb_id=${imdbId}`;
        const response = await axios.get(ytsUrl, { timeout: 8000 });
        const movie = response.data?.data?.movie;
        if (movie && movie.torrents) {
          title = movie.title_long || movie.title || "Movie";
          torrents = movie.torrents.map((t: any) => {
            const magnet = `magnet:?xt=urn:btih:${t.hash}&dn=${encodeURIComponent(title)}&tr=udp://open.demonii.com:1337/announce&tr=udp://tracker.openbittorrent.com:80&tr=udp://tracker.coppersurfer.tk:6969&tr=udp://glotorrents.pw:6969/announce&tr=udp://tracker.opentrackr.org:1337/announce`;
            return {
              title,
              quality: t.quality,
              size: t.size,
              seeds: t.seeds,
              peers: t.peers,
              magnet,
              torrent_url: t.url,
              source: "YTS",
              type: "movie",
            };
          });
        }
      } catch (err: any) {
        console.warn(`[DOWNLOAD] YTS search error: ${err.message}`);
      }

      // 2. Torrentio API (Backup & Multi-Provider Search)
      try {
        const torrentioUrl = `https://torrentio.strem.fun/providers=yts,eztv,1337x,rarbg,torrentgalaxy/stream/movie/${imdbId}.json`;
        const response = await axios.get(torrentioUrl, { timeout: 8000 });
        const streams = response.data?.streams || [];

        streams.forEach((s: any) => {
          if (!s.infoHash) return;
          const parsed = parseTorrentioTitle(s.title);
          const quality = s.name.split("\n")[1] || "HD";

          // Avoid duplicating identical torrent info hashes if YTS already got them
          if (
            torrents.some((t) =>
              t.magnet.toLowerCase().includes(s.infoHash.toLowerCase()),
            )
          ) {
            return;
          }

          const magnet = `magnet:?xt=urn:btih:${s.infoHash}&dn=${encodeURIComponent(parsed.filename)}&tr=udp://open.demonii.com:1337/announce&tr=udp://tracker.openbittorrent.com:80&tr=udp://tracker.coppersurfer.tk:6969&tr=udp://glotorrents.pw:6969/announce&tr=udp://tracker.opentrackr.org:1337/announce`;
          torrents.push({
            title: parsed.filename,
            quality,
            size: parsed.size,
            seeds: parsed.seeds,
            peers: parsed.peers,
            magnet,
            source: parsed.provider,
            type: "movie",
          });
        });
      } catch (err: any) {
        console.warn(
          `[DOWNLOAD] Torrentio movie fallback failed: ${err.message}`,
        );
      }

      // 3. Apibay API (The Pirate Bay Backup)
      try {
        const apibayUrl = `https://apibay.org/q.php?q=${imdbId}`;
        const response = await axios.get(apibayUrl, { timeout: 8000 });
        const results = response.data || [];
        if (Array.isArray(results)) {
          results.forEach((t: any) => {
            if (
              !t.info_hash ||
              t.info_hash === "0000000000000000000000000000000000000000"
            )
              return;
            const sizeBytes = parseInt(t.size) || 0;
            if (t.name === "No results found" || sizeBytes === 0) return;

            // Deduplicate by info hash
            if (
              torrents.some((ex) =>
                ex.magnet.toLowerCase().includes(t.info_hash.toLowerCase()),
              )
            ) {
              return;
            }

            const sizeStr = formatBytes(sizeBytes);
            const seeds = parseInt(t.seeders) || 0;
            const peers = parseInt(t.leechers) || 0;

            // Simple quality heuristic
            let quality = "HD";
            if (/2160p|4k/i.test(t.name)) quality = "2160p (4K)";
            else if (/1080p/i.test(t.name)) quality = "1080p";
            else if (/720p/i.test(t.name)) quality = "720p";
            else if (/480p/i.test(t.name)) quality = "480p";
            else if (/hdrip|webrip|web-dl/i.test(t.name)) quality = "WEBRip";
            else if (/bluray/i.test(t.name)) quality = "BluRay";

            const magnet = `magnet:?xt=urn:btih:${t.info_hash}&dn=${encodeURIComponent(t.name)}&tr=udp://tracker.coppersurfer.tk:6969/announce&tr=udp://tracker.openbittorrent.com:6969/announce&tr=udp://tracker.opentrackr.org:1337/announce&tr=udp://open.stealth.si:80/announce&tr=udp://tracker.torrent.eu.org:451/announce`;

            torrents.push({
              title: t.name,
              quality,
              size: sizeStr,
              seeds,
              peers,
              magnet,
              source: "ThePirateBay",
              type: "movie",
            });
          });
        }
      } catch (err: any) {
        console.warn(`[DOWNLOAD] Apibay movie fallback failed: ${err.message}`);
      }
    } else {
      // TV Show
      // 1. Primary: EZTV API
      try {
        const numericImdbId = imdbId.replace(/^tt/, "");
        const eztvUrl = `https://eztv.re/api/get-torrents?imdb_id=${numericImdbId}`;
        const response = await axios.get(eztvUrl, { timeout: 12000 });
        const eztvTorrents = response.data?.torrents || [];

        torrents = eztvTorrents.map((t: any) => {
          const sizeBytes = parseInt(t.size_bytes) || 0;
          const sizeStr =
            sizeBytes > 0 ? formatBytes(sizeBytes) : "Unknown Size";
          return {
            title: t.title,
            filename: t.filename,
            season: parseInt(t.season) || 0,
            episode: parseInt(t.episode) || 0,
            seeds: parseInt(t.seeds) || 0,
            peers: parseInt(t.peers) || 0,
            size: sizeStr,
            magnet: t.magnet_url,
            torrent_url: t.torrent_url,
            source: "EZTV",
            type: "tv",
          };
        });
      } catch (err: any) {
        console.warn(`[DOWNLOAD] EZTV search error: ${err.message}`);
      }

      // 2. Backup: Apibay API (The Pirate Bay) - fetches complete season packs and backup episodes
      try {
        const apibayUrl = `https://apibay.org/q.php?q=${imdbId}`;
        const response = await axios.get(apibayUrl, { timeout: 8000 });
        const results = response.data || [];
        if (Array.isArray(results)) {
          results.forEach((t: any) => {
            if (
              !t.info_hash ||
              t.info_hash === "0000000000000000000000000000000000000000"
            )
              return;
            const sizeBytes = parseInt(t.size) || 0;
            if (t.name === "No results found" || sizeBytes === 0) return;

            // Deduplicate
            if (
              torrents.some((ex) =>
                ex.magnet.toLowerCase().includes(t.info_hash.toLowerCase()),
              )
            ) {
              return;
            }

            const sizeStr = formatBytes(sizeBytes);
            const seeds = parseInt(t.seeders) || 0;
            const peers = parseInt(t.leechers) || 0;

            // Parse season/episode from name
            let season = 0;
            let episode = 0;

            const s00e00Match = t.name.match(/s(\d+)\s*e(\d+)/i);
            if (s00e00Match) {
              season = parseInt(s00e00Match[1]) || 0;
              episode = parseInt(s00e00Match[2]) || 0;
            } else {
              const seasonOnlyMatch =
                t.name.match(/season\s*(\d+)/i) || t.name.match(/\bs(\d+)\b/i);
              if (seasonOnlyMatch) {
                season = parseInt(seasonOnlyMatch[1]) || 0;
                episode = 0; // Season pack
              }
            }

            const magnet = `magnet:?xt=urn:btih:${t.info_hash}&dn=${encodeURIComponent(t.name)}&tr=udp://tracker.coppersurfer.tk:6969/announce&tr=udp://tracker.openbittorrent.com:6969/announce&tr=udp://tracker.opentrackr.org:1337/announce&tr=udp://open.stealth.si:80/announce&tr=udp://tracker.torrent.eu.org:451/announce`;

            torrents.push({
              title: t.name,
              filename: t.name,
              season,
              episode,
              seeds,
              peers,
              size: sizeStr,
              magnet,
              source: "ThePirateBay",
              type: "tv",
            });
          });
        }
      } catch (err: any) {
        console.warn(`[DOWNLOAD] Apibay TV fallback failed: ${err.message}`);
      }
    }

    const cachePayload = { title, imdbId, torrents };
    const ttl = 1000 * 60 * 60 * 24;
    await TmdbCache.findOneAndUpdate(
      { key: cacheKey },
      {
        data: cachePayload,
        expiresAt: new Date(Date.now() + ttl),
      },
      { upsert: true },
    ).catch(() => null);

    return res.json({ title, imdbId, torrents });
  } catch (error: any) {
    console.error(`[DOWNLOAD API ERROR] For ${tmdbId}: ${error.message}`);
    return res
      .status(500)
      .json({ error: error.message || "Failed to fetch torrents" });
  }
});

// Endpoint: Download TV Episode Backups (On-Demand Torrentio Search)
app.get("/api/download/episode", async (req, res) => {
  const tmdbId = req.query.tmdbId as string;
  const season = parseInt(req.query.season as string) || 1;
  const episode = parseInt(req.query.episode as string) || 1;

  if (!tmdbId) {
    return res.status(400).json({ error: "Missing tmdbId" });
  }

  const cacheKey = `torrent-downloads-episode-${tmdbId}-${season}-${episode}`;

  try {
    // 1. Cache Check
    const cached = await TmdbCache.findOne({
      key: cacheKey,
      expiresAt: { $gt: new Date() },
    });
    if (cached) {
      return res.json(cached.data);
    }

    // 2. Resolve IMDB ID
    let imdbId = await getExternalIMDBId(tmdbId, "tv");
    if (!imdbId) {
      return res
        .status(404)
        .json({ error: "IMDB ID not found for this TV show" });
    }

    const torrents: any[] = [];

    // 3. Query Torrentio
    try {
      const torrentioUrl = `https://torrentio.strem.fun/providers=yts,eztv,1337x,rarbg,torrentgalaxy/stream/series/${imdbId}:${season}:${episode}.json`;
      const response = await axios.get(torrentioUrl, { timeout: 10000 });
      const streams = response.data?.streams || [];

      streams.forEach((s: any) => {
        if (!s.infoHash) return;
        const parsed = parseTorrentioTitle(s.title);
        const quality = s.name.split("\n")[1] || "HD";
        const magnet = `magnet:?xt=urn:btih:${s.infoHash}&dn=${encodeURIComponent(parsed.filename)}&tr=udp://open.demonii.com:1337/announce&tr=udp://tracker.openbittorrent.com:80&tr=udp://tracker.coppersurfer.tk:6969&tr=udp://glotorrents.pw:6969/announce&tr=udp://tracker.opentrackr.org:1337/announce`;

        torrents.push({
          title: parsed.filename,
          quality,
          size: parsed.size,
          seeds: parsed.seeds,
          peers: parsed.peers,
          magnet,
          source: parsed.provider,
          type: "tv",
        });
      });
    } catch (err: any) {
      console.warn(
        `[DOWNLOAD EPISODE] Torrentio backup failed: ${err.message}`,
      );
    }

    // 4. Query Apibay (The Pirate Bay) for exact season & episode
    try {
      const formattedEp = `s${season.toString().padStart(2, "0")}e${episode.toString().padStart(2, "0")}`;
      const apibayUrl = `https://apibay.org/q.php?q=${imdbId}+${formattedEp}`;
      const response = await axios.get(apibayUrl, { timeout: 8000 });
      const results = response.data || [];

      if (Array.isArray(results)) {
        results.forEach((t: any) => {
          if (
            !t.info_hash ||
            t.info_hash === "0000000000000000000000000000000000000000"
          )
            return;
          const sizeBytes = parseInt(t.size) || 0;
          if (t.name === "No results found" || sizeBytes === 0) return;

          // Deduplicate
          if (
            torrents.some((ex) =>
              ex.magnet.toLowerCase().includes(t.info_hash.toLowerCase()),
            )
          ) {
            return;
          }

          const sizeStr = formatBytes(sizeBytes);
          const seeds = parseInt(t.seeders) || 0;
          const peers = parseInt(t.leechers) || 0;

          const magnet = `magnet:?xt=urn:btih:${t.info_hash}&dn=${encodeURIComponent(t.name)}&tr=udp://tracker.coppersurfer.tk:6969/announce&tr=udp://tracker.openbittorrent.com:6969/announce&tr=udp://tracker.opentrackr.org:1337/announce&tr=udp://open.stealth.si:80/announce&tr=udp://tracker.torrent.eu.org:451/announce`;

          torrents.push({
            title: t.name,
            quality: "HD",
            size: sizeStr,
            seeds,
            peers,
            magnet,
            source: "ThePirateBay",
            type: "tv",
          });
        });
      }
    } catch (err: any) {
      console.warn(`[DOWNLOAD EPISODE] Apibay backup failed: ${err.message}`);
    }

    const cachePayload = { torrents };
    const ttl = 1000 * 60 * 60 * 24;
    await TmdbCache.findOneAndUpdate(
      { key: cacheKey },
      {
        data: cachePayload,
        expiresAt: new Date(Date.now() + ttl),
      },
      { upsert: true },
    ).catch(() => null);

    return res.json({ torrents });
  } catch (error: any) {
    console.error(`[DOWNLOAD EPISODE ERROR] ${error.message}`);
    return res
      .status(500)
      .json({ error: error.message || "Failed to fetch backup streams" });
  }
});

// Endpoint: Download Movie/TV Direct Links (VidVault)
app.get("/api/download/direct", async (req, res) => {
  const tmdbId = req.query.tmdbId as string;
  const kind = req.query.type as "movie" | "tv";

  if (!tmdbId || !kind) {
    return res.status(400).json({ error: "Missing tmdbId or type" });
  }

  const cacheKey = `direct-downloads-${tmdbId}-${kind}`;

  try {
    const cached = await TmdbCache.findOne({
      key: cacheKey,
      expiresAt: { $gt: new Date() },
    });
    if (cached) {
      return res.json({ directDownloads: cached.data });
    }

    const directDownloads = await fetchVidVaultDownloads(kind, tmdbId);

    // Only cache if we got actual links
    if (directDownloads.length > 0) {
      const ttl = 1000 * 60 * 5; // 5 minutes cache
      await TmdbCache.findOneAndUpdate(
        { key: cacheKey },
        {
          data: directDownloads,
          expiresAt: new Date(Date.now() + ttl),
        },
        { upsert: true },
      ).catch(() => null);
    }

    return res.json({ directDownloads });
  } catch (error: any) {
    console.error(
      `[DIRECT DOWNLOAD API ERROR] For ${tmdbId}: ${error.message}`,
    );
    return res
      .status(500)
      .json({ error: error.message || "Failed to fetch direct downloads" });
  }
});

// Endpoint: Download TV Episode Direct Links (VidVault)
app.get("/api/download/episode/direct", async (req, res) => {
  const tmdbId = req.query.tmdbId as string;
  const season = parseInt(req.query.season as string) || 1;
  const episode = parseInt(req.query.episode as string) || 1;

  if (!tmdbId) {
    return res.status(400).json({ error: "Missing tmdbId" });
  }

  const cacheKey = `direct-downloads-episode-${tmdbId}-${season}-${episode}`;

  try {
    const cached = await TmdbCache.findOne({
      key: cacheKey,
      expiresAt: { $gt: new Date() },
    });
    if (cached) {
      return res.json({ directDownloads: cached.data });
    }

    const directDownloads = await fetchVidVaultDownloads(
      "tv",
      tmdbId,
      season,
      episode,
    );

    // Only cache if we got actual links
    if (directDownloads.length > 0) {
      const ttl = 1000 * 60 * 5; // 5 minutes cache
      await TmdbCache.findOneAndUpdate(
        { key: cacheKey },
        {
          data: directDownloads,
          expiresAt: new Date(Date.now() + ttl),
        },
        { upsert: true },
      ).catch(() => null);
    }

    return res.json({ directDownloads });
  } catch (error: any) {
    console.error(
      `[DIRECT DOWNLOAD EPISODE ERROR] For ${tmdbId} S${season}E${episode}: ${error.message}`,
    );
    return res.status(500).json({
      error: error.message || "Failed to fetch direct episode downloads",
    });
  }
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
  res.setHeader(
    "Cache-Control",
    "no-store, no-cache, must-revalidate, proxy-revalidate",
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Surrogate-Control", "no-store");

  try {
    const force = req.query.force === "1" || req.query.nocache === "1";

    // 1. Cache Check
    const cachedRecord = force
      ? null
      : await StreamCache.findOne({
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

    const cacheKey = `${tmdbId}-${kind}-${season}-${episode}`;
    let entry = inFlightStreams.get(cacheKey);
    let isCoalesced = false;

    if (entry) {
      entry.refCount++;
      isCoalesced = true;
      console.log(
        `[STREAM] Coalescing request for key: ${cacheKey}. Active listeners: ${entry.refCount}`,
      );
    } else {
      const controller = new AbortController();
      const signal = controller.signal;

      const scrapePromise = (async () => {
        const mirrors: MirrorStream[] = [];
        let sourceName = "none";
        let qualityTag = "UNKNOWN";
        let resolution = "UNKNOWN";
        let streamUrl: string | null = null;
        let proxyUsed: string | undefined = undefined;

        // ── Phase B: Direct TMDB Path (VidLink) ──────────────────────────
        if (mirrors.length === 0) {
          console.log(
            `[STREAM] Phase B: Checking VidLink (Direct TMDB Path)...`,
          );
          try {
            const vidlinkMirrors = await VidLinkScraper.getStream(
              tmdbId.toString(),
              kind as any,
              season,
              episode,
              signal,
            );
            if (vidlinkMirrors && vidlinkMirrors.length > 0) {
              console.log(
                `[STREAM] VidLink HIT ✔ (Found ${vidlinkMirrors.length} mirrors)`,
              );
              mirrors.push(...vidlinkMirrors);
            }
          } catch (e) {
            console.error(`[STREAM] VidLink failed:`, e);
          }
        }

        if (mirrors.length === 0) {
          // Record in DeadPool
          try {
            await DeadPool.findOneAndUpdate(
              { tmdbId: tmdbId.toString(), type: kind, season, episode },
              {
                lastChecked: new Date(),
                expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24h TTL
              },
              { upsert: true },
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

          // P9 - REMOVED the blocking getSubtitles (OpenSubtitles) call since client fetches it in parallel

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
          const isCAM =
            qualityTag === "CAM" ||
            qualityTag === "TC" ||
            qualityTag === "UNKNOWN";

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

          if (isNewMovie && isCAM) {
            console.log(
              `[CACHE] New CAM detected. Setting short TTL (6h) for rotation.`,
            );
            expiresAt.setHours(expiresAt.getHours() + 6);
          } else {
            // High quality or old movie — cache for 4 hours
            console.log(`[CACHE] Standard movie. Setting 4h TTL.`);
            expiresAt.setHours(expiresAt.getHours() + 4);
          }

          await StreamCache.findOneAndUpdate(
            { tmdbId, type: kind, season, episode },
            {
              streamUrl,
              source: sourceName,
              qualityTag,
              resolution,
              mirrors,
              streamExpiresAt: expiresAt,
              // Document lives 14 days so the "Verified" badge persists on
              // movie cards long after the stream URL expires (4-6h).
              // The code-level check on streamExpiresAt prevents stale URLs
              // from being served, but the document's existence is enough
              // for the availability endpoint to report isVerified=true.
              expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
            },
            { upsert: true },
          )
            .then(() => {
              // If we found a stream, it's no longer "Dead"
              DeadPool.deleteOne({
                tmdbId: tmdbId.toString(),
                type: kind,
                season,
                episode,
              }).catch(() => {});
            })
            .catch((err) =>
              console.error("[CACHE] Failed to save mirrors:", err),
            );
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

        return {
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
        };
      })();

      entry = {
        promise: scrapePromise,
        abortController: controller,
        refCount: 1,
      };
      inFlightStreams.set(cacheKey, entry);
    }

    const currentEntry = entry;
    const onReqClose = () => {
      currentEntry.refCount--;
      if (currentEntry.refCount <= 0) {
        console.log(
          `[STREAM] All listeners for ${cacheKey} closed. Aborting scraper.`,
        );
        currentEntry.abortController.abort();
      }
    };
    req.on("close", onReqClose);

    try {
      const result = await currentEntry.promise;
      req.off("close", onReqClose);
      return res.json(result);
    } catch (err: any) {
      req.off("close", onReqClose);
      throw err;
    } finally {
      if (!isCoalesced) {
        inFlightStreams.delete(cacheKey);
      }
    }
  } catch (error: any) {
    if (error.name === "AbortError") {
      return res.status(499).json({ error: "Request aborted by client" });
    }
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

// Endpoint: TMDB Proxy with local MongoDB caching (TTL 6 hours)
app.get("/api/tmdb-proxy", async (req, res) => {
  const rawEndpoint = req.query.endpoint as string;
  if (!rawEndpoint) {
    return res.status(400).json({ error: "Missing endpoint parameter" });
  }

  const endpoint = rawEndpoint.startsWith("/")
    ? rawEndpoint
    : "/" + rawEndpoint;

  if (!TMDB_API_KEY) {
    return res
      .status(500)
      .json({ error: "TMDB_API_KEY not configured on server" });
  }

  // Safety: never fetch KissKH IDs from TMDB
  const lastPart = endpoint.split("/").pop() || "";
  if (lastPart.startsWith("k")) {
    return res.json({ results: [] });
  }

  // Extract query parameters (excluding the endpoint key itself)
  const params: Record<string, string> = {};
  for (const [key, val] of Object.entries(req.query)) {
    if (key !== "endpoint" && typeof val === "string") {
      params[key] = val;
    }
  }

  // Create a sorted query string to construct a deterministic cache key
  const sortedQuery = new URLSearchParams();
  sortedQuery.append("language", params.language || "en-US");
  Object.keys(params)
    .sort()
    .forEach((k) => {
      if (k !== "language") {
        sortedQuery.append(k, params[k] || "");
      }
    });

  const cacheKey = `tmdb-proxy-${endpoint}-${sortedQuery.toString()}`;

  try {
    // 1. Cache Check
    const cached = await TmdbCache.findOne({
      key: cacheKey,
      expiresAt: { $gt: new Date() },
    });
    if (cached) {
      return res.json(cached.data);
    }

    // 2. Fetch from TMDB
    const isV4Token = TMDB_API_KEY.length > 40;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (isV4Token) {
      headers["Authorization"] = `Bearer ${TMDB_API_KEY}`;
    } else {
      sortedQuery.append("api_key", TMDB_API_KEY);
    }

    const tmdbUrl = `https://api.themoviedb.org/3${endpoint}?${sortedQuery.toString()}`;
    const response = await axios.get(tmdbUrl, {
      headers,
      timeout: 10000,
    });

    const data = response.data;

    // Default caching: 6 hours (matches frontend TTL concepts)
    const ttl = 1000 * 60 * 60 * 6;

    // 3. Save to Cache
    await TmdbCache.findOneAndUpdate(
      { key: cacheKey },
      {
        data,
        expiresAt: new Date(Date.now() + ttl),
      },
      { upsert: true },
    ).catch(() => null);

    return res.json(data);
  } catch (err: any) {
    console.error(`[TMDB PROXY ERROR] For ${endpoint}: ${err.message}`);
    return res.status(err.response?.status || 500).json({
      error: err.response?.data?.status_message || err.message,
    });
  }
});

// Subtitle routes (aggregation + proxy) → routes/subtitles.ts
app.use(createSubtitleRouter(fetchVidLinkRaw));

// Endpoint: Stop stream heartbeat (call when player closes/user leaves)
app.get("/api/stream/stop", (req, res) => {
  const tmdbId = req.query.tmdbId as string;
  if (!tmdbId) return res.status(400).json({ error: "Missing tmdbId" });
  stopHeartbeat(tmdbId, req.ip);
  return res.json({ ok: true });
});

// Endpoint: Flush stream cache (force re-scrape on next play)
app.post("/api/stream/flush", express.json(), async (req, res) => {
  const key = req.headers["x-admin-key"] || req.query.key;
  if (key !== ADMIN_KEY)
    return res
      .status(401)
      .json({ error: "Unauthorized access — specify ?key= in URL" });

  const tmdbId = req.body?.tmdbId as string;
  if (!tmdbId) return res.status(400).json({ error: "Missing tmdbId" });
  await StreamCache.updateMany(
    { tmdbId: { $in: [tmdbId, `${tmdbId}-vidrock`, `${tmdbId}-videasy`] } },
    { streamUrl: null, streamExpiresAt: null, subtitles: [] },
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

  if (
    targetUrl.includes("hakunaymatata.com") &&
    !targetUrl.includes("workers.dev")
  ) {
    targetUrl = `https://dreadnought.47qzoobg8k.workers.dev/${encodeURIComponent(targetUrl)}`;
  } else if (targetUrl.includes("dl.gemlelispe.workers.dev")) {
    targetUrl = targetUrl.replace(
      "dl.gemlelispe.workers.dev",
      "dreadnought.47qzoobg8k.workers.dev",
    );
  }

  // Redirect local master.m3u8 requests directly to avoid proxying localhost over public proxy tunnels
  if (targetUrl.includes("/api/videasy/master.m3u8")) {
    console.log(
      "[PROXY/stream] Local master playlist detected. Redirecting directly.",
    );
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.redirect(302, targetUrl);
  }

  // Direct MP4 / video file redirect to segment proxy to prevent buffering the whole file in memory
  const lowercaseUrl = targetUrl.toLowerCase();
  const isDirectMedia =
    lowercaseUrl.includes(".mp4") ||
    lowercaseUrl.includes("/mp4/") ||
    lowercaseUrl.includes("/mp4?") ||
    lowercaseUrl.endsWith("/mp4") ||
    lowercaseUrl.includes(".m4v") ||
    lowercaseUrl.includes(".webm") ||
    lowercaseUrl.includes(".mkv") ||
    lowercaseUrl.includes(".mov");

  if (isDirectMedia) {
    console.log(
      "[PROXY/stream] Direct media URL detected. Redirecting to segment proxy.",
    );
    const protocol = req.headers["x-forwarded-proto"] || req.protocol;
    const currentHost =
      process.env.API_URL || `${protocol}://${req.get("host")}`;
    const proxyParam = req.query.nebula_proxy
      ? `&nebula_proxy=${encodeURIComponent(req.query.nebula_proxy as string)}`
      : "";
    const redirectUrl = `${currentHost}/api/proxy/segment?url=${encodeURIComponent(targetUrl)}${proxyParam}`;
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.redirect(302, redirectUrl);
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
  const cached = getProxyCache(cacheKey);
  if (cached) {
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
      return res.status(status).send(upstream.body || "Upstream error");
    }

    if (!upstream.body || upstream.body.length === 0) {
      console.error(
        `[PROXY/stream] ✘ Empty body from CDN (${duration}ms) | url=${targetUrl.substring(0, 60)}...`,
      );
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.status(502).send("Empty response from CDN");
    }

    const manifest = upstream.body.toString("utf-8");

    if (typeof manifest !== "string") {
      return res.status(502).send("Invalid manifest content");
    }

    const trimmedManifest = manifest.trim();
    if (
      trimmedManifest === "#EXTM3U" ||
      trimmedManifest.length < 20 ||
      (!trimmedManifest.includes("#EXT-X-STREAM-INF") &&
        !trimmedManifest.includes("#EXTINF") &&
        !trimmedManifest.includes(".m3u8") &&
        !trimmedManifest.includes(".ts") &&
        !trimmedManifest.includes(".mp4") &&
        !trimmedManifest.startsWith("["))
    ) {
      console.warn(
        `[PROXY/stream] Rejected empty or invalid HLS manifest (length: ${trimmedManifest.length}).`,
      );
      res.setHeader("Access-Control-Allow-Origin", "*");
      return res.status(404).send("Empty manifest from CDN");
    }

    // Handle JSON playlist (e.g. Atlas / vdrk.site MP4 resolution list)
    if (manifest.trim().startsWith("[")) {
      try {
        const playlist = JSON.parse(manifest);
        if (Array.isArray(playlist) && playlist.length > 0) {
          // Sort by resolution descending (highest resolution first)
          playlist.sort(
            (a: any, b: any) => (b.resolution || 0) - (a.resolution || 0),
          );
          const bestTrack = playlist[0];
          if (bestTrack && bestTrack.url) {
            const protocol = req.headers["x-forwarded-proto"] || req.protocol;
            const currentHost =
              process.env.API_URL || `${protocol}://${req.get("host")}`;
            const proxiedUrl = `${currentHost}/api/proxy/segment?url=${encodeURIComponent(bestTrack.url)}`;

            console.log(
              `[PROXY/stream] JSON playlist detected. Redirecting to best MP4: ${bestTrack.resolution}p -> ${bestTrack.url.substring(0, 80)}...`,
            );
            res.setHeader("Access-Control-Allow-Origin", "*");
            return res.redirect(302, proxiedUrl);
          }
        }
      } catch (err: any) {
        console.error(
          `[PROXY/stream] Failed to parse JSON playlist: ${err.message}`,
        );
      }
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
      if (uri.startsWith("?")) {
        const qIdx = actualTargetUrl.indexOf("?");
        const base =
          qIdx >= 0 ? actualTargetUrl.substring(0, qIdx) : actualTargetUrl;
        return base + uri;
      }
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

    // 1. Rewrite URI= attributes in tags (case-insensitive, optional spaces, single/double quotes)
    let proxified = manifest.replace(
      /URI\s*=\s*(?:"([^"]+)"|'([^']+)'|([^",'\s][^,\s]*))/gi,
      (match, doubleQuoted, singleQuoted, unquoted) => {
        const uri = (doubleQuoted || singleQuoted || unquoted || "").trim();
        if (!uri) return match;

        const abs = fastResolve(uri);
        const ext = abs.split("?")[0]?.split(".").pop()?.toLowerCase();
        const proxyPath =
          ext === "m3u8" ? "/api/proxy/stream" : "/api/proxy/segment";

        rewrittenCount++;
        const proxiedUrl = withProxy(proxyPath, encodeURIComponent(abs));
        if (doubleQuoted) return `URI="${proxiedUrl}"`;
        if (singleQuoted) return `URI='${proxiedUrl}'`;
        return `URI=${proxiedUrl}`;
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

  if (
    targetUrl.includes("hakunaymatata.com") &&
    !targetUrl.includes("workers.dev")
  ) {
    targetUrl = `https://dreadnought.47qzoobg8k.workers.dev/${encodeURIComponent(targetUrl)}`;
  } else if (targetUrl.includes("dl.gemlelispe.workers.dev")) {
    targetUrl = targetUrl.replace(
      "dl.gemlelispe.workers.dev",
      "dreadnought.47qzoobg8k.workers.dev",
    );
  }

  // Redirect playlist URLs to stream proxy to bypass ORB blocks on JSON responses
  const lowercaseUrl = targetUrl.toLowerCase();
  if (lowercaseUrl.includes("playlist") || lowercaseUrl.includes(".m3u8")) {
    console.log(
      `[PROXY/segment] Playlist URL detected in segment proxy. Redirecting to stream proxy: ${targetUrl.substring(0, 80)}...`,
    );
    const protocol = req.headers["x-forwarded-proto"] || req.protocol;
    const currentHost =
      process.env.API_URL || `${protocol}://${req.get("host")}`;
    const proxyParam = req.query.nebula_proxy
      ? `&nebula_proxy=${encodeURIComponent(req.query.nebula_proxy as string)}`
      : "";
    const redirectUrl = `${currentHost}/api/proxy/stream?url=${encodeURIComponent(targetUrl)}${proxyParam}`;
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.redirect(302, redirectUrl);
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
        if (req.destroyed || (req as any).signal?.aborted) return;
        const status = upstreamRes.statusCode ?? 502;

        if (status >= 400) {
          if (req.destroyed || (req as any).signal?.aborted) return;
          if (retryCount < 3 && [502, 503, 504, 520, 521].includes(status)) {
            console.warn(
              `[PROXY/segment] Retrying VidLink ${status} (attempt ${retryCount + 1})...`,
            );
            return startRequest(retryCount + 1);
          }
          console.error(
            `[PROXY/segment] ✘ VidLink ${status} | url=${baseOnly.substring(0, 60)}...`,
          );
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.status(status).end();
          return;
        }

        upstreamRes.on("data", (chunk) => {
          if (req.destroyed || (req as any).signal?.aborted) {
            upstreamRes.destroy();
            return;
          }
          if (!headersSent && !res.headersSent) {
            headersSent = true;
            res.status(status);
            res.setHeader(
              "Content-Type",
              upstreamRes.headers["content-type"] || "video/mp2t",
            );
            if (upstreamRes.headers["content-length"]) {
              res.setHeader(
                "Content-Length",
                upstreamRes.headers["content-length"],
              );
            }
            if (upstreamRes.headers["content-range"]) {
              res.setHeader(
                "Content-Range",
                upstreamRes.headers["content-range"],
              );
            }
            res.setHeader("Accept-Ranges", "bytes");
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("X-Proxy-Mode", "Streaming");
            // Fix 4: HLS segments are immutable (same URL = same bytes).
            // Cache privately in the browser for 1 hour so seek-back and
            // repeated pausing doesn't re-fetch from CDN.
            // 'private' prevents any intermediary (CDN/ISP) from caching
            // and serving stale segment data to other users.
            res.setHeader("Cache-Control", "private, max-age=3600");

            if (req.method === "HEAD") {
              res.end();
              upstream.destroy();
              return;
            }
          }
          res.write(chunk);
        });

        upstreamRes.on("end", () => {
          if (!res.writableEnded) res.end();
        });

        upstreamRes.on("error", (err) => {
          if (req.destroyed || (req as any).signal?.aborted) return;
          if (retryCount < 3 && !res.headersSent) {
            console.warn(
              `[PROXY/segment] Upstream error during download: ${err.message}. Retrying...`,
            );
            return startRequest(retryCount + 1);
          }
          if (!res.writableEnded) res.end();
        });
      });

      upstream.on("error", (err) => {
        if (req.destroyed || (req as any).signal?.aborted) return;
        if (
          retryCount < 3 &&
          (err.message.includes("socket hang up") ||
            (err as any).code === "ECONNRESET" ||
            err.message.includes("aborted"))
        ) {
          console.warn(
            `[PROXY/segment] Retrying VidLink error: ${err.message} (attempt ${retryCount + 1})...`,
          );
          return startRequest(retryCount + 1);
        }
        console.error(`[PROXY/segment] VidLink request error: ${err.message}`);
        if (!res.headersSent) {
          res.setHeader("Access-Control-Allow-Origin", "*");
          res.status(502).send("Proxy error");
        }
      });

      upstream.setTimeout(45000, () => {
        upstream.destroy();
        if (req.destroyed || (req as any).signal?.aborted) return;
        if (retryCount < 3) {
          console.warn(
            `[PROXY/segment] Retrying VidLink timeout (attempt ${retryCount + 1})...`,
          );
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
  const streamSegment = async (
    useProxy: boolean,
    retryCount = 0,
  ): Promise<void> => {
    const headers = { ...cdnHeaders(targetUrl, false), ...passHeaders };
    const proxyUrl =
      useProxy && segProxy
        ? segProxy.startsWith("http")
          ? segProxy
          : `http://${segProxy}`
        : undefined;

    const controller = new AbortController();
    const abortHandler = () => {
      controller.abort();
    };
    req.on("close", abortHandler);

    try {
      const axiosResponse = await axios.get(targetUrl, {
        headers,
        responseType: "stream",
        timeout: 45000, // Increased to avoid cancelled segments on slow connections
        signal: controller.signal,
        proxy: false, // disable axios auto-proxy; we set it via httpsAgent if needed
        httpsAgent: proxyUrl
          ? await getProxyAgent(proxyUrl)
          : getSharedHardenedAgent(), // reuse singleton to avoid per-request TLS context allocation
        maxRedirects: 5,
      });

      req.off("close", abortHandler);

      const status = axiosResponse.status;

      // On first attempt 403 + proxy available → retry through proxy
      if (status === 403 && !useProxy && segProxy) {
        (axiosResponse.data as any).destroy();
        return streamSegment(true);
      }

      if (status >= 400) {
        if (req.destroyed || (req as any).signal?.aborted) {
          (axiosResponse.data as any).destroy();
          return;
        }
        console.error(
          `[PROXY/segment] ✘ ${status} | proxy=${useProxy ? "YES" : "NO"} | url=${targetUrl.substring(0, 60)}...`,
        );
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.status(status).end();
        return;
      }

      // Guard: Redirect JSON responses (playlists) to stream proxy
      const contentType = axiosResponse.headers["content-type"] || "";
      if (contentType.toLowerCase().includes("json")) {
        (axiosResponse.data as any).destroy();
        console.log(
          `[PROXY/segment] JSON response detected from CDN. Redirecting to stream proxy: ${targetUrl.substring(0, 80)}...`,
        );
        const protocol = req.headers["x-forwarded-proto"] || req.protocol;
        const currentHost =
          process.env.API_URL || `${protocol}://${req.get("host")}`;
        const proxyParam = segProxy
          ? `&nebula_proxy=${encodeURIComponent(segProxy)}`
          : "";
        const redirectUrl = `${currentHost}/api/proxy/stream?url=${encodeURIComponent(targetUrl)}${proxyParam}`;
        res.setHeader("Access-Control-Allow-Origin", "*");
        return res.redirect(302, redirectUrl);
      }

      // Forward headers then pipe — no buffering
      res.status(status);
      res.setHeader(
        "Content-Type",
        axiosResponse.headers["content-type"] || "video/mp2t",
      );
      res.setHeader("Access-Control-Allow-Origin", "*");
      // Fix 4: browser-private segment cache — 1 hour, not shared with CDNs.
      res.setHeader("Cache-Control", "private, max-age=3600");
      if (axiosResponse.headers["content-length"]) {
        res.setHeader(
          "Content-Length",
          axiosResponse.headers["content-length"],
        );
      }
      if (axiosResponse.headers["content-range"]) {
        res.setHeader("Content-Range", axiosResponse.headers["content-range"]);
      }
      res.setHeader("Accept-Ranges", "bytes");

      if (req.method === "HEAD") {
        res.end();
        (axiosResponse.data as any).destroy();
        return;
      }

      // STREAM: pipe bytes directly to client as they arrive
      const dataStream = axiosResponse.data as import("stream").Readable;
      dataStream.pipe(res);

      dataStream.on("error", (err: Error) => {
        if (req.destroyed || (req as any).signal?.aborted) return;
        console.error(`[PROXY/segment] Stream error: ${err.message}`);
        if (!res.writableEnded) res.end();
      });

      // Kill upstream if player disconnects (seek/quality switch)
      req.on("close", () => {
        dataStream.destroy();
      });
    } catch (e: any) {
      req.off("close", abortHandler);

      if (req.destroyed || (req as any).signal?.aborted || axios.isCancel(e)) {
        return;
      }
      const status = e?.response?.status || e?.response?.statusCode || 0;

      // Retry logic for network errors (socket hang up, timeout, etc) and specific 5xx errors
      const isRetryableError =
        e.code === "ECONNRESET" ||
        e.code === "ETIMEDOUT" ||
        e.code === "ESOCKETTIMEDOUT" ||
        e.message?.includes("socket hang up") ||
        e.message?.includes("aborted");

      const isRetryableStatus = [502, 503, 504, 520, 521].includes(status);

      if (retryCount < 3 && (isRetryableError || isRetryableStatus)) {
        console.warn(
          `[PROXY/segment] Retrying Path B error: ${e.message} (status: ${status}, attempt ${retryCount + 1})...`,
        );
        return streamSegment(useProxy, retryCount + 1);
      }

      // 403 retry logic for non-axios errors
      if (
        !useProxy &&
        segProxy &&
        (status === 403 || e.code === "ERR_BAD_REQUEST")
      ) {
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

app.all("/api/cache/clear", express.json(), async (req, res) => {
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
    const queryIds = [
      ...tmdbIds,
      ...tmdbIds.map((id) => `${id}-vidrock`),
      ...tmdbIds.map((id) => `${id}-videasy`),
    ];
    const [cachedStreams, deadPool] = await Promise.all([
      StreamCache.find({ tmdbId: { $in: queryIds } }),
      DeadPool.find({ tmdbId: { $in: queryIds } }),
    ]);

    const results = tmdbIds.map((id) => {
      const showCached = cachedStreams.filter(
        (s) =>
          (String(s.tmdbId) === String(id) ||
            String(s.tmdbId) === `${id}-vidrock` ||
            String(s.tmdbId) === `${id}-videasy`) &&
          (s.streamUrl || (s.mirrors && s.mirrors.length > 0)),
      );
      const showDead = deadPool.filter(
        (d) =>
          String(d.tmdbId) === String(id) ||
          String(d.tmdbId) === `${id}-vidrock` ||
          String(d.tmdbId) === `${id}-videasy`,
      );

      const hasCached = showCached.length > 0;
      const hasDead = showDead.length > 0;

      const type = showCached[0]?.type || showDead[0]?.type || "movie";

      let isVerified = false;
      let isDead = false;

      if (type === "tv") {
        isVerified = hasCached;
        // Live (not dead) if at least one cached episode exists
        isDead = hasDead && !hasCached;
      } else {
        isVerified = hasCached;
        isDead = hasDead;
      }

      return {
        id,
        isVerified,
        isDead,
      };
    });

    res.json({ results });
  } catch (error) {
    res.status(500).json({ error: "Failed to check availability" });
  }
});

const playbackLimiterMap = new Map<string, number[]>();

// Prevent memory leak by periodically pruning inactive IP addresses from the rate limiter map
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of playbackLimiterMap.entries()) {
    const active = timestamps.filter((ts) => now - ts < 60000);
    if (active.length === 0) {
      playbackLimiterMap.delete(ip);
    } else if (active.length !== timestamps.length) {
      playbackLimiterMap.set(ip, active);
    }
  }
}, 300000).unref(); // Run every 5 minutes and allow process to exit cleanly

app.post("/api/stream/playback-success", express.json(), async (req, res) => {
  const { tmdbId, type, season: seasonVal, episode: episodeVal } = req.body;

  if (!tmdbId || !type) {
    return res.status(400).json({ error: "Missing tmdbId or type" });
  }

  if (type === "tv" && (seasonVal === undefined || episodeVal === undefined)) {
    return res
      .status(400)
      .json({ error: "Missing season or episode for TV show" });
  }

  const season = type === "tv" ? parseInt(seasonVal, 10) : 1;
  const episode = type === "tv" ? parseInt(episodeVal, 10) : 1;

  if (isNaN(season) || isNaN(episode)) {
    return res
      .status(400)
      .json({ error: "Invalid season or episode format (must be integer)" });
  }

  // 1. Sliding window rate limiter (max 5 requests per minute per IP)
  const ip = req.ip || "unknown";
  const now = Date.now();
  let timestamps = playbackLimiterMap.get(ip) || [];
  timestamps = timestamps.filter((ts) => now - ts < 60000);
  if (timestamps.length >= 5) {
    return res.status(429).json({
      error: "Too many playback success reports. Maximum 5 per minute.",
    });
  }
  timestamps.push(now);
  playbackLimiterMap.set(ip, timestamps);

  try {
    // 2. Validate that a matching StreamCache entry exists
    const cacheExists = await StreamCache.findOne({
      tmdbId: {
        $in: [tmdbId.toString(), `${tmdbId}-vidrock`, `${tmdbId}-videasy`],
      },
      type,
      season,
      episode,
    });

    if (!cacheExists) {
      return res.status(400).json({
        error: "No matching stream cache found. Playback success rejected.",
      });
    }

    // 3. Delete from Deadpool (logging warning on deletion error)
    await DeadPool.deleteOne({
      tmdbId: tmdbId.toString(),
      type,
      season,
      episode,
    }).catch((err) => {
      console.warn(
        `[DEADPOOL] Failed to delete entry on successful playback for ${tmdbId}:`,
        err,
      );
    });

    console.log(
      `[DEADPOOL] Removed dead entry on successful playback: ${tmdbId} ${type} S${season}E${episode}`,
    );
    return res.json({ success: true });
  } catch (error) {
    console.error("[DEADPOOL] Failed to process playback success:", error);
    return res.status(500).json({ error: "Failed to mark as live" });
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

// Endpoint: Image Proxy (Bypasses TMDB Blocks/CORS)
// Allowlist of domains the image proxy may fetch from.
// Prevents SSRF: attackers cannot use this to reach internal network endpoints.
const IMAGE_PROXY_ALLOWLIST = [
  "image.tmdb.org",
  "media.themoviedb.org",
  "assets.fanart.tv",
  "webservice.fanart.tv",
  "picsum.photos",
];

app.get("/api/image", async (req, res) => {
  const url = req.query.url as string;
  if (!url) return res.status(400).send("Missing url");

  // SSRF guard: only allow fetching from known media CDNs
  try {
    const parsed = new URL(url);
    const allowed = IMAGE_PROXY_ALLOWLIST.some(
      (domain) =>
        parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`),
    );
    if (!allowed) {
      console.warn(`[IMAGE] Blocked SSRF attempt: ${parsed.hostname}`);
      return res.status(403).send("Domain not allowed");
    }
  } catch {
    return res.status(400).send("Invalid url");
  }

  try {
    const agent = getSharedHardenedAgent();
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
  const cacheKey = `imdb-movie-${tmdbId}`;
  if (_externalIdCache.has(cacheKey)) return _externalIdCache.get(cacheKey)!;
  try {
    const res = await axios.get(
      `https://api.themoviedb.org/3/movie/${tmdbId}`,
      {
        headers: { Authorization: `Bearer ${TMDB_API_KEY}` },
      },
    );
    const id = res.data.imdb_id || null;
    _externalIdCache.set(cacheKey, id);
    return id;
  } catch (e) {
    return null;
  }
}

async function getTVDBId(tmdbId: string) {
  const cacheKey = `tvdb-${tmdbId}`;
  if (_externalIdCache.has(cacheKey)) return _externalIdCache.get(cacheKey)!;
  try {
    const res = await axios.get(
      `https://api.themoviedb.org/3/tv/${tmdbId}/external_ids`,
      {
        headers: { Authorization: `Bearer ${TMDB_API_KEY}` },
      },
    );
    const id = res.data.tvdb_id ? String(res.data.tvdb_id) : null;
    _externalIdCache.set(cacheKey, id);
    return id;
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

    // Save to Cache with Type (30-day TTL for stale art cleanup)
    await MetadataCache.findOneAndUpdate(
      { tmdbId, type },
      {
        logoUrl: hdLogo,
        backgroundUrl,
        logoFetchedAt: new Date(),
        type,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
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

// @ts-ignore
import { generateToken as generateVidrockToken } from "./utils/vidrock_token.js";
// @ts-ignore
import { fetchVideasySources } from "./utils/videasy.js";

app.get("/api/vidrock", async (req, res) => {
  const tmdbId = req.query.tmdbId as string;
  const type = req.query.type as "movie" | "tv";
  const seasonStr = req.query.season as string;
  const episodeStr = req.query.episode as string;

  if (!tmdbId || !type) {
    return res.status(400).json({ error: "Missing tmdbId or type" });
  }

  if (type === "tv" && (!seasonStr || !episodeStr)) {
    return res
      .status(400)
      .json({ error: "Missing season or episode for TV show" });
  }

  const season = type === "tv" ? parseInt(seasonStr, 10) : 1;
  const episode = type === "tv" ? parseInt(episodeStr, 10) : 1;

  if (isNaN(season) || isNaN(episode)) {
    return res
      .status(400)
      .json({ error: "Invalid season or episode format (must be integer)" });
  }

  try {
    const force = req.query.force === "1" || req.query.nocache === "1";

    // 1. Cache Check for VidRock
    const cachedRecord = force
      ? null
      : await StreamCache.findOne({
          tmdbId: `${tmdbId}-vidrock`,
          type,
          season,
          episode,
        }).catch(() => null);

    if (
      cachedRecord &&
      cachedRecord.mirrors &&
      cachedRecord.mirrors.length > 0
    ) {
      if (
        !cachedRecord.streamExpiresAt ||
        new Date() < cachedRecord.streamExpiresAt
      ) {
        console.log(
          `[VIDROCK] Cache HIT ✔ for ${tmdbId} S${season}E${episode}`,
        );
        const responseData: Record<string, any> = {};
        cachedRecord.mirrors.forEach((m: any) => {
          responseData[m.source] = {
            url: m.url,
            type: m.type || "hls",
          };
        });
        return res.json(responseData);
      }
    }

    const token = generateVidrockToken(tmdbId, type, season, episode);
    const url = `https://vidrock.ru/api/${type}/${token}`;
    const headers = {
      accept: "*/*",
      "accept-language": "en-US,en;q=0.9",
      "cache-control": "no-cache",
      pragma: "no-cache",
      referer: `https://vidrock.ru/${type}/${tmdbId}`,
      "sec-ch-ua": '"Chromium";v="148", "Brave";v="148", "Not/A)Brand";v="99"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      "sec-gpc": "1",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    };

    let fetchFinished = false;
    let fetchResult: any = null;

    const runScan = async () => {
      try {
        const response = await fetch(url, {
          headers,
          signal: AbortSignal.timeout(45000),
        });
        if (!response.ok) throw new Error(`HTTP error ${response.status}`);
        const data = await response.json();

        const activeSources = Object.entries(data)
          .filter(([_, v]: any) => v && v.url)
          .map(([name, v]: any) => ({
            source: name.startsWith("VidRock") ? name : `VidRock (${name})`,
            url: v.url,
            type: v.type || "hls",
          }));

        const firstActiveSource = activeSources[0];
        if (firstActiveSource) {
          const streamUrl = firstActiveSource.url;
          const sourceName = firstActiveSource.source;
          const cacheExpires = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes cache

          await StreamCache.findOneAndUpdate(
            { tmdbId: `${tmdbId}-vidrock`, type, season, episode },
            {
              streamUrl,
              source: sourceName,
              qualityTag: "HD",
              resolution: "1080p",
              mirrors: activeSources,
              streamExpiresAt: cacheExpires,
              expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
            },
            { upsert: true },
          );

          await DeadPool.deleteMany({
            tmdbId: { $in: [tmdbId.toString(), `${tmdbId}-vidrock`] },
            type,
            season,
            episode,
          }).catch(() => null);
        }

        const responseData: Record<string, any> = {};
        activeSources.forEach((m) => {
          responseData[m.source] = {
            url: m.url,
            type: m.type,
          };
        });

        fetchResult = responseData;
        fetchFinished = true;
        return responseData;
      } catch (err: any) {
        console.warn(
          `[VIDROCK] Background fetch failed for ${tmdbId}: ${err.message}`,
        );
        fetchFinished = true;
        return null;
      }
    };

    const scanPromise = runScan();
    const raceTimeout = new Promise<void>((resolve) => {
      setTimeout(resolve, 5000);
    });

    await Promise.race([scanPromise, raceTimeout]);

    if (fetchFinished && fetchResult) {
      res.json(fetchResult);
    } else {
      console.log(
        `[VIDROCK] Scrape took longer than 5s for ${tmdbId}. Returning empty, remaining scans running in bg...`,
      );
      res.json({});
    }
  } catch (error) {
    console.error("[VIDROCK] fetch failed", error);
    res.status(500).json({ error: "Failed to fetch from VidRock" });
  }
});

// Endpoint: Dynamic HLS Master Playlist generator for grouping different qualities of the same server
app.get("/api/videasy/master.m3u8", (req, res) => {
  const urlsParam = req.query.urls as string;
  const qualitiesParam = req.query.qualities as string;

  if (!urlsParam || !qualitiesParam) {
    return res.status(400).send("Missing urls or qualities");
  }

  try {
    const urls = urlsParam.split(",").map((url) => decodeURIComponent(url));
    const qualities = qualitiesParam.split(",");

    let m3u8 = "#EXTM3U\n#EXT-X-VERSION:3\n";

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      const q = qualities[i];
      if (!url || !q) continue;

      let bandwidth = 1000000;
      let resolution = "";
      const height = parseInt(q, 10);

      if (height === 1080) {
        bandwidth = 2800000;
        resolution = "1920x1080";
      } else if (height === 720) {
        bandwidth = 1400000;
        resolution = "1280x720";
      } else if (height === 480) {
        bandwidth = 800000;
        resolution = "854x480";
      } else if (height === 360) {
        bandwidth = 500000;
        resolution = "640x360";
      } else if (height === 240) {
        bandwidth = 300000;
        resolution = "426x240";
      } else {
        resolution = `unknownx${height}`;
      }

      const protocol = req.headers["x-forwarded-proto"] || req.protocol;
      const currentHost =
        process.env.API_URL || `${protocol}://${req.get("host")}`;
      const proxiedUrl = `${currentHost}/api/proxy/stream?url=${encodeURIComponent(url)}`;

      m3u8 += `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth}${resolution ? `,RESOLUTION=${resolution}` : ""},NAME="${height}p"\n`;
      m3u8 += `${proxiedUrl}\n`;
    }

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(m3u8);
  } catch (err: any) {
    res.status(500).send("Error generating master playlist");
  }
});

app.get("/api/videasy", async (req, res) => {
  const tmdbId = req.query.tmdbId as string;
  const type = req.query.type as "movie" | "tv";
  const seasonStr = req.query.season as string;
  const episodeStr = req.query.episode as string;
  const title = (req.query.title as string) || "";
  const releaseYear = (req.query.releaseYear as string) || "";

  if (!tmdbId || !type) {
    return res.status(400).json({ error: "Missing tmdbId or type" });
  }

  if (type === "tv" && (!seasonStr || !episodeStr)) {
    return res
      .status(400)
      .json({ error: "Missing season or episode for TV show" });
  }

  const season = type === "tv" ? parseInt(seasonStr, 10) : 1;
  const episode = type === "tv" ? parseInt(episodeStr, 10) : 1;

  if (isNaN(season) || isNaN(episode)) {
    return res
      .status(400)
      .json({ error: "Invalid season or episode format (must be integer)" });
  }

  try {
    const force = req.query.force === "1" || req.query.nocache === "1";

    // 1. Cache Check for Videasy
    const cachedRecord = force
      ? null
      : await StreamCache.findOne({
          tmdbId: `${tmdbId}-videasy`,
          type,
          season,
          episode,
        }).catch(() => null);

    if (
      cachedRecord &&
      cachedRecord.mirrors &&
      cachedRecord.mirrors.length > 0
    ) {
      if (
        !cachedRecord.streamExpiresAt ||
        new Date() < cachedRecord.streamExpiresAt
      ) {
        console.log(
          `[VIDEASY] Cache HIT ✔ for ${tmdbId} S${season}E${episode}`,
        );
        const protocol = req.headers["x-forwarded-proto"] || req.protocol;
        const currentHost =
          process.env.API_URL || `${protocol}://${req.get("host")}`;

        const responseData: Record<string, any> = {};
        cachedRecord.mirrors.forEach((m: any) => {
          let url = m.url;
          if (url.startsWith("/")) {
            url = `${currentHost}${url}`;
          }
          responseData[m.source] = {
            url: url,
            type: m.type || "hls",
            audio: m.audio || "",
            flag: m.flag || "us",
          };
        });
        return res.json(responseData);
      }
    }

    // 2. Fetch from Videasy providers
    const activeMirrors = await fetchVideasySources(
      title,
      type,
      releaseYear,
      tmdbId,
      season,
      episode,
    );

    // Cache is updated incrementally per provider inside fetchVideasySources.
    // Clean up DeadPool if any mirrors were found during the 5s race
    if (Object.keys(activeMirrors).length > 0) {
      await DeadPool.deleteMany({
        tmdbId: { $in: [tmdbId.toString(), `${tmdbId}-videasy`] },
        type,
        season,
        episode,
      }).catch(() => null);
    }

    const protocol = req.headers["x-forwarded-proto"] || req.protocol;
    const currentHost =
      process.env.API_URL || `${protocol}://${req.get("host")}`;
    const responseData: Record<string, any> = {};
    Object.entries(activeMirrors).forEach(([key, val]: any) => {
      let url = val.url;
      if (url.startsWith("/")) {
        url = `${currentHost}${url}`;
      }
      responseData[key] = {
        ...val,
        url,
      };
    });
    res.json(responseData);
  } catch (error) {
    console.error("[VIDEASY] fetch failed", error);
    res.status(500).json({ error: "Failed to fetch from Videasy" });
  }
});

// ── /api/vidlink — Standalone VidLink scan (mirrors /api/vidrock pattern) ──
app.get("/api/vidlink", async (req, res) => {
  const tmdbId = req.query.tmdbId as string;
  const type = req.query.type as "movie" | "tv";
  const seasonStr = req.query.season as string;
  const episodeStr = req.query.episode as string;

  if (!tmdbId || !type) {
    return res.status(400).json({ error: "Missing tmdbId or type" });
  }

  if (type === "tv" && (!seasonStr || !episodeStr)) {
    return res
      .status(400)
      .json({ error: "Missing season or episode for TV show" });
  }

  const season = type === "tv" ? parseInt(seasonStr, 10) : 1;
  const episode = type === "tv" ? parseInt(episodeStr, 10) : 1;

  if (isNaN(season) || isNaN(episode)) {
    return res
      .status(400)
      .json({ error: "Invalid season or episode format (must be integer)" });
  }

  try {
    const force = req.query.force === "1" || req.query.nocache === "1";

    // 1. Cache check — reuse the main StreamCache entry (source "VidLink")
    const cachedRecord = force
      ? null
      : await StreamCache.findOne({
          tmdbId: tmdbId.toString(),
          type,
          season,
          episode,
        }).catch(() => null);

    if (
      cachedRecord &&
      cachedRecord.mirrors &&
      cachedRecord.mirrors.length > 0
    ) {
      const vidlinkMirrors = cachedRecord.mirrors.filter(
        (m: any) => m.source === "VidLink",
      );
      if (
        vidlinkMirrors.length > 0 &&
        (!cachedRecord.streamExpiresAt ||
          new Date() < cachedRecord.streamExpiresAt)
      ) {
        console.log(
          `[VIDLINK] Cache HIT ✔ for ${tmdbId} S${season}E${episode}`,
        );
        const responseData: Record<string, any> = {};
        vidlinkMirrors.forEach((m: any, i: number) => {
          const key = m.quality
            ? `VidLink (${m.quality})`
            : i === 0
              ? "VidLink"
              : `VidLink_${i}`;
          responseData[key] = {
            url: m.url,
            type: m.type || "hls",
            quality: m.quality || "Auto",
          };
        });
        return res.json(responseData);
      }
    }

    // 2. Live scrape — race against 10s timeout
    let fetchFinished = false;
    let fetchResult: any = null;

    const runScan = async () => {
      try {
        const mirrors = await VidLinkScraper.getStream(
          tmdbId,
          type,
          season,
          episode,
        );
        fetchFinished = true;
        if (!mirrors || mirrors.length === 0) return null;

        // Build response object
        const responseData: Record<string, any> = {};
        mirrors.forEach((m, i) => {
          const key = m.quality
            ? `VidLink (${m.quality})`
            : i === 0
              ? "VidLink"
              : `VidLink_${i}`;
          responseData[key] = {
            url: m.url,
            type: m.type || "hls",
            quality: m.quality || "Auto",
          };
        });

        // Save to cache under main tmdbId exactly like /api/stream does
        const firstMirror = mirrors[0];
        if (firstMirror) {
          const streamUrl = firstMirror.url;
          const sourceName = firstMirror.source || "VidLink";
          const resolution = firstMirror.quality || "1080p";
          const qualityTag = resolution.includes("2160") ? "4K" : "HD";

          const cacheExpires = new Date();
          cacheExpires.setHours(cacheExpires.getHours() + 4);

          await StreamCache.findOneAndUpdate(
            { tmdbId: tmdbId.toString(), type, season, episode },
            {
              streamUrl,
              source: sourceName,
              qualityTag,
              resolution,
              mirrors,
              streamExpiresAt: cacheExpires,
              expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
            },
            { upsert: true },
          );

          await DeadPool.deleteMany({
            tmdbId: { $in: [tmdbId.toString()] },
            type,
            season,
            episode,
          }).catch(() => null);
        }

        fetchResult = responseData;
        return responseData;
      } catch (err: any) {
        console.warn(`[VIDLINK] Scan failed for ${tmdbId}: ${err.message}`);
        fetchFinished = true;
        return null;
      }
    };

    const scanPromise = runScan();
    const raceTimeout = new Promise<void>((resolve) =>
      setTimeout(resolve, 5000),
    );

    await Promise.race([scanPromise, raceTimeout]);

    if (fetchFinished && fetchResult) {
      res.json(fetchResult);
    } else {
      console.log(
        `[VIDLINK] Scan took longer than 5s for ${tmdbId}. Returning empty, remaining scan running in bg...`,
      );
      res.json({});
    }
  } catch (error) {
    console.error("[VIDLINK] fetch failed", error);
    res.status(500).json({ error: "Failed to fetch from VidLink" });
  }
});

const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, () => {
  console.log(`Nebula Backend Array active on http://localhost:${PORT}`);
  console.log(
    `Modes: Fanart [${FANART_API_KEY === "your_fanart_api_key_here" ? "DISABLED" : "ACTIVE"}], Scraper [ACTIVE]`,
  );
});

// ── Graceful Shutdown ────────────────────────────────────────────────────────
// systemd / pm2 sends SIGTERM before stopping the process on Oracle Ubuntu.
// We stop accepting new connections, disconnect from DB, stop CycleTLS, and exit.
async function handleGracefulShutdown(signal: string) {
  console.log(`[SHUTDOWN] ${signal} received — starting clean shutdown...`);

  // 1. Stop CycleTLS Go helper binary
  await shutdownCycleTLS();

  // 2. Disconnect Mongoose/MongoDB pool cleanly
  if (mongoose.connection.readyState !== 0) {
    console.log("[SHUTDOWN] Closing database connection...");
    try {
      await mongoose.connection.close();
      console.log("[SHUTDOWN] Database connection closed.");
    } catch (err: any) {
      console.error("[SHUTDOWN] Error closing database:", err.message);
    }
  }

  // 3. Close Express server and drain connections
  server.close(() => {
    console.log("[SHUTDOWN] All connections closed. Exiting cleanly.");
    process.exit(0);
  });

  // Force-exit after 10s if connections or sockets hang
  setTimeout(() => {
    console.error("[SHUTDOWN] Force exit after 10s drain timeout.");
    process.exit(1);
  }, 10_000);
}

process.on("SIGTERM", () => handleGracefulShutdown("SIGTERM"));
process.on("SIGINT", () => handleGracefulShutdown("SIGINT"));
