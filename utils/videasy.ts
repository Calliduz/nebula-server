import { fetchWithGotScraping } from "./bypass.js";
import { StreamCache, DeadPool, FailedProvider } from "../models/Cache.js";
import { fetchImdbId } from "./subtitles.js";

const b = [
  1116352408, 1899447441, 3049323471, 3921009573, 961987163, 1508970993,
  2453635748, 2870763221, 3624381080, 310598401, 607225278, 1426881987,
  1925078388, 2162078206, 2614888103, 3248222580,
];
const f = [109, 118, 109, 49]; // "mvm1"

const I = (e: number) => ((e * (e + 1)) & 1) === 0;

function w(e: number): number {
  e >>>= 0;
  e ^= e >>> 16;
  e = Math.imul(e, 2246822507) >>> 0;
  e ^= e >>> 13;
  e = Math.imul(e, 3266489909) >>> 0;
  return (e ^= e >>> 16) >>> 0;
}

function y(e: number, t: number): number {
  e >>>= 0;
  t &= 31;
  if (t === 0) return e >>> 0;
  return ((e << t) | (e >>> (32 - t))) >>> 0;
}

function base64ToBytes(e: string): Uint8Array {
  const t = e
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(4 * Math.ceil(e.length / 4), "=");
  return new Uint8Array(Buffer.from(t, "base64"));
}

export function decryptSources(
  ciphertext: string,
  seed: string,
  tmdbId: string,
): any {
  const o = base64ToBytes(ciphertext);

  const state = (() => {
    const s = Array(61);
    const seedHash = (() => {
      let t = 2166136261;
      for (let i = 0; i < seed.length; i++) {
        t = Math.imul(t ^ seed.charCodeAt(i), 16777619) >>> 0;
      }
      return w(t);
    })();

    let a = w(seedHash ^ w((parseInt(tmdbId, 10) >>> 0) ^ 2654435769)) >>> 0;

    for (let e = 0; e < 8; e++) {
      if (I(e)) {
        const t = a % 61;
        a = y((a + 2654435769) >>> 0, 7 + (7 & e));
        s[t] = (a ^ w(a)) >>> 0;
        a = w((a + t) >>> 0);
      } else {
        s[e] = b[15 & e];
      }
    }

    return {
      S: s,
      acc: w(2779096485 ^ a) >>> 0,
    };
  })();

  function nextWord(stateObj: any, index: number): number {
    const oArr = stateObj.S;
    let r = stateObj.acc;
    const n = r % 61;
    const i = 0 - Number(n in oArr);
    const d = oArr[n] >>> 0;

    const s_val = r;
    const a_val = (d ^ (Math.imul(2654435769, index + 1) >>> 0)) >>> 0;
    let l_val = ((s_val ^ a_val) >>> 0) | ((s_val & a_val & i) >>> 0);

    l_val = (y((l_val + r) >>> 0, 31 & n) ^ y(r, 31 & Math.imul(n, 7))) >>> 0;
    r = w((l_val + 2654435769) >>> 0);
    oArr[n] = r >>> 0;
    stateObj.acc = r;
    return r >>> 0;
  }

  const keyBytes = new Uint8Array(o.length);
  let keyIndex = 0;
  for (let e = 0; e < o.length; ) {
    const t = nextWord(state, keyIndex++);
    keyBytes[e++] = t & 255;
    if (e < o.length) keyBytes[e++] = (t >>> 8) & 255;
    if (e < o.length) keyBytes[e++] = (t >>> 16) & 255;
    if (e < o.length) keyBytes[e++] = (t >>> 24) & 255;
  }

  for (let e = 0; e < o.length; e++) {
    const ob = o[e];
    const kb = keyBytes[e];
    if (ob !== undefined && kb !== undefined) {
      o[e] = ob ^ kb;
    }
  }

  for (let e = 0; e < f.length; e++) {
    const ob = o[e];
    const fb = f[e];
    if (ob === undefined || fb === undefined || ob !== fb) {
      throw new Error("decrypt failed: bad seed or tampered payload");
    }
  }

  const payload = o.subarray(f.length);
  const pt = new TextDecoder("utf-8").decode(payload);
  return JSON.parse(pt);
}

let decryptionQueue = Promise.resolve();

export async function decryptSourcesSerialized(
  ciphertextHex: string,
  seed: string,
  tmdbId: string,
): Promise<any> {
  const result = decryptionQueue.then(async () => {
    // Yield to the event loop to let database heartbeats & HTTP I/O process
    await new Promise((resolve) => setImmediate(resolve));
    return decryptSources(ciphertextHex, seed, tmdbId);
  });
  decryptionQueue = result.then(() => {}).catch(() => {});
  return result;
}

