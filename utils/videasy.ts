import fs from "fs";
import path from "path";
import { webcrypto } from "crypto";
// @ts-ignore
import CryptoJS from "crypto-js";
import vm from "vm";
import { StreamCache, DeadPool } from "../models/Cache.js";

const WASM_PATH = path.join(process.cwd(), "utils", "bin", "videasy.wasm");

// Cache for compiling/instantiating WASM
let wasmInstance: WebAssembly.Instance | null = null;
let cachedServeCode: string | null = null;
let cachedScript: vm.Script | null = null;
let cachedHash: string | null = null;
let cachedHashTime = 0;
const HASH_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getWasmInstance() {
  if (wasmInstance) return wasmInstance;

  if (!fs.existsSync(WASM_PATH)) {
    throw new Error(`WASM file not found at ${WASM_PATH}`);
  }

  const wasmBytes = fs.readFileSync(WASM_PATH);
  const env = {
    seed: () => Date.now() * Math.random(),
    abort() {},
  };

  const { instance } = await WebAssembly.instantiate(wasmBytes, { env });
  wasmInstance = instance;
  return wasmInstance;
}

async function getCompiledServeCode(instance: WebAssembly.Instance) {
  if (cachedServeCode) return cachedServeCode;

  const exp = instance.exports as any;
  const memory = exp.memory;

  // Read UTF-16 string from WASM memory
  function readString(ptr: number) {
    if (!ptr) return null;
    const u32 = new Uint32Array(memory.buffer);
    const u16 = new Uint16Array(memory.buffer);
    let endOffStr = ptr + u32[(ptr - 4) >>> 2]!;
    let t = endOffStr >>> 1;
    let n = ptr >>> 1;
    let s = "";
    if (t - n > 5000000 || t - n < 0) return null;
    for (; t - n > 1024; ) {
      s += String.fromCharCode(...u16.subarray(n, (n += 1024)));
    }
    return s + String.fromCharCode(...u16.subarray(n, t));
  }

  const servePtr = exp.serve() >>> 0;
  let serveCode = readString(servePtr);
  if (!serveCode) {
    throw new Error("Failed to read serve code from WASM");
  }
  serveCode = serveCode.replace(/(_0x[a-f0-9]+)\(\),(_0x[a-f0-9]+\()/g, "$2");
  cachedServeCode = serveCode;
  return cachedServeCode;
}

async function getVmScript(instance: WebAssembly.Instance) {
  if (cachedScript) return cachedScript;
  const serveCode = await getCompiledServeCode(instance);
  const codeToRun = `
    (function(window, crypto, TextEncoder) {
      ${serveCode}
    })(window, crypto, TextEncoder);
  `;
  cachedScript = new vm.Script(codeToRun);
  return cachedScript;
}

export async function decryptSources(
  ciphertextHex: string,
  tmdbId: string,
): Promise<any> {
  const instance = await getWasmInstance();
  const exp = instance.exports as any;
  const memory = exp.memory;

  // Read UTF-16 string from WASM memory
  function readString(ptr: number) {
    if (!ptr) return null;
    const u32 = new Uint32Array(memory.buffer);
    const u16 = new Uint16Array(memory.buffer);
    let endOffStr = ptr + u32[(ptr - 4) >>> 2]!;
    let t = endOffStr >>> 1;
    let n = ptr >>> 1;
    let s = "";
    if (t - n > 5000000 || t - n < 0) return null;
    for (; t - n > 1024; ) {
      s += String.fromCharCode(...u16.subarray(n, (n += 1024)));
    }
    return s + String.fromCharCode(...u16.subarray(n, t));
  }

  // Write UTF-16 string to WASM memory
  function writeString(str: string) {
    const ptr = exp.__new(str.length << 1, 2) >>> 0;
    const u16 = new Uint16Array(memory.buffer);
    for (let i = 0; i < str.length; i++) {
      u16[(ptr >>> 1) + i] = str.charCodeAt(i);
    }
    return ptr;
  }

  const activeTimers: NodeJS.Timeout[] = [];
  const activeIntervals: NodeJS.Timeout[] = [];

  const customSetTimeout = (callback: any, delay: any, ...args: any[]) => {
    // Intercept/block obfuscated loops with very short delays or anti-debugger checks
    const codeStr = callback?.toString() || "";
    if (
      delay < 50 &&
      (codeStr.includes("debugger") ||
        codeStr.includes("callee") ||
        codeStr.includes("action"))
    ) {
      return setTimeout(() => {}, delay);
    }
    const t = setTimeout(callback, delay, ...args);
    activeTimers.push(t);
    return t;
  };
  const customSetInterval = (callback: any, delay: any, ...args: any[]) => {
    // Intercept/block obfuscated loops with very short delays or anti-debugger checks
    const codeStr = callback?.toString() || "";
    if (
      delay < 50 &&
      (codeStr.includes("debugger") ||
        codeStr.includes("callee") ||
        codeStr.includes("action"))
    ) {
      return setInterval(() => {}, delay);
    }
    const i = setInterval(callback, delay, ...args);
    activeIntervals.push(i);
    return i;
  };

  let hash = cachedHash;
  const now = Date.now();
  if (!hash || now - cachedHashTime > HASH_CACHE_TTL) {
    const script = await getVmScript(instance);

    const fakeWindow = {
      location: { hostname: "cineby.sc", href: "https://cineby.sc/" },
      hash: undefined as any,
    };

    const sandbox = {
      window: fakeWindow,
      crypto: webcrypto,
      TextEncoder,
      setTimeout: customSetTimeout,
      setInterval: customSetInterval,
      clearTimeout,
      clearInterval,
    };

    vm.createContext(sandbox);

    // Execute compiled script in isolated context
    script.runInContext(sandbox);

    // Poll dynamically for the hash to reduce wait time and avoid background timers running longer
    let attempts = 0;
    while (fakeWindow.hash === undefined && attempts < 100) {
      await new Promise((r) => setImmediate(r));
      attempts++;
    }

    hash = String(fakeWindow.hash);
    if (!hash || hash === "undefined") {
      throw new Error("Failed to get verification hash");
    }
    cachedHash = hash;
    cachedHashTime = now;
  }

  try {
    const hashPtr = writeString(hash);
    if (!exp.verify(hashPtr)) {
      throw new Error("WASM verify signature failed");
    }

    const ctPtr = writeString(ciphertextHex);
    const resPtr = exp.decrypt(ctPtr, parseInt(tmdbId, 10)) >>> 0;
    const wasmDecryptedStr = readString(resPtr);
    if (!wasmDecryptedStr) {
      throw new Error("WASM decrypt returned null");
    }

    // Decrypt the outer AES layer with key ""
    const pt = CryptoJS.AES.decrypt(wasmDecryptedStr, "").toString(
      CryptoJS.enc.Utf8,
    );
    if (!pt) {
      throw new Error("CryptoJS AES decryption yielded empty string");
    }

    return JSON.parse(pt);
  } finally {
    // Clear all sandboxed background timers to prevent leaks
    activeTimers.forEach((t) => clearTimeout(t));
    activeIntervals.forEach((i) => clearInterval(i));

    // Trigger AssemblyScript GC
    try {
      exp.__collect();
    } catch {}
  }
}

let decryptionQueue = Promise.resolve();

export async function decryptSourcesSerialized(
  ciphertextHex: string,
  tmdbId: string,
): Promise<any> {
  const result = decryptionQueue.then(async () => {
    // Yield to the event loop to let database heartbeats & HTTP I/O process
    await new Promise((resolve) => setImmediate(resolve));
    return await decryptSources(ciphertextHex, tmdbId);
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
  { name: "Neon", path: "mb-flix", audio: "Original audio", flag: "us" },
  { name: "Yoru", path: "cdn", audio: "Movies only, may have 4K", flag: "us" },
  { name: "Cypher", path: "downloader2", audio: "Original audio", flag: "us" },
  { name: "Sage", path: "1movies", audio: "Original audio", flag: "us" },
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
): Promise<{
  sourceName: string;
  audio: string;
  flag: string;
  sources: any[];
  subtitles: any[];
}> {
  const url = `https://api.videasy.to/${prov.path}/sources-with-title`;
  const params: Record<string, string> = {
    title: encodeURIComponent(title),
    mediaType,
    year,
    totalSeasons: "",
    episodeId: String(episode),
    seasonId: String(season),
    tmdbId,
    imdbId: "",
    ...prov.extraParams,
  };

  const urlWithParams = new URL(url);
  Object.entries(params).forEach(([key, val]) => {
    urlWithParams.searchParams.append(key, val);
  });

  const targetUrl = urlWithParams.toString();
  const res = await fetch(targetUrl, {
    method: "GET",
    headers: {
      accept: "*/*",
      "accept-language": "en-US,en;q=0.5",
      origin: "https://player.videasy.to",
      referer: "https://player.videasy.to/",
      "sec-ch-ua": '"Brave";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-site",
      "sec-gpc": "1",
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    },
    signal: AbortSignal.timeout(45000),
  });

  if (!res.ok) {
    throw new Error(`HTTP error ${res.status}`);
  }

  const ciphertext = (await res.text()).trim();
  if (!ciphertext || ciphertext.startsWith("{")) {
    throw new Error(`Empty response or error message: ${ciphertext}`);
  }

  const decrypted = await decryptSourcesSerialized(ciphertext, tmdbId);

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
    return null;
  }
}

export const activeScans = new Set<string>();

export async function fetchVideasySources(
  title: string,
  mediaType: "movie" | "tv",
  year: string,
  tmdbId: string,
  season: number = 1,
  episode: number = 1,
  force: boolean = false,
): Promise<Record<string, any>> {
  if (process.env.DISABLE_VIDEASY === "true") {
    console.log(`[VIDEASY] Scraper is temporarily disabled via env config.`);
    return {};
  }

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

    const res = await scanProvider(
      prov,
      title,
      mediaType,
      year,
      tmdbId,
      season,
      episode,
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
