import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import dotenv from "dotenv";
import axios from "axios";
import fs from "fs";
import { MetadataCache, StreamCache, SubtitleCache } from "./models/Cache.js";
import { getSubtitles } from "./utils/subtitles.js";
import { scrapeVsembed, startHeartbeat, stopHeartbeat, UA } from "./utils/scraper.js";
import { HttpsProxyAgent } from "https-proxy-agent";
import { HttpCookieAgent, HttpsCookieAgent, createCookieAgent } from "http-cookie-agent/http";
import { CookieJar } from "tough-cookie";

// Load Environment Variables
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Initialize MongoDB
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017/nebula-local";
const FANART_API_KEY = process.env.FANART_API_KEY || "";
const TMDB_API_KEY = process.env.TMDB_API_KEY || "";

// VidSrc embed host — swap VIDSRC_EMBED_HOST in .env if the domain changes
const VIDSRC_EMBED_HOST = (process.env.VIDSRC_EMBED_HOST || "https://vsembed.ru").replace(/\/$/, "");

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
      console.log(`[PROXY] Pool loaded: ${proxyPool.length} proxies available.`);
    } catch (e: any) {
      console.error(`[PROXY] Failed to parse ${PROXIES_FILE}:`, e.message);
    }
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
  const tmdbId    = req.query.tmdbId as string;
  const kind      = req.query.type as "movie" | "tv";
  const title     = (req.query.title as string) || "";
  const season    = parseInt((req.query.season as string) || "1", 10);
  const episode   = parseInt((req.query.episode as string) || "1", 10);

  if (!tmdbId || !kind) {
    return res.status(400).json({ error: "Missing tmdbId or type" });
  }

  try {
    // 1. Check the stream cache first (expires every 4 hours)
    const cachedRecord = await StreamCache.findOne({ tmdbId, type: kind, season, episode }).catch(() => null);
    if (cachedRecord?.streamUrl && cachedRecord?.streamExpiresAt) {
      if (new Date() < cachedRecord.streamExpiresAt) {
        // Liveness check — probe the .m3u8 with a HEAD request to confirm the token is still valid.
        // Cloudnestra tokens can die early (IP rotation, CDN purge). If dead, fall through to re-scrape.
        let linkAlive = false;
        try {
          const probe = await axios.head(cachedRecord.streamUrl, {
            timeout: 4000,
            headers: {
              'User-Agent': 'Mozilla/5.0',
              'Referer': 'https://cloudnestra.com/',
            },
            validateStatus: (s) => s < 400,
          });
          linkAlive = probe.status < 400;
        } catch {
          linkAlive = false;
        }

        if (linkAlive) {
          console.log(`[STREAM] Cache HIT ✔ (link alive) for ${tmdbId} S${season}E${episode}`);
          return res.json({
            streamUrl: cachedRecord.streamUrl,
            source: cachedRecord.source || 'cache',
            qualityTag: cachedRecord.qualityTag || 'UNKNOWN',
            resolution: cachedRecord.resolution || 'UNKNOWN',
          });
        } else {
          console.warn(`[STREAM] Cache HIT ✘ (dead token) for ${tmdbId} — re-scraping...`);
          // Invalidate the dead record immediately so the TTL index doesn't hold it longer
          await StreamCache.findOneAndUpdate(
            { tmdbId, type: kind, season, episode },
            { streamUrl: null, streamExpiresAt: new Date(0) },
          ).catch(() => null);
        }
      }
    }

    // 2. Run the 4-layer vsembed → cloudnestra → m3u8 scraper
    let prioritizedProxy = (RESIDENTIAL_PROXY && (Date.now() > residentialProxyCooldown)) 
      ? getStickyProxy(RESIDENTIAL_PROXY)
      : getRandomProxy();
      
    let result;

    try {
      const proxyLabel = prioritizedProxy === RESIDENTIAL_PROXY ? 'RESIDENTIAL' : (prioritizedProxy?.includes('sessid') ? 'RESIDENTIAL-STICKY' : (prioritizedProxy || 'NONE'));
      console.log(`[STREAM] Scraping "${title}" (${kind}) tmdbId=${tmdbId} S${season}E${episode} via ${VIDSRC_EMBED_HOST} (Proxy: ${proxyLabel})`);
      result = await scrapeVsembed(tmdbId, kind, VIDSRC_EMBED_HOST, season, episode, prioritizedProxy);
    } catch (error: any) {
      // ── Fallback Tier ──────────────────────────────────────────────────────
      const isFallbackPossible = prioritizedProxy === RESIDENTIAL_PROXY; // If we tried residential first, fallback to pool
      
      if (isFallbackPossible) {
        const fallbackProxy = getRandomProxy();
        console.warn(`[STREAM] Residential Proxy FAILED (${error.message}). Falling back to Pool Proxy...`);
        try {
          result = await scrapeVsembed(tmdbId, kind, VIDSRC_EMBED_HOST, season, episode, fallbackProxy);
          console.log(`[STREAM] Pool Fallback SUCCESS!`);
        } catch (poolError: any) {
          console.error(`[STREAM] Pool Proxy ALSO FAILED: ${poolError.message}`);
          throw poolError;
        }
      } else {
        throw error;
      }
    }

    // Use the first (best) stream URL
    const extractedUrl = result.streams[0];
    const sourceName   = result.source;

    // 3. Cache the result for 4 hours
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 4);
    await StreamCache.findOneAndUpdate(
      { tmdbId, type: kind, season, episode },
      {
        streamUrl: extractedUrl,
        source: sourceName,
        qualityTag: result.qualityTag,
        resolution: result.resolution,
        streamExpiresAt: expiresAt,
      },
      { upsert: true },
    ).catch(() => null);

    // 4. Start heartbeat ping loop to keep the stream alive for 60s intervals
    startHeartbeat(tmdbId, result.session, result.proxyUsed, req.ip);

    console.log(`[STREAM] ✔ Success via ${sourceName} [${result.qualityTag} ${result.resolution}]: ${(extractedUrl ?? "").substring(0, 80)}...`);
    
    // Add the proxy used to the streamUrl so the HLS proxy can use it for the manifest.
    let streamUrl = extractedUrl;
    if (result.proxyUsed && streamUrl) {
      const urlObj = new URL(streamUrl);
      urlObj.searchParams.set("nebula_proxy", result.proxyUsed);
      streamUrl = urlObj.href;
    }

    return res.json({ streamUrl, source: sourceName, qualityTag: result.qualityTag, resolution: result.resolution });

  } catch (error: any) {
    console.error(`[STREAM] ✘ Failed for tmdbId=${tmdbId}: ${error.message}`);
    return res.status(404).json({ error: error.message || "No stream sources found." });
  }
});

