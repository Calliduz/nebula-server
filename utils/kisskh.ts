import { hybridFetch } from "./fetcher.js";
import { type MirrorStream } from "./scraper.js";
import generateKissKHToken from "./kisskhToken.js";
import { VidLinkScraper } from "./vidlink.js";
import axios from "axios";

const KISSKH_BASE = "https://kisskh.do";
const KISSKH_API = `${KISSKH_BASE}/api`;
const VI_GUID = "62f176f3bb1b5b8e70e39932ad34a0c7";

/**
 * KissKH Scraper - Hybrid Browser Edition
 * Uses Puppeteer only when blocked, then falls back to ultra-fast HTTP.
 */
export class KissKHScraper {
  static async search(
    query: string,
    isHollywood: boolean = true,
    signal?: AbortSignal,
    typeOverride?: number,
  ): Promise<any[]> {
    const type =
      typeOverride !== undefined ? typeOverride : isHollywood ? 4 : 0;
    const url = `${KISSKH_API}/DramaList/Search?q=${encodeURIComponent(query)}&type=${type}`;
    console.log(`[KissKH] Searching: ${query} (Type: ${type})`);

    try {
      const data = await hybridFetch(url, {
        json: true,
        referer: KISSKH_BASE,
        signal,
      });
      return Array.isArray(data) ? data : [];
    } catch (e: any) {
      console.error(`[KissKH] Search failed:`, e.message);
      return [];
    }
  }

  static async getDramaDetail(id: number, signal?: AbortSignal): Promise<any> {
    const url = `${KISSKH_API}/DramaList/Drama/${id}?ispc=false`;
    const referer = `${KISSKH_BASE}/Drama/Detail?id=${id}`;
    try {
      return await hybridFetch(url, { json: true, referer, signal });
    } catch (e: any) {
      console.error(`[KissKH] Detail failed:`, e.message);
      return null;
    }
  }

  static async getStream(
    dramaId: number,
    epId: number,
  ): Promise<MirrorStream[]> {
    const mirrors: MirrorStream[] = [];
    const subtitles: any[] = [];
    const pageUrl = `${KISSKH_BASE}/Drama/v?id=${dramaId}&ep=${epId}`;
    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

    try {
      const commonMeta = [
        "kisskh",
        "kisskh",
        "kisskh",
        "kisskh",
        "kisskh",
        "kisskh",
      ];

      // 1. Generate kkey for Stream
      const streamKkey = (generateKissKHToken as any)(
        epId,
        null, // guid
        "2.8.10", // appVer
        VI_GUID, // viGuid (62f176f3...)
        4830201, // platformVer
        ...commonMeta,
      );

      // 2. Generate kkey for Subtitles
      const subKkey = (generateKissKHToken as any)(
        epId,
        null, // guid
        "2.8.10", // appVer
        "VgV52sWhwvBSf8BsM3BRY9weWiiCbtGp", // viGuid for subtitles
        4830201, // platformVer
        ...commonMeta,
      );

      const apiUrl = `${KISSKH_API}/DramaList/Episode/${epId}.png?err=false&ts=null&time=null&kkey=${streamKkey}`;
      const subApiUrl = `${KISSKH_API}/Sub/${epId}?kkey=${subKkey}`;

      console.log(
        `[KissKH] Fetching stream/subs for epId: ${epId} (Keys: ${streamKkey.substring(0, 8)}... / ${subKkey.substring(0, 8)}...)`,
      );

      // Try Direct API first
      let data: any = null;
      let subData: any = null;

      try {
        data = await hybridFetch(apiUrl, {
          json: true,
          referer: pageUrl,
          headers: { "User-Agent": ua },
        });
        subData = await hybridFetch(subApiUrl, {
          json: true,
          referer: pageUrl,
          headers: { "User-Agent": ua },
        });
      } catch (e: any) {
        console.warn(
          `[KissKH] Direct API error: ${e.message}. Trying Puppeteer fallback...`,
        );
      }

      // FALLBACK 1: Puppeteer (if direct API returned no Video or failed)
      if (!data || !data.Video) {
        console.log(`[KissKH] Falling back to Puppeteer for epId: ${epId}...`);
        try {
          data = await hybridFetch(apiUrl, {
            json: true,
            referer: pageUrl,
            headers: { "User-Agent": ua },
            forceBrowser: true,
          });
          if (!subData || !Array.isArray(subData)) {
            subData = await hybridFetch(subApiUrl, {
              json: true,
              referer: pageUrl,
              headers: { "User-Agent": ua },
              forceBrowser: true,
            });
          }
        } catch (e: any) {
          console.warn(`[KissKH] Puppeteer fallback failed: ${e.message}`);
        }
      }

      if (subData && Array.isArray(subData)) {
        console.log(
          `[KissKH] Found ${subData.length} subtitles for epId: ${epId}`,
        );
        subData.forEach((s: any) => {
          if (s.src) {
            subtitles.push({
              url: s.src,
              lang: s.land || "en",
              languageName: s.label || "English",
              source: "KissKH",
            });
          }
        });
      }

      if (data && data.Video) {
        mirrors.push({
          url: data.Video,
          quality: "Auto",
          source: "KissKH",
          type: "hls",
          subtitles: subtitles.length > 0 ? subtitles : undefined,
        });
      }
    } catch (e: any) {
      console.error(`[KissKH] Primary extraction logic failed:`, e.message);
    }

    // FALLBACK 2: VidLink (if KissKH failed completely)
    if (mirrors.length === 0) {
      console.log(
        `[KissKH] No mirrors found via KissKH. Falling back to VidLink.pro...`,
      );
      try {
        const detail = await this.getDramaDetail(dramaId);
        if (detail && detail.title) {
          const isTV = detail.type === "TVSeries";
          const epInfo = detail.episodes?.find((e: any) => e.id === epId);
          const epNum = epInfo?.number || 1;

          // Try to find TMDB ID
          const year = detail.releaseDate
            ? new Date(detail.releaseDate).getFullYear()
            : undefined;
          const tmdbId = await this.findTmdbId(
            detail.title,
            isTV ? "tv" : "movie",
            year,
          );
          if (tmdbId) {
            console.log(
              `[KissKH] Fallback to VidLink: Using TMDB ID ${tmdbId} for ${detail.title} (${year || "N/A"}) S1E${epNum}`,
            );
            const vidlinkMirrors = await VidLinkScraper.getStream(
              tmdbId.toString(),
              isTV ? "tv" : "movie",
              1, // Assume Season 1 for now
              epNum,
            );
            if (vidlinkMirrors.length > 0) {
              mirrors.push(...vidlinkMirrors);
            }
          }
        }
      } catch (e: any) {
        console.error(`[KissKH] VidLink fallback failed:`, e.message);
      }
    }

    return mirrors;
  }

