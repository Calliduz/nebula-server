import { gotScraping } from "got-scraping";
import { CookieJar } from "tough-cookie";

export const ORION_KEY = "filmu_moviebox_key_v1";
export const ANIME_KEY =
  "6b7a8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b";

export const BASE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
  Origin: "https://embed.filmu.in",
  Referer: "https://embed.filmu.in/",
};

// In-memory token cache to minimize request overhead
interface TokenCache {
  token: string;
  expiresAt: number;
}
let kuroToken: TokenCache | null = null;
let mikazukiToken: TokenCache | null = null;

const TOKEN_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * GotScraping wrapper to execute requests with browser fingerprint spoofing and AbortSignals
 */
async function makeRequest(
  url: string,
  options: {
    method?: "GET" | "POST";
    headers?: Record<string, string>;
    body?: string;
    proxy?: string | undefined;
    signal?: AbortSignal | undefined;
    cookieJar?: CookieJar;
  },
) {
  const gotOptions: any = {
    method: options.method || "GET",
    headers: {
      ...BASE_HEADERS,
      ...options.headers,
    },
    cookieJar: options.cookieJar || new CookieJar(),
    responseType: "json",
    retry: { limit: 0 },
    timeout: { request: 15000 },
    http2: true,
  };

  if (options.body) {
    gotOptions.body = options.body;
    gotOptions.headers["Content-Type"] = "application/json";
  }

  if (options.proxy) {
    gotOptions.proxyUrl = options.proxy.startsWith("http")
      ? options.proxy
      : `http://${options.proxy}`;
  }

  if (options.signal) {
    gotOptions.signal = options.signal;
  }

  const response = await gotScraping(url, gotOptions);
  return response.body as any;
}

/**
 * Resolves or fetches a Kuro Anime session token
 */
export async function getKuroToken(
  proxy?: string,
  signal?: AbortSignal,
): Promise<string> {
  const now = Date.now();
  if (kuroToken && kuroToken.expiresAt > now) {
    return kuroToken.token;
  }

  try {
    const data = await makeRequest("https://anime2.filmu.in/token", {
      method: "POST",
      proxy,
      signal,
    });
    if (data?.token) {
      kuroToken = {
        token: data.token,
        expiresAt: now + TOKEN_TTL,
      };
      return data.token;
    }
    throw new Error("Empty token returned from Kuro");
  } catch (e: any) {
    console.error("[FilmU Endpoints] Failed to get Kuro token:", e.message);
    throw e;
  }
}

/**
 * Searches Kuro Anime catalog
 */
export async function searchKuro(
  query: string,
  token: string,
  proxy?: string,
  signal?: AbortSignal,
) {
  const url = `https://anime2.filmu.in/search?q=${encodeURIComponent(query)}`;
  return makeRequest(url, {
    headers: { "x-api-key": token },
    proxy,
    signal,
  });
}

/**
 * Retrieves episode metadata for a Kuro Anime
 */
export async function getKuroMeta(
  animeId: string,
  token: string,
  proxy?: string,
  signal?: AbortSignal,
) {
  const url = `https://anime2.filmu.in/meta?id=${encodeURIComponent(animeId)}`;
  return makeRequest(url, {
    headers: { "x-api-key": token },
    proxy,
    signal,
  });
}

/**
 * Gets Kuro stream playlists
 */
export async function getKuroStreams(
  dataStr: string,
  token: string,
  proxy?: string,
  signal?: AbortSignal,
) {
  const url = `https://anime2.filmu.in/streams?data=${encodeURIComponent(dataStr)}`;
  return makeRequest(url, {
    headers: { "x-api-key": token },
    proxy,
    signal,
  });
}

/**
 * Resolves or fetches a Mikazuki session token
 */