interface ProviderDef {
  name: string;
  path: string;
  extraParams?: Record<string, string>;
  filter?: (data: any) => any[];
  audio?: string;
  flag?: string;
}

const providers: ProviderDef[] = [
  { name: "Jett", path: "jett", audio: "Original audio", flag: "us" },
  { name: "Yoru", path: "cdn", audio: "Movies only, may have 4K", flag: "us" },
  { name: "Tejo", path: "tejo", audio: "Original audio", flag: "us" },
  { name: "Neon", path: "neon2", audio: "Original audio", flag: "us" },
  { name: "Sage", path: "ym", audio: "Original audio", flag: "us" },
  { name: "Cypher", path: "downloader2", audio: "Original audio", flag: "us" },
  { name: "Breach", path: "m4uhd", audio: "Original audio", flag: "us" },
  {
    name: "Vyse",
    path: "hdmovie",
    audio: "Original audio",
    flag: "us",
    filter: (data) =>
      (data.sources || []).filter(
        (s: any) => s.quality === "English" || s.quality === "Original",
      ),
  },
  {
    name: "Fade",
    path: "hdmovie",
    audio: "Hindi audio",
    flag: "in",
    filter: (data) =>
      (data.sources || []).filter((s: any) => s.quality === "Hindi"),
  },
  {
    name: "Killjoy",
    path: "meine",
    extraParams: { language: "german" },
    audio: "German audio",
    flag: "de",
  },
  { name: "Omen", path: "lamovie", audio: "Spanish audio", flag: "mx" },
  { name: "Raze", path: "superflix", audio: "Brazil audio", flag: "br" },
];

async function fetchProviderStreams(
  prov: ProviderDef,
  title: string,
  mediaType: "movie" | "tv",
  year: string,
  tmdbId: string,
  season: number,
  episode: number,
  seed: string,
  imdbId: string,
): Promise<{
  sourceName: string;
  audio: string;
  flag: string;
  sources: any[];
  subtitles: any[];
}> {
  const url = `https://api.speedracelight.com/${prov.path}/sources-with-title`;
  const params: Record<string, string> = {
    title: encodeURIComponent(title),
    mediaType,
    year,
    totalSeasons: "",
    episodeId: String(episode),
    seasonId: String(season),
    tmdbId,
    imdbId: imdbId || "",
    enc: "2",
    seed,
    ...prov.extraParams,
  };

  const urlWithParams = new URL(url);
  Object.entries(params).forEach(([key, val]) => {
    urlWithParams.searchParams.append(key, val);
  });

  const targetUrl = urlWithParams.toString();
  console.log(`[VIDEASY] Querying: ${targetUrl}`);
  let ciphertext = "";
  try {
    const res = await fetchWithGotScraping(
      targetUrl,
      {
        accept: "*/*",
        "accept-language": "en-US,en;q=0.5",
        origin: "https://player.videasy.to",
        referer: "https://player.videasy.to/",
        "sec-ch-ua": '"Not;A=Brand";v="8", "Chromium";v="150", "Brave";v="150"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "cross-site",
        "sec-gpc": "1",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
      },
      undefined,
      "get",
      undefined,
      undefined,
      false, // http2 = false
    ).catch(() => null);

    if (res && res.statusCode >= 200 && res.statusCode < 300 && res.body) {
      ciphertext = res.body.toString().trim();
    }
  } catch (err: any) {
    const status = err.response?.statusCode || 500;
    throw new Error(`HTTP error ${status}`);
  }
  if (!ciphertext || ciphertext.startsWith("{")) {
    throw new Error(`Empty response or error message: ${ciphertext}`);
  }

  const decrypted = await decryptSourcesSerialized(ciphertext, seed, tmdbId);

  let sources = decrypted.sources || [];
  if (prov.filter) {
    sources = prov.filter(decrypted);
  }
  const subtitles = decrypted.subtitles || [];

  return {
    sourceName: prov.name,
    audio: prov.audio || "Original audio",
    flag: prov.flag || "us",
    sources,
    subtitles,
  };
}

