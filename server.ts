import express from "express";
import cors from "cors";
import mongoose from "mongoose";
import dotenv from "dotenv";
import axios from "axios";
import { MetadataCache } from "./models/Cache.js";
import { scrapeVsembed, startHeartbeat, stopHeartbeat } from "./utils/scraper.js";

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
    const cachedRecord = await MetadataCache.findOne({ tmdbId, type: kind }).catch(() => null);
    if (cachedRecord?.streamUrl && cachedRecord?.streamExpiresAt) {
      if (new Date() < cachedRecord.streamExpiresAt) {
        console.log(`[STREAM] Cache HIT for ${tmdbId}`);
        return res.json({ streamUrl: cachedRecord.streamUrl, source: "cache" });
      }
    }

    // 2. Run the 4-layer vsembed → cloudnestra → m3u8 scraper
    console.log(`[STREAM] Scraping "${title}" (${kind}) tmdbId=${tmdbId} via ${VIDSRC_EMBED_HOST}`);
    const result = await scrapeVsembed(tmdbId, kind, VIDSRC_EMBED_HOST, season, episode);

    // Use the first (best) stream URL
    const extractedUrl = result.streams[0];
    const sourceName   = result.source;

    // 3. Cache the result for 4 hours
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 4);
    await MetadataCache.findOneAndUpdate(
      { tmdbId, type: kind },
      { streamUrl: extractedUrl, streamExpiresAt: expiresAt },
      { upsert: true },
    ).catch(() => null);

    // 4. Start heartbeat ping loop to keep the stream alive for 60s intervals
    startHeartbeat(tmdbId, result.session);

    console.log(`[STREAM] ✔ Success via ${sourceName}: ${extractedUrl.substring(0, 80)}...`);
    return res.json({ streamUrl: extractedUrl, source: sourceName });

  } catch (error: any) {
    console.error(`[STREAM] ✘ Failed for tmdbId=${tmdbId}: ${error.message}`);
    return res.status(404).json({ error: error.message || "No stream sources found." });
  }
});

// Endpoint: Stop stream heartbeat (call when player closes/user leaves)
app.get("/api/stream/stop", (req, res) => {
  const tmdbId = req.query.tmdbId as string;
  if (!tmdbId) return res.status(400).json({ error: "Missing tmdbId" });
  stopHeartbeat(tmdbId);
  return res.json({ ok: true });
});

// Endpoint: Flush stream cache (force re-scrape on next play)
app.post("/api/stream/flush", async (req, res) => {
  const tmdbId = req.body?.tmdbId as string;
  if (!tmdbId) return res.status(400).json({ error: "Missing tmdbId" });
  await MetadataCache.findOneAndUpdate(
    { tmdbId },
    { streamUrl: null, streamExpiresAt: null },
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
const PROXY_UA    = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function cdnHeaders(referer = CDN_REFERER) {
  return {
    "User-Agent": PROXY_UA,
    "Referer":    referer,
    "Origin":     new URL(referer).origin,
  };
}

// Proxy: .m3u8 manifest — fetches and rewrites segment/variant URLs
app.get("/api/proxy/stream", async (req, res) => {
  const raw = req.query.url as string;
  if (!raw) return res.status(400).send("Missing url");

  let targetUrl: string;
  try { targetUrl = decodeURIComponent(raw); }
  catch { return res.status(400).send("Invalid url encoding"); }

  try {
    const upstream = await axios.get(targetUrl, {
      headers: cdnHeaders(),
      responseType: "text",
      timeout: 15000,
    });

    const manifest: string = upstream.data;
    // Rewrite every URL in the manifest through our proxy
    const proxified = manifest
      .split("\n")
      .map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) {
          // Rewrite URI= attributes inside tags (e.g. #EXT-X-KEY:URI="...")
          return line.replace(/URI="([^"]+)"/g, (_match, uri) => {
            const abs = new URL(uri, targetUrl).href;
            return `URI="http://localhost:${process.env.PORT || 4000}/api/proxy/segment?url=${encodeURIComponent(abs)}"`;
          });
        }
        // Segment lines / variant playlist lines
        const abs = new URL(trimmed, targetUrl).href;
        const ext = trimmed.split("?")[0];
        // .m3u8 sub-playlists go through /stream, .ts/.aac go through /segment
        if (ext.endsWith(".m3u8")) {
          return `http://localhost:${process.env.PORT || 4000}/api/proxy/stream?url=${encodeURIComponent(abs)}`;
        }
        return `http://localhost:${process.env.PORT || 4000}/api/proxy/segment?url=${encodeURIComponent(abs)}`;
      })
      .join("\n");

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-cache");
    return res.send(proxified);

  } catch (e: any) {
    console.error(`[PROXY] manifest error: ${e.message}`);
    return res.status(502).send("Proxy upstream error");
  }
});

// Proxy: raw segment / AES key — pass-through binary stream
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
        const [id, type] = combo.split(":");
        const meta = await getFanartMetadata(id, (type as any) || "movie");
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
