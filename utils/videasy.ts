import fs from "fs";
import path from "path";
import { webcrypto } from "crypto";
// @ts-ignore
import CryptoJS from "crypto-js";
import vm from "vm";

const WASM_PATH = path.join(process.cwd(), "utils", "bin", "videasy.wasm");

// Cache for compiling/instantiating WASM
let wasmInstance: WebAssembly.Instance | null = null;
let cachedServeCode: string | null = null;
let cachedScript: vm.Script | null = null;

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
  serveCode = serveCode.replace(/_0x24\(\),_0x36\(/g, "_0x36(");
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
    if (delay < 50 && (codeStr.includes("debugger") || codeStr.includes("callee") || codeStr.includes("action"))) {
      return setTimeout(() => {}, delay);
    }
    const t = setTimeout(callback, delay, ...args);
    activeTimers.push(t);
    return t;
  };
  const customSetInterval = (callback: any, delay: any, ...args: any[]) => {
    // Intercept/block obfuscated loops with very short delays or anti-debugger checks
    const codeStr = callback?.toString() || "";
    if (delay < 50 && (codeStr.includes("debugger") || codeStr.includes("callee") || codeStr.includes("action"))) {
      return setInterval(() => {}, delay);
    }
    const i = setInterval(callback, delay, ...args);
    activeIntervals.push(i);
    return i;
  };

  try {
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

    const hash = String(fakeWindow.hash);
    if (!hash || hash === "undefined") {
      throw new Error("Failed to get verification hash");
    }

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

  const res = await fetch(urlWithParams.toString(), {
    method: "GET",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
      Referer: "https://player.videasy.to/",
      Origin: "https://player.videasy.to",
    },
    signal: AbortSignal.timeout(10000),
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

export async function fetchVideasySources(
  title: string,
  mediaType: "movie" | "tv",
  year: string,
  tmdbId: string,
  season: number = 1,
  episode: number = 1,
): Promise<Record<string, any>> {
  console.log(
    `[VIDEASY] Starting parallel scan for ${mediaType} ${tmdbId} S${season}E${episode}...`,
  );

  const promises = providers.map(async (prov) => {
    try {
      return await fetchProviderStreams(
        prov,
        title,
        mediaType,
        year,
        tmdbId,
        season,
        episode,
      );
    } catch (err: any) {
      console.warn(`[VIDEASY] Provider ${prov.name} failed: ${err.message}`);
      return null;
    }
  });

  const results = await Promise.all(promises);
  const activeMirrors: Record<string, any> = {};

  for (const res of results) {
    if (!res || !res.sources || res.sources.length === 0) continue;

    // Filter valid sources (must have url)
    const validSources = res.sources.filter((src: any) => src && src.url);
    if (validSources.length === 0) continue;

    // Separate HLS and non-HLS (MP4) sources
    const hlsSources = validSources.filter((src: any) =>
      src.url.includes("m3u8"),
    );
    const mp4Sources = validSources.filter(
      (src: any) => !src.url.includes("m3u8"),
    );

    // 1. Process HLS sources
    if (hlsSources.length > 0) {
      if (hlsSources.length === 1) {
        // Only one HLS quality, no need for master playlist
        const src = hlsSources[0];
        const mirrorName = `Videasy (${res.sourceName})`;
        activeMirrors[mirrorName] = {
          url: src.url,
          type: "hls",
          audio: res.audio,
          flag: res.flag,
        };
      } else {
        // Multiple HLS qualities -> group them into a single master playlist
        // Sort descending by quality/height
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
            else height = 480; // fallback default quality
          }
          urls.push(encodeURIComponent(src.url));
          qualities.push(height);
        });

        const mirrorName = `Videasy (${res.sourceName})`;
        activeMirrors[mirrorName] = {
          url: `/api/videasy/master.m3u8?urls=${urls.join(",")}&qualities=${qualities.join(",")}`,
          type: "hls",
          audio: res.audio,
          flag: res.flag,
        };
      }
    }

    // 2. Process MP4 sources
    if (mp4Sources.length > 0) {
      mp4Sources.forEach((src: any) => {
        const qualitySuffix =
          src.quality && src.quality !== "Auto" && src.quality !== "Original"
            ? ` - ${src.quality}`
            : "";
        const mirrorName = `Videasy (${res.sourceName}${qualitySuffix})`;
        activeMirrors[mirrorName] = {
          url: src.url,
          type: "mp4",
          audio: res.audio,
          flag: res.flag,
        };
      });
    }
  }

  return activeMirrors;
}