async function saveProviderMirrorsToCache(
  tmdbId: string,
  type: "movie" | "tv",
  season: number,
  episode: number,
  providerName: string,
  mirrorsToSave: any[],
  subtitlesToSave: any[],
) {
  const cacheKey = `${tmdbId}-videasy`;

  try {
    // 1. Atomically remove any old mirrors/subs for this provider
    await StreamCache.updateOne(
      { tmdbId: cacheKey, type, season, episode },
      {
        $pull: {
          mirrors: {
            source: { $regex: new RegExp("^Videasy \\(" + providerName, "i") },
          },
          subtitles: { source: providerName },
        },
      },
    );

    // 2. Append new mirrors/subs
    const cacheExpires = new Date();
    cacheExpires.setHours(cacheExpires.getHours() + 4);
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

    const updateQuery: any = {
      $push: {
        mirrors: { $each: mirrorsToSave },
        subtitles: { $each: subtitlesToSave },
      },
      $set: {
        expiresAt,
      },
    };

    // 3. Set the default streamUrl if not already set
    const existing = await StreamCache.findOne({
      tmdbId: cacheKey,
      type,
      season,
      episode,
    });
    if (!existing || !existing.streamUrl) {
      if (mirrorsToSave.length > 0) {
        updateQuery.$set.streamUrl = mirrorsToSave[0].url;
        updateQuery.$set.source = mirrorsToSave[0].source;
        updateQuery.$set.streamExpiresAt = cacheExpires;
      }
    }

    if (mirrorsToSave.length > 0 || subtitlesToSave.length > 0) {
      await StreamCache.updateOne(
        { tmdbId: cacheKey, type, season, episode },
        updateQuery,
        { upsert: true },
      );
    }

    // 4. Delete from DeadPool if we found mirrors
    if (mirrorsToSave.length > 0) {
      await DeadPool.deleteMany({
        tmdbId: { $in: [tmdbId.toString(), cacheKey] },
        type,
        season,
        episode,
      }).catch(() => null);
    }
  } catch (err: any) {
    console.error(
      `[VIDEASY] Cache save failed for ${providerName}:`,
      err.message,
    );
  }
}

async function scanProvider(
  prov: ProviderDef,
  title: string,
  mediaType: "movie" | "tv",
  year: string,
  tmdbId: string,
  season: number,
  episode: number,
  seed: string,
  imdbId: string,
): Promise<Record<string, any> | null> {
  try {
    const res = await fetchProviderStreams(
      prov,
      title,
      mediaType,
      year,
      tmdbId,
      season,
      episode,
      seed,
      imdbId,
    );

    if (!res || !res.sources || res.sources.length === 0) return null;

    // Filter valid sources (must have url)
    const validSources = res.sources.filter((src: any) => src && src.url);
    if (validSources.length === 0) return null;

    const hlsSources = validSources.filter((src: any) =>
      src.url.includes("m3u8"),
    );
    const mp4Sources = validSources.filter(
      (src: any) => !src.url.includes("m3u8"),
    );

    const providerMirrors: Record<string, any> = {};

    // 1. Process HLS sources
    if (hlsSources.length > 0) {
      if (hlsSources.length === 1) {
        const src = hlsSources[0];
        const mirrorName = `Videasy (${res.sourceName})`;
        providerMirrors[mirrorName] = {
          url: src.url,
          type: "hls",
          audio: res.audio,
          flag: res.flag,
        };
      } else {
        const sortedHls = [...hlsSources].sort((a: any, b: any) => {
          const parseHeight = (q: any) => {
            const match = String(q || "").match(/(\d+)/);
            return match ? parseInt(match[1]!, 10) : 0;
          };
          return parseHeight(b.quality) - parseHeight(a.quality);
        });

        const urls: string[] = [];
        const qualities: number[] = [];

        sortedHls.forEach((src: any) => {
          const qStr = String(src.quality || "").toLowerCase();
          let height = parseInt(qStr.replace(/\D/g, ""), 10);
          if (isNaN(height)) {
            if (qStr.includes("1080")) height = 1080;
            else if (qStr.includes("720")) height = 720;
            else if (qStr.includes("480")) height = 480;
            else if (qStr.includes("360")) height = 360;
            else if (qStr.includes("240")) height = 240;
            else height = 480;
          }
          urls.push(encodeURIComponent(src.url));
          qualities.push(height);
        });

        const mirrorName = `Videasy (${res.sourceName})`;
        providerMirrors[mirrorName] = {
          url: `/api/videasy/master.m3u8?urls=${urls.join(",")}&qualities=${qualities.join(",")}`,
          type: "hls",
          audio: res.audio,
          flag: res.flag,
        };
      }
    }

    // 2. Process MP4 sources
    if (mp4Sources.length > 0) {
      const sortedMp4 = [...mp4Sources].sort((a: any, b: any) => {
        const parseHeight = (q: any) => {
          const match = String(q || "").match(/(\d+)/);
          return match ? parseInt(match[1]!, 10) : 0;
        };
        return parseHeight(b.quality) - parseHeight(a.quality);
      });

      const urlsWithHash = sortedMp4.map((src: any) => {
        const qualitySuffix =
          src.quality && src.quality !== "Auto" && src.quality !== "Original"
            ? ` - ${src.quality}`
            : "";
        const mirrorName = `Videasy (${res.sourceName}${qualitySuffix})`;
        return `${src.url}#${mirrorName}#mp4#${res.audio || ""}`;
      });

      const groupMirrorName = `Videasy (${res.sourceName})`;
      providerMirrors[groupMirrorName] = {
        url: urlsWithHash.join("|"),
        type: "mp4",
        audio: res.audio,
        flag: res.flag,
      };
    }

    const mirrorsToSave = Object.entries(providerMirrors)
      .filter(([_, v]: any) => v && v.url)
      .map(([name, v]: any) => ({
        source: name,
        url: v.url,
        type: v.type || "hls",
        audio: v.audio || "",
        flag: v.flag || "us",
      }));

    const subtitlesToSave = res.subtitles || [];

    await saveProviderMirrorsToCache(
      tmdbId,
      mediaType,
      season,
      episode,
      prov.name,
      mirrorsToSave,
      subtitlesToSave,
    );

    return providerMirrors;
  } catch (err: any) {
    console.warn(`[VIDEASY] Scraper for ${prov.name} failed: ${err.message}`);
    const statusMatch = err.message.match(/HTTP error (\d+)/i);
    if (statusMatch) {
      const statusCode = parseInt(statusMatch[1], 10);
      if (statusCode === 404 || statusCode === 500) {
        const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000); // 72 hours
        await FailedProvider.findOneAndUpdate(
          {
            tmdbId: tmdbId.toString(),
            type: mediaType,
            season,
            episode,
            provider: prov.name,
            scraperName: "videasy",
          },
          {
            errorCode: statusCode,
            expiresAt,
          },
          { upsert: true },
        ).catch((dbErr) => {
          console.error(
            `[VIDEASY] Failed to save failed provider cache for ${prov.name}:`,
            dbErr.message,
          );
        });
      }
    }
    return null;
  }
}