  private static async findTmdbId(
    title: string,
    type: "movie" | "tv",
    year?: number,
  ): Promise<number | null> {
    const apiKey = process.env.TMDB_API_KEY;
    if (!apiKey) return null;

    try {
      let url = `https://api.themoviedb.org/3/search/${type}?query=${encodeURIComponent(title)}&include_adult=false&language=en-US&page=1`;
      if (year) {
        url += `&${type === "movie" ? "primary_release_year" : "first_air_date_year"}=${year}`;
      }

      const headers = apiKey.startsWith("ey")
        ? { Authorization: `Bearer ${apiKey}` }
        : { params: { api_key: apiKey } };

      const res = await axios.get(url, {
        headers: apiKey.startsWith("ey") ? headers : {},
        params: !apiKey.startsWith("ey") ? (headers as any).params : {},
      });

      if (res.data.results && res.data.results.length > 0) {
        return res.data.results[0].id;
      }
    } catch (e: any) {
      console.warn(`[TMDB] Search failed for ${title}:`, e.message);
    }
    return null;
  }

  static async getExploreList(
    type: number = 0,
    country: number = 0,
    page: number = 1,
    order: number = 1,
  ): Promise<any[]> {
    // Fetch 2 pages in parallel to increase discovery depth
    const url1 = `${KISSKH_API}/DramaList/List?page=${page * 2 - 1}&type=${type}&sub=0&country=${country}&status=0&order=${order}`;
    const url2 = `${KISSKH_API}/DramaList/List?page=${page * 2}&type=${type}&sub=0&country=${country}&status=0&order=${order}`;

    console.log(
      `[KissKH] Discovering: Page ${page * 2 - 1} & ${page * 2} (Country: ${country}, Type: ${type})`,
    );

    try {
      const [res1, res2] = await Promise.all([
        hybridFetch(url1, { json: true, referer: KISSKH_BASE }).catch((err) => {
          console.error(
            `[KissKH] ✘ Discovery Page ${page * 2 - 1} failed: ${err.message}`,
          );
          return null;
        }),
        hybridFetch(url2, { json: true, referer: KISSKH_BASE }).catch((err) => {
          console.error(
            `[KissKH] ✘ Discovery Page ${page * 2} failed: ${err.message}`,
          );
          return null;
        }),
      ]);

      const results = [...(res1?.data || []), ...(res2?.data || [])];

      console.log(
        `[KissKH] ✅ Discovery Success: Found ${results.length} records (${res1?.data?.length || 0} + ${res2?.data?.length || 0})`,
      );

      // Deduplicate just in case
      const seen = new Set();
      return results.filter((item) => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      });
    } catch (e: any) {
      console.error(`[KissKH] ✘ Discovery Pipeline crashed:`, e.message);
      return [];
    }
  }
}
