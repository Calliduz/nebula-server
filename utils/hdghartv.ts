/**
 * utils/hdghartv.ts
 * Scraper utility for HDGharTV (https://hdghartv.cc/).
 * Provides multi-quality HLS streams (1080p, 720p, 480p) with multi-audio support.
 */

import axios from "axios";
import type { MirrorStream } from "./scraper.js";

const BASE_URL = "https://hdghartv.cc";
const UA =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36";

export interface HdgHarTvOptions {
  tmdbId: string | number;
  type: "movie" | "tv";
  season?: number;
  episode?: number;
  title?: string | undefined;
}

export class HdgHarTvScraper {
  /**
   * Main entry point to get streaming mirrors from HDGharTV.
   */
  static async getStream(options: HdgHarTvOptions): Promise<MirrorStream[]> {
    const { tmdbId, type, season = 1, episode = 1 } = options;
    const numericTmdbId = typeof tmdbId === "string" ? parseInt(tmdbId, 10) : tmdbId;

    try {
      // Step 1: Fetch title using TMDB API or title query if title not passed
      let searchTitle: string | undefined = options.title;
      if (!searchTitle && numericTmdbId) {
        searchTitle = await this.getTmdbTitle(numericTmdbId, type);
      }

      if (!searchTitle) {
        console.warn(`[HDGharTV Scraper] Could not determine title for TMDB ID: ${tmdbId}`);
        return [];
      }

      console.log(`[HDGharTV Scraper] Searching for "${searchTitle}" (TMDB: ${numericTmdbId})...`);

      // Step 2: Search HDGharTV API
      const searchUrl = `${BASE_URL}/api/search?q=${encodeURIComponent(searchTitle)}`;
      const searchRes = await axios.get(searchUrl, {
        headers: {
          "User-Agent": UA,
          Accept: "application/json, text/plain, */*",
          Referer: `${BASE_URL}/watch`,
        },
        timeout: 8000,
      });

      const searchData = searchRes.data;
      if (!searchData) return [];

      const targetCategory = type === "movie" ? searchData.movies : searchData.series;
      if (!Array.isArray(targetCategory) || targetCategory.length === 0) {
        console.log(`[HDGharTV Scraper] No ${type} items found for "${searchTitle}"`);
        return [];
      }

      // Step 3: Match by tmdbId or title
      let matchedItem = targetCategory.find(
        (item: any) => item.tmdbId && Number(item.tmdbId) === numericTmdbId
      );

      if (!matchedItem) {
        const cleanSearch = searchTitle.toLowerCase().trim();
        matchedItem = targetCategory.find(
          (item: any) =>
            item.title && item.title.toLowerCase().trim() === cleanSearch
        );
      }

      if (!matchedItem) {
        console.log(`[HDGharTV Scraper] Match failed for TMDB ${numericTmdbId} in search results`);
        return [];
      }

      const contentId = matchedItem._id;
      console.log(`[HDGharTV Scraper] Found ${type} match: ${matchedItem.title} (_id: ${contentId})`);

      // Step 4: Fetch details & streams
      const mirrors: MirrorStream[] = [];

      if (type === "movie") {
        const detailUrl = `${BASE_URL}/api/movies/public/${contentId}`;
        const detailRes = await axios.get(detailUrl, {
          headers: { "User-Agent": UA, Referer: `${BASE_URL}/watch` },
          timeout: 8000,
        });

        const links = detailRes.data?.streamingLinks || [];
        for (const link of links) {
          if (link.url && link.isActive !== false) {
            const quality = link.quality || "HD";
            mirrors.push({
              url: link.url,
              quality: quality.toLowerCase().includes("1080") ? "1080p" : quality.toLowerCase().includes("720") ? "720p" : "480p",
              type: "hls",
              source: `HDGharTV (${quality})`,
              headers: {
                Referer: `${BASE_URL}/`,
                Origin: BASE_URL,
              },
            });
          }
        }
      } else {
        // TV Series
        const detailUrl = `${BASE_URL}/api/series/public/${contentId}`;
        const detailRes = await axios.get(detailUrl, {
          headers: { "User-Agent": UA, Referer: `${BASE_URL}/watch` },
          timeout: 8000,
        });

        const seasons = detailRes.data?.seasons || [];
        const seasonObj = seasons.find((s: any) => Number(s.seasonNumber) === Number(season));
        if (!seasonObj) {
          console.log(`[HDGharTV Scraper] Season ${season} not found`);
          return [];
        }

        const episodeObj = (seasonObj.episodes || []).find(
          (ep: any) => Number(ep.episodeNumber) === Number(episode)
        );
        if (!episodeObj) {
          console.log(`[HDGharTV Scraper] Episode S${season}E${episode} not found`);
          return [];
        }

        const links = episodeObj.streamingLinks || [];
        for (const link of links) {
          if (link.url && link.isActive !== false) {
            const quality = link.quality || "HD";
            mirrors.push({
              url: link.url,
              quality: quality.toLowerCase().includes("1080") ? "1080p" : quality.toLowerCase().includes("720") ? "720p" : "480p",
              type: "hls",
              source: `HDGharTV (${quality})`,
              headers: {
                Referer: `${BASE_URL}/`,
                Origin: BASE_URL,
              },
            });
          }
        }
      }

      console.log(`[HDGharTV Scraper] ✅ Found ${mirrors.length} mirrors for TMDB ${numericTmdbId}`);
      return mirrors;
    } catch (err: any) {
      console.error(`[HDGharTV Scraper] Error fetching stream for TMDB ${tmdbId}:`, err.message);
      return [];
    }
  }

  /**
   * Helper to fetch title from TMDB if not provided
   */
  private static async getTmdbTitle(tmdbId: number, type: "movie" | "tv"): Promise<string | undefined> {
    try {
      const tmdbApiKey = process.env.TMDB_API_KEY || "8410c58030558e2d6e4f340d8ab92858";
      const url = `https://api.themoviedb.org/3/${type}/${tmdbId}?api_key=${tmdbApiKey}`;
      const res = await axios.get(url, { timeout: 5000 });
      return res.data?.title || res.data?.name || undefined;
    } catch {
      return undefined;
    }
  }
}