export const activeScans = new Set<string>();
const inMemorySeedCache = new Map<string, { seed: string; expiresAt: number }>();

export async function fetchVideasySources(
  title: string,
  mediaType: "movie" | "tv",
  year: string,
  tmdbId: string,
  season: number = 1,
  episode: number = 1,
  force: boolean = false,
  passedSeed?: string,
): Promise<Record<string, any>> {
  if (process.env.DISABLE_VIDEASY === "true") {
    console.log(`[VIDEASY] Scraper is temporarily disabled via env config.`);
    return {};
  }

  const imdbId = (await fetchImdbId(tmdbId, mediaType, title)) || "";

  const scanKey = `videasy-${tmdbId}-${mediaType}-${season}-${episode}`;
  if (activeScans.has(scanKey)) {
    console.log(
      `[VIDEASY] Scan already in progress for ${tmdbId} S${season}E${episode}.`,
    );
    return {};
  }

  activeScans.add(scanKey);

  console.log(
    `[VIDEASY] Starting background-scanned parallel search for ${mediaType} ${tmdbId} S${season}E${episode}...`,
  );

  const failedSet = new Set<string>();
  if (!force) {
    try {
      const failedProviders = await FailedProvider.find({
        tmdbId: tmdbId.toString(),
        type: mediaType,
        season,
        episode,
        scraperName: "videasy",
      });
      failedProviders.forEach((p) => failedSet.add(p.provider));
    } catch (err: any) {
      console.error(
        `[VIDEASY] Failed to retrieve failed providers cache:`,
        err.message,
      );
    }
  }

  // Clear expired/old cache for this Videasy document to start fresh
  const cacheKey = `${tmdbId}-videasy`;
  const existing = await StreamCache.findOne({
    tmdbId: cacheKey,
    type: mediaType,
    season,
    episode,
  }).catch(() => null);

  if (
    existing &&
    (force ||
      !existing.streamExpiresAt ||
      new Date() >= existing.streamExpiresAt)
  ) {
    await StreamCache.updateOne(
      { tmdbId: cacheKey, type: mediaType, season, episode },
      {
        $set: {
          mirrors: [],
          subtitles: [],
          streamUrl: null,
          streamExpiresAt: null,
        },
      },
    ).catch(() => null);
  }

  const seedUrl = `https://api.speedracelight.com/seed?mediaId=${tmdbId}`;
  const seedHeaders = {
    accept: "*/*",
    "accept-language": "en-US,en;q=0.5",
    origin: "https://player.videasy.to",
    referer: "https://player.videasy.to/",
    "sec-ch-ua": '"Not;A=Brand";v="8", "Chromium";v="150", "Brave";v="150"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "cross-site",
    "sec-gpc": "1",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36",
  };

  let seed = passedSeed || "";
  if (!seed) {
    const cachedSeedObj = inMemorySeedCache.get(tmdbId);
    if (cachedSeedObj && Date.now() < cachedSeedObj.expiresAt) {
      seed = cachedSeedObj.seed;
      console.log(`[VIDEASY] Using in-memory cached seed for ${tmdbId}`);
    } else {
      try {
        const res = await fetchWithGotScraping(
          seedUrl,
          seedHeaders,
          undefined,
          "get",
          undefined,
          undefined,
          false, // http2 = false
        );
        if (res && res.statusCode >= 200 && res.statusCode < 300 && res.body) {
          const bodyJson = JSON.parse(res.body.toString());
          seed = bodyJson.seed || "";
          if (seed) {
            const ttl = (bodyJson.ttlMs || 30000) - 5000;
            inMemorySeedCache.set(tmdbId, {
              seed,
              expiresAt: Date.now() + Math.max(ttl, 10000),
            });
          }
        }
      } catch (err: any) {
        const status = err.response?.statusCode || "unknown";
        console.error(
          `[VIDEASY] Failed to fetch seed. Status: ${status}. Error:`,
          err.message,
        );
      }
    }
  } else {
    console.log(`[VIDEASY] Using seed passed from client: ${seed}`);
  }

  if (!seed) {
    console.error(`[VIDEASY] Seed is empty, aborting scraper.`);
    activeScans.delete(scanKey);
    return {};
  }

  const activeMirrors: Record<string, any> = {};

  // Map each provider to a promise that writes directly to MongoDB cache
  // and merges its results into activeMirrors in real-time as it completes.
  const scanPromises = providers.map(async (prov, index) => {
    // Stagger requests: delay start of subsequent scans to prevent parallel spikes
    await new Promise((resolve) => setTimeout(resolve, index * 150));

    // Stop querying if we have already found enough mirrors (e.g. 3)
    if (Object.keys(activeMirrors).length >= 3) {
      return null;
    }

    if (failedSet.has(prov.name)) {
      console.log(
        `[VIDEASY] Skipping cached failed provider ${prov.name} for ${tmdbId} S${season}E${episode}`,
      );
      return null;
    }

    const res = await scanProvider(
      prov,
      title,
      mediaType,
      year,
      tmdbId,
      season,
      episode,
      seed,
      imdbId,
    );
    if (res) {
      Object.assign(activeMirrors, res);
    }
    return res;
  });

  // Race: wait up to 5 seconds for fast providers to populate activeMirrors
  const raceTimeout = new Promise<void>((resolve) => {
    setTimeout(resolve, 5000);
  });

  const allFinished = Promise.all(scanPromises);

  allFinished.finally(async () => {
    activeScans.delete(scanKey);
    try {
      const cacheKey = `${tmdbId}-videasy`;
      const existing = await StreamCache.findOne({
        tmdbId: cacheKey,
        type: mediaType,
        season,
        episode,
      }).catch(() => null);

      if (!existing || !existing.mirrors || existing.mirrors.length === 0) {
        const cacheExpires = new Date();
        cacheExpires.setHours(cacheExpires.getHours() + 24);
        const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

        await StreamCache.updateOne(
          { tmdbId: cacheKey, type: mediaType, season, episode },
          {
            $set: {
              mirrors: [],
              subtitles: [],
              streamExpiresAt: cacheExpires,
              expiresAt,
            },
          },
          { upsert: true },
        );
        console.log(
          `[VIDEASY] Saved empty cache record (24h expiry) for ${tmdbId} S${season}E${episode}`,
        );
      }
    } catch (err: any) {
      console.error(
        `[VIDEASY] Background cleanup / empty cache save failed:`,
        err.message,
      );
    }
  });

  // Block the HTTP response for at most 5 seconds, or until all finish (whichever is faster)
  await Promise.race([allFinished, raceTimeout]);

  console.log(
    `[VIDEASY] Completed initial 5s race for ${tmdbId} S${season}E${episode}. Returning ${Object.keys(activeMirrors).length} mirror(s). Remaining scans running in bg...`,
  );

  return activeMirrors;
}
