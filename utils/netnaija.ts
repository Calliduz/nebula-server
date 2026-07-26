import axios from "axios";
import crypto from "crypto";
import type { MirrorStream } from "./scraper.js";

const BASE_URL = "https://netnaija.film";
const UA =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36";

export interface NetNaijaOptions {
  tmdbId: string | number;
  kind: "movie" | "tv";
  season?: number;
  episode?: number;
  title?: string | undefined;
  signal?: AbortSignal | undefined;
}

export class NetNaijaScraper {
  /**
   * Generates dynamic X-Client-Token: timestamp,MD5(reversedTimestamp)
   */
  private static kp(): string {
    const ts = Math.floor(Date.now() / 1000);
    const reversed = String(ts).split("").reverse().join("");
    const md5 = crypto.createHash("md5").update(reversed).digest("hex");
    return `${ts},${md5}`;
  }

  /**
   * Fetches guest JWT session token from NetNaija home endpoint
   */
  private static async getGuestToken(): Promise<string | null> {
    try {
      const clientToken = this.kp();
      const res = await axios.get(`${BASE_URL}/wefeed-h5api-bff/home`, {
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-client-info": JSON.stringify({ timezone: "Asia/Singapore" }),
          "x-client-token": clientToken,
          "user-agent": UA,
        },
        timeout: 5000,
      });

      const setCookies = res.headers["set-cookie"];
      if (setCookies && Array.isArray(setCookies)) {
        for (const cookieStr of setCookies) {
          const match = cookieStr.match(/^token=([^;]+)/);
          if (match && match[1]) {
            return match[1];
          }
        }
      }
      return null;
    } catch (err: any) {
      console.warn(`[Vesper/NetNaija] Failed to get guest token: ${err.message}`);
      return null;
    }
  }

  /**
   * Resolves TMDB title if title is not passed directly
   */
  private static async getTmdbTitle(
    tmdbId: number,
    type: "movie" | "tv",
  ): Promise<string | undefined> {
    try {
      const tmdbApiKey =
        process.env.TMDB_API_KEY || "8410c58030558e2d6e4f340d8ab92858";
      const url = `https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${tmdbApiKey}`;
      const res = await axios.get(url, { timeout: 5000 });
      return res.data?.title || res.data?.name || undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Main entry point to scrape video stream mirrors
   */
  public static async getStream(
    options: NetNaijaOptions,
  ): Promise<MirrorStream[]> {
    const { tmdbId, kind, season = 1, episode = 1 } = options;
    const numericTmdbId =
      typeof tmdbId === "string" ? parseInt(tmdbId, 10) : tmdbId;

    try {
      let searchTitle = options.title;
      if (!searchTitle && numericTmdbId) {
        searchTitle = await this.getTmdbTitle(numericTmdbId, kind);
      }

      if (!searchTitle) {
        console.warn(
          `[Vesper/NetNaija] Could not resolve title for TMDB ID: ${tmdbId}`,
        );
        return [];
      }

      console.log(
        `[Vesper/NetNaija] Searching for "${searchTitle}" (TMDB ${numericTmdbId}, ${kind})...`,
      );

      const token = await this.getGuestToken();
      if (!token) {
        console.warn(`[Vesper/NetNaija] Unable to obtain guest authentication token`);
        return [];
      }

      const clientToken = this.kp();
      const authHeaders = {
        accept: "application/json",
        "content-type": "application/json",
        "x-client-info": JSON.stringify({ timezone: "Asia/Singapore" }),
        "x-client-token": clientToken,
        authorization: `Bearer ${token}`,
        cookie: `token=${token}; netnaija_i18n_lang=en`,
        "x-request-lang": "en",
        "user-agent": UA,
        referer: `${BASE_URL}/en/search-result?keyword=${encodeURIComponent(searchTitle)}`,
      };

      // Step 1: Search for item
      const searchRes = await axios.post(
        `${BASE_URL}/wefeed-h5api-bff/subject/search`,
        {
          keyword: searchTitle,
          page: 1,
          perPage: 10,
        },
        { headers: authHeaders, timeout: 7000 },
      );

      const searchItems = searchRes.data?.data?.items;
      if (!Array.isArray(searchItems) || searchItems.length === 0) {
        console.log(`[Vesper/NetNaija] No items found for "${searchTitle}"`);
        return [];
      }

      // Match target subjectType: 1 = movie, 2 = TV series
      const targetType = kind === "movie" ? 1 : 2;
      const cleanSearch = searchTitle.toLowerCase().trim();

      let matchedItem = searchItems.find((item: any) => {
        const itemTitle = (item.title || item.name || "").toLowerCase().trim();
        return (
          item.subjectType === targetType &&
          (itemTitle === cleanSearch || itemTitle.includes(cleanSearch) || cleanSearch.includes(itemTitle))
        );
      });

      if (!matchedItem) {
        // Fallback to first item matching subjectType if title fuzzy match fails
        matchedItem = searchItems.find(
          (item: any) => item.subjectType === targetType,
        );
      }

      if (!matchedItem || !matchedItem.subjectId || !matchedItem.detailPath) {
        console.log(
          `[Vesper/NetNaija] Match failed for TMDB ${numericTmdbId} ("${searchTitle}")`,
        );
        return [];
      }

      console.log(
        `[Vesper/NetNaija] Found match: "${matchedItem.title || matchedItem.name}" (subjectId: ${matchedItem.subjectId}, detailPath: ${matchedItem.detailPath})`,
      );

      // Step 2: Fetch play streams
      const se = kind === "tv" ? season : 0;
      const ep = kind === "tv" ? episode : 0;
      const playUrl = `${BASE_URL}/wefeed-h5api-bff/subject/play?subjectId=${matchedItem.subjectId}&se=${se}&ep=${ep}&detailPath=${encodeURIComponent(matchedItem.detailPath)}`;

      const playHeaders = {
        ...authHeaders,
        cookie: `token=${token}; netnaija_token="${token}"; netnaija_i18n_lang=en`,
        referer: `${BASE_URL}/videoPlayPage/${matchedItem.detailPath}?type=/${kind}/detail`,
      };

      const playRes = await axios.get(playUrl, {
        headers: playHeaders,
        timeout: 7000,
      });

      const streamsData = playRes.data?.data?.streams;
      if (!Array.isArray(streamsData) || streamsData.length === 0) {
        console.log(
          `[Vesper/NetNaija] No active streams in play response for TMDB ${numericTmdbId}`,
        );
        return [];
      }

      const mirrors: MirrorStream[] = [];
      for (const s of streamsData) {
        if (!s.url) continue;
        const resLabel = s.resolutions
          ? `${s.resolutions}p`
          : "HD";
        
        mirrors.push({
          url: s.url,
          quality: resLabel,
          type: "mp4",
          source: `Vesper (${resLabel})`,
          headers: {
            Referer: `${BASE_URL}/`,
            Origin: BASE_URL,
            "User-Agent": UA,
          },
        });
      }

      console.log(
        `[Vesper/NetNaija] ✅ Found ${mirrors.length} mirrors for TMDB ${numericTmdbId}`,
      );
      return mirrors;
    } catch (err: any) {
      console.error(
        `[Vesper/NetNaija] Error fetching streams for TMDB ${tmdbId}:`,
        err.message,
      );
      return [];
    }
  }
}