export async function getMikazukiToken(
  proxy?: string,
  signal?: AbortSignal,
): Promise<string> {
  const now = Date.now();
  if (mikazukiToken && mikazukiToken.expiresAt > now) {
    return mikazukiToken.token;
  }

  try {
    const data = await makeRequest("https://hianime.filmu.in/token", {
      method: "POST",
      proxy,
      signal,
    });
    if (data?.token) {
      mikazukiToken = {
        token: data.token,
        expiresAt: now + TOKEN_TTL,
      };
      return data.token;
    }
    throw new Error("Empty token returned from Mikazuki");
  } catch (e: any) {
    console.error("[FilmU Endpoints] Failed to get Mikazuki token:", e.message);
    throw e;
  }
}

/**
 * Searches Mikazuki Anime catalog
 */
export async function searchMikazuki(
  query: string,
  token: string,
  proxy?: string,
  signal?: AbortSignal,
) {
  const url = `https://hianime.filmu.in/search?q=${encodeURIComponent(query)}`;
  return makeRequest(url, {
    headers: { "x-api-key": token },
    proxy,
    signal,
  });
}

/**
 * Gets Mikazuki Megaplay streams
 */
export async function getMikazukiStreams(
  malId: number,
  episode: number,
  type: "sub" | "dub",
  token: string,
  proxy?: string,
  signal?: AbortSignal,
) {
  const url = `https://hianime.filmu.in/hianime/megaplay?malId=${malId}&ep=${episode}&type=${type}`;
  return makeRequest(url, {
    headers: { "x-api-key": token },
    proxy,
    signal,
  });
}

/**
 * Scrapes Vortex (RiveStream / VideasyHD)
 */
export async function getVortexStreams(
  provider: "rivestream" | "VideasyHD",
  imdbId: string,
  tmdbId: number,
  title: string,
  year: number,
  type: "movie" | "tv",
  season?: number,
  episode?: number,
  proxy?: string,
  signal?: AbortSignal,
) {
  let url = `https://rive.filmu.in/scrape/${provider}/${type}/${imdbId}?title=${encodeURIComponent(title)}&year=${year}&tmdbId=${tmdbId}&imdbId=${imdbId}&apikey=${ORION_KEY}`;
  if (type === "tv" && season !== undefined && episode !== undefined) {
    url += `&season=${season}&episode=${episode}`;
  }
  return makeRequest(url, { proxy, signal });
}

/**
 * Scrapes Zenith (Vaplayer / Videasy) via the showbox proxy endpoint
 */
export async function getZenithStreams(
  provider: "Vaplayer" | "Videasy",
  tmdbId: number,
  title: string,
  year: number,
  type: "movie" | "tv",
  season?: number,
  episode?: number,
  proxy?: string,
  signal?: AbortSignal,
) {
  let scraperPath = `/scrape/${provider}/${type}/${tmdbId}?title=${encodeURIComponent(title)}&year=${year}&tmdbId=${tmdbId}`;
  if (type === "tv" && season !== undefined && episode !== undefined) {
    scraperPath += `&season=${season}&episode=${episode}`;
  }
  const url = `https://embed.filmu.in/api/showbox-proxy?path=${encodeURIComponent(scraperPath)}`;
  return makeRequest(url, { proxy, signal });
}

/**
 * Scrapes Aura (VidRock Nova / Orion / Helios) via embed proxy
 */
export async function getAuraStreams(
  tmdbId: number,
  title: string,
  year: number,
  type: "movie" | "tv",
  season?: number,
  episode?: number,
  proxy?: string,
  signal?: AbortSignal,
) {
  let scraperPath = `/scrape/VidRock/${type}/tmdb${tmdbId}?title=${encodeURIComponent(title)}&year=${year}&tmdbId=${tmdbId}`;
  if (type === "tv" && season !== undefined && episode !== undefined) {
    scraperPath += `&season=${season}&episode=${episode}`;
  }
  const url = `https://embed.filmu.in/api/proxy?path=${encodeURIComponent(scraperPath)}`;
  return makeRequest(url, { proxy, signal });
}