// Endpoint: TV Show Details (episode counts per season)
// Proxies TMDB so the API key never lives in the frontend bundle.
app.get("/api/tv-details/:tmdbId", async (req, res) => {
  const { tmdbId } = req.params;
  if (!TMDB_API_KEY) return res.status(500).json({ error: "TMDB_API_KEY not configured" });
  try {
    const r = await axios.get(`https://api.themoviedb.org/3/tv/${tmdbId}`, {
      params: { api_key: TMDB_API_KEY },
      timeout: 8000,
    });
    return res.json(r.data);
  } catch (err: any) {
    return res.status(err.response?.status || 500).json({ error: err.message });
  }
});

// Endpoint: Fetch Subtitles (Lazy Load / Aggregated Background Request)
app.get("/api/subtitles", async (req, res) => {
  const tmdbId  = req.query.tmdbId as string;
  const kind    = req.query.type as "movie" | "tv";
  const season  = parseInt((req.query.season as string) || "1", 10);
  const episode = parseInt((req.query.episode as string) || "1", 10);

  if (!tmdbId || !kind) {
    return res.status(400).json({ error: "Missing tmdbId or type" });
  }

  try {
    // 1. Check permanent cache first
    const cached = await SubtitleCache.findOne({ tmdbId, type: kind, season, episode });
    if (cached && cached.subtitles?.length > 0) {
      console.log(`[SUBS] Cache HIT for ${tmdbId} S${season}E${episode}`);
      return res.json({ subtitles: cached.subtitles });
    }

    // 2. Aggregate from trackers in parallel
    console.log(`[SUBS] Aggregating tracks for ${tmdbId} S${season}E${episode}...`);
    
    // Using allSettled so one tracker failing doesn't kill the whole request
    const results = await Promise.allSettled([
      getSubtitles(tmdbId, kind, season, episode),
      // Future trackers (e.g. Subscene, OpenSubtitles Direct) would go here
    ]);

    const aggregated = results
      .filter(r => r.status === "fulfilled")
      .flatMap(r => (r as PromiseFulfilledResult<any[]>).value);

    // 3. Save to permanent cache
    if (aggregated.length > 0) {
      await SubtitleCache.findOneAndUpdate(
        { tmdbId, type: kind, season, episode },
        { subtitles: aggregated, aggregatedAt: new Date() },
        { upsert: true }
      ).catch(() => null);
    }

    return res.json({ subtitles: aggregated });
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

function cdnHeaders(referer = CDN_REFERER) {
  return {
    "User-Agent": UA,
    "Referer":    referer,
    "Origin":     new URL(referer).origin,
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
  };
}

// Proxy: .m3u8 manifest — fetches and rewrites segment/variant URLs
app.get("/api/proxy/stream", async (req, res) => {
  const raw = req.query.url as string;
  if (!raw) return res.status(400).send("Missing url");

  let targetUrl: string;
  try { targetUrl = decodeURIComponent(raw); }
  catch { return res.status(400).send("Invalid url encoding"); }

  // Extract proxy from two possible locations:
  // 1. Baked into the target CDN URL as ?nebula_proxy=... (master playlist, set by /api/stream)
  // 2. As a direct query param of this endpoint (?nebula_proxy=...) (variant sub-playlists, set by withProxy())
  let streamProxy: string | undefined;

  // Check direct request param first (variant playlists)
  const directProxy = req.query.nebula_proxy as string | undefined;
  if (directProxy) {
    try { streamProxy = decodeURIComponent(directProxy); } catch {}
  }

  // Fall back to baked-in param inside the target URL (master playlist)
  if (!streamProxy) {
    try {
      const urlObj = new URL(targetUrl);
      const baked = urlObj.searchParams.get("nebula_proxy");
      if (baked) {
        streamProxy = baked;
        urlObj.searchParams.delete("nebula_proxy");
        targetUrl = urlObj.href;
      }
    } catch {}
  }

  console.log(`[PROXY/stream] ▶ ${targetUrl.substring(0, 80)} | proxy=${streamProxy ? "YES" : "NONE"}`);

  try {
    const config: any = {
      headers: cdnHeaders(),
      responseType: "text",
      timeout: 15000,
    };

    // Use the proxy for the manifest if one was used for the scrape (satisfies CDN IP check)
    if (streamProxy) {
      const safeProxy = streamProxy.endsWith("/") ? streamProxy.slice(0, -1) : streamProxy;
      const JarlessHttpsCookieProxyAgent = createCookieAgent(HttpsProxyAgent);
      const agent = new JarlessHttpsCookieProxyAgent(safeProxy, { cookies: { jar: new CookieJar() as any } });
      config.httpAgent = agent;
      config.httpsAgent = agent;
      console.log(`[PROXY/stream] Using residential proxy: ${safeProxy.substring(0, 40)}...`);
    } else {
      console.log(`[PROXY/stream] ⚠ No proxy — CDN may reject if IP differs from scrape`);
    }

    const upstream = await axios.get(targetUrl, config);

    const manifest: string = upstream.data;

    // Build a helper that appends the proxy to a rewritten URL so every
    // sub-playlist / segment request goes through the same residential IP.
    const withProxy = (endpoint: string, encodedUrl: string) => {
      if (streamProxy) {
        return `${endpoint}?url=${encodedUrl}&nebula_proxy=${encodeURIComponent(streamProxy!)}`;
      }
      return `${endpoint}?url=${encodedUrl}`;
    };

    // Rewrite every URL in the manifest through our proxy
    const proxified = manifest
      .split("\n")
      .map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
          // Rewrite URI= attributes inside tags (e.g. #EXT-X-KEY:URI="...")
          return line.replace(/URI="([^"]+)"/g, (_match, uri) => {
            const abs = new URL(uri, targetUrl!).href;
            return `URI="${withProxy("/api/proxy/segment", encodeURIComponent(abs))}"`;
          });
        }
        // Segment lines / variant playlist lines
        const variantUrl = trimmed.trim();
        if (!variantUrl || !targetUrl) return "";
        const abs = new URL(variantUrl, targetUrl!).href;
        const extMatch = (variantUrl.split("?")[0] || "").split(".").pop() || "";
        // .m3u8 sub-playlists go through /stream, .ts/.aac go through /segment
        if (extMatch === "m3u8") {
          return withProxy("/api/proxy/stream", encodeURIComponent(abs));
        }
        return withProxy("/api/proxy/segment", encodeURIComponent(abs));
      })
      .join("\n");

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-cache");
    return res.send(proxified);

  } catch (e: any) {
    const status = e?.response?.status ?? "no-response";
    const body = String(e?.response?.data ?? "").substring(0, 200);
    const url = targetUrl.substring(0, 100);
    console.error(`[PROXY/stream] ✘ ${status} | proxy=${streamProxy ? "YES" : "NONE"} | url=${url}`);
    if (body) console.error(`[PROXY/stream] CDN response: ${body}`);
    return res.status(502).send("Proxy upstream error");
  }
});


