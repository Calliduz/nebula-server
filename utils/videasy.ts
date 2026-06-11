import fs from "fs";
import path from "path";
import { webcrypto } from "crypto";
// @ts-ignore
import CryptoJS from "crypto-js";

const WASM_PATH = path.join(process.cwd(), "utils", "bin", "videasy.wasm");

// Cache for compiling/instantiating WASM
let wasmInstance: WebAssembly.Instance | null = null;

async function getWasmInstance() {
  if (wasmInstance) return wasmInstance;
  
  if (!fs.existsSync(WASM_PATH)) {
    throw new Error(`WASM file not found at ${WASM_PATH}`);
  }

  const wasmBytes = fs.readFileSync(WASM_PATH);
  const env = {
    seed: () => Date.now() * Math.random(),
    abort() {}
  };

  const { instance } = await WebAssembly.instantiate(wasmBytes, { env });
  wasmInstance = instance;
  return wasmInstance;
}

// Helper to decrypt ciphertext returned by Videasy API
async function decryptSources(ciphertextHex: string, tmdbId: string): Promise<any> {
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
    for (; t - n > 1024;) {
      s += String.fromCharCode(...u16.subarray(n, n += 1024));
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

  const servePtr = exp.serve() >>> 0;
  let serveCode = readString(servePtr);
  if (!serveCode) {
    throw new Error("Failed to read serve code from WASM");
  }
  serveCode = serveCode.replace(/_0x24\(\),_0x36\(/g, '_0x36(');

  const fakeWindow = { location: { hostname: "cineby.sc", href: "https://cineby.sc/" }, hash: undefined as any };
  const fn = new Function("window", "crypto", "TextEncoder", serveCode);
  fn(fakeWindow, webcrypto, TextEncoder);
  
  await new Promise(r => setTimeout(r, 100));
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
  const pt = CryptoJS.AES.decrypt(wasmDecryptedStr, "").toString(CryptoJS.enc.Utf8);
  if (!pt) {
    throw new Error("CryptoJS AES decryption yielded empty string");
  }
  
  return JSON.parse(pt);
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
    filter: (data) => (data.sources || []).filter((s: any) => s.quality === "English" || s.quality === "Original")
  },
  {
    name: "Fade",
    path: "hdmovie",
    audio: "Hindi audio",
    flag: "in",
    filter: (data) => (data.sources || []).filter((s: any) => s.quality === "Hindi")
  },
  { name: "Killjoy", path: "meine", extraParams: { language: "german" }, audio: "German audio", flag: "de" },
  { name: "Omen", path: "lamovie", audio: "Spanish audio", flag: "mx" },
  { name: "Raze", path: "superflix", audio: "Original audio", flag: "us" }
];

async function fetchProviderStreams(
  prov: ProviderDef,
  title: string,
  mediaType: "movie" | "tv",
  year: string,
  tmdbId: string,
  season: number,
  episode: number
): Promise<{ sourceName: string; audio: string; flag: string; sources: any[]; subtitles: any[] }> {
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
    ...prov.extraParams
  };

  const urlWithParams = new URL(url);
  Object.entries(params).forEach(([key, val]) => {
    urlWithParams.searchParams.append(key, val);
  });

  const res = await fetch(urlWithParams.toString(), {
    method: "GET",
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
      "Referer": "https://player.videasy.to/",
      "Origin": "https://player.videasy.to"
    },
    signal: AbortSignal.timeout(10000)
  });

  if (!res.ok) {
    throw new Error(`HTTP error ${res.status}`);
  }

  const ciphertext = (await res.text()).trim();
  if (!ciphertext || ciphertext.startsWith("{")) {
    throw new Error(`Empty response or error message: ${ciphertext}`);
  }

  const decrypted = await decryptSources(ciphertext, tmdbId);
  
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
    subtitles
  };
}

export async function fetchVideasySources(
  title: string,
  mediaType: "movie" | "tv",
  year: string,
  tmdbId: string,
  season: number = 1,
  episode: number = 1
): Promise<Record<string, any>> {
  console.log(`[VIDEASY] Starting parallel scan for ${mediaType} ${tmdbId} S${season}E${episode}...`);
  
  const promises = providers.map(async (prov) => {
    try {
      return await fetchProviderStreams(prov, title, mediaType, year, tmdbId, season, episode);
    } catch (err: any) {
      console.warn(`[VIDEASY] Provider ${prov.name} failed: ${err.message}`);
      return null;
    }
  });

  const results = await Promise.all(promises);
  const activeMirrors: Record<string, any> = {};

  for (const res of results) {
    if (!res || !res.sources || res.sources.length === 0) continue;
    
    res.sources.forEach((src) => {
      if (!src.url) return;
      
      // If there are multiple qualities, name them appropriately
      const qualitySuffix = src.quality && src.quality !== "Auto" && src.quality !== "Original"
        ? ` - ${src.quality}`
        : "";
      
      const mirrorName = `Videasy (${res.sourceName}${qualitySuffix})`;
      activeMirrors[mirrorName] = {
        url: src.url,
        type: src.url.includes("m3u8") ? "hls" : "mp4",
        audio: res.audio,
        flag: res.flag
      };
    });
  }

  return activeMirrors;
}