// Proxy: raw segment / AES key — pass-through binary stream (NO residential proxy — segments are CDN-direct to preserve data limits)
app.get("/api/proxy/segment", async (req, res) => {
  const raw = req.query.url as string;
  if (!raw) return res.status(400).send("Missing url");

  let targetUrl: string;
  try { targetUrl = decodeURIComponent(raw); }
  catch { return res.status(400).send("Invalid url encoding"); }

  try {
    const upstream = await axios.get(targetUrl, {
      headers: cdnHeaders(),
      responseType: "arraybuffer",
      timeout: 30000,
    });

    const ct = upstream.headers["content-type"] || "video/mp2t";
    res.setHeader("Content-Type", ct);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.send(Buffer.from(upstream.data));

  } catch (e: any) {
    console.error(`[PROXY] segment error: ${targetUrl.substring(0, 80)} — ${e.message}`);
    return res.status(502).send("Proxy segment error");
  }
});

app.post("/api/cache/clear", async (req, res) => {
  try {
    await MetadataCache.deleteMany({});
    console.log("Metadata Cache Flushed Successfully");
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

// Endpoint: Image Proxy (Bypasses TMDB Blocks/CORS)
app.get("/api/image", async (req, res) => {
  const url = req.query.url as string;
  if (!url) return res.status(400).send("Missing url");

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error("Proxy upstream error");
    const arrayBuffer = await response.arrayBuffer();

    // Pass along content type
    const contentType = response.headers.get("content-type");
    if (contentType) res.setHeader("Content-Type", contentType);

    // Add long caching
    res.setHeader("Cache-Control", "public, max-age=31536000");

    res.end(Buffer.from(arrayBuffer));
  } catch (e: any) {
    res.status(500).send("Image proxy failed");
  }
});

async function getIMDBId(tmdbId: string) {
  try {
    const res = await fetch(`https://api.themoviedb.org/3/movie/${tmdbId}`, {
      headers: { Authorization: `Bearer ${TMDB_API_KEY}` },
    });
    const data = await res.json();
    return data.imdb_id;
  } catch (e) {
    return null;
  }
}

async function getTVDBId(tmdbId: string) {
  try {
    const res = await fetch(
      `https://api.themoviedb.org/3/tv/${tmdbId}/external_ids`,
      {
        headers: { Authorization: `Bearer ${TMDB_API_KEY}` },
      },
    );
    const data = await res.json();
    return data.tvdb_id;
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
    return { logoUrl: cached.logoUrl, backgroundUrl: cached.backgroundUrl };
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

    let raw = await fetch(fanartUrl);
    let data = await raw.json();

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
        (a, b) => (parseInt(b.likes) || 0) - (parseInt(a.likes) || 0),
      );

    if (type === "tv") {
      const hdtvlogo = sortByLikes(data.hdtvlogo);
      const clearlogo = sortByLikes(data.clearlogo);
      const logoChoices = [...hdtvlogo, ...clearlogo];

      if (logoChoices.length > 0) {
        // Priority: English -> Neutral -> Most Liked
        const preferred =
          logoChoices.find((l: any) => l.lang === "en") ||
          logoChoices.find(
            (l: any) => !l.lang || l.lang === "00" || l.lang === "",
          ) ||
          logoChoices[0];
        hdLogo = preferred.url;
      }

      // Fixed Priority (Sorted by Likes): ShowBackground -> TVBackground -> Thumb
      const selection = data.showbackground?.length
        ? { url: sortByLikes(data.showbackground)[0].url, cat: "show-bg" }
        : data.tvbackground?.length
          ? { url: sortByLikes(data.tvbackground)[0].url, cat: "tv-bg" }
          : data.tvthumb?.length
            ? { url: sortByLikes(data.tvthumb)[0].url, cat: "thumb" }
            : null;

      if (selection) {
        backgroundUrl = selection.url;
      }
    } else {
      const hdmovielogo = sortByLikes(data.hdmovielogo);
      const movielogo = sortByLikes(data.movielogo);
      const hdmovieclearlogo = sortByLikes(data.hdmovieclearlogo);
      const movieclearlogo = sortByLikes(data.movieclearlogo);

      const logoChoices = [
        ...hdmovielogo,
        ...movielogo,
        ...hdmovieclearlogo,
        ...movieclearlogo,
      ];

      if (logoChoices.length > 0) {
        // Priority: English -> Neutral -> Most Liked
        const preferred =
          logoChoices.find((l: any) => l.lang === "en") ||
          logoChoices.find(
            (l: any) => !l.lang || l.lang === "00" || l.lang === "",
          ) ||
          logoChoices[0];
        hdLogo = preferred.url;
      }

      // Fixed Priority (Sorted by Likes): MovieBackground -> MovieThumb -> MovieBanner (Banners last due to ratio)
      const selection = data.moviebackground?.length
        ? { url: sortByLikes(data.moviebackground)[0].url, cat: "movie-bg" }
        : data.moviethumb?.length
          ? { url: sortByLikes(data.moviethumb)[0].url, cat: "movie-thumb" }
          : data.moviebanner?.length
            ? { url: sortByLikes(data.moviebanner)[0].url, cat: "movie-banner" }
            : null;

      if (selection) {
        backgroundUrl = selection.url;
      }
    }

    // Save to Cache with Type
    await MetadataCache.findOneAndUpdate(
      { tmdbId, type },
      { logoUrl: hdLogo, backgroundUrl, logoFetchedAt: new Date(), type },
      { upsert: true },
    ).catch(() => null);

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
