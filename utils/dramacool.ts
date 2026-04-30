import axios from "axios";
import * as cheerio from "cheerio";
import { type MirrorStream } from "./scraper.js";

const DRAMACOOL_BASE = "https://dramacooll.fun";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

export class DramacoolScraper {
  /**
   * Slugifies a string for Dramacool URLs
   */
  private static slugify(text: string): string {
    return text
      .toString()
      .toLowerCase()
      .trim()
      .replace(/\s+/g, "-") // Replace spaces with -
      .replace(/[^\w-]+/g, "") // Remove all non-word chars
      .replace(/--+/g, "-"); // Replace multiple - with single -
  }

  /**
   * Searches for a drama. On Dramacool, we often guess the slug.
   */
  static async search(
    query: string,
    year?: number,
    signal?: AbortSignal
  ): Promise<any[]> {
    console.log(`[Dramacool] Searching: ${query} (${year || "Any Year"})`);
    const slug = this.slugify(query);
    const results: any[] = [];

    // Try a few variations
    const candidates = [
      year ? `${slug}-${year}` : null,
      slug,
    ].filter(Boolean) as string[];

    for (const cand of candidates) {
      const url = `${DRAMACOOL_BASE}/series/${cand}/`;
      try {
        const res = await axios.get(url, { 
          maxRedirects: 5,
          signal: signal as any,
          timeout: 5000,
          validateStatus: (status) => status >= 200 && status < 400
        });

        if (res.status === 200) {
          const $ = cheerio.load(res.data);
          const title = $("h1").text() || query;
          results.push({
            id: cand,
            title,
            url: res.request.res.responseUrl || url,
          });
          // If we found a direct match, stop
          break;
        }
      } catch (e: any) {
        // Skip 404s
      }
    }

    // If still no results, try the actual search page (though it's finicky)
    if (results.length === 0) {
      try {
        const searchUrl = `${DRAMACOOL_BASE}/?s=${encodeURIComponent(query)}`;
        const res = await axios.get(searchUrl, { signal: signal as any, timeout: 8000 });
        const $ = cheerio.load(res.data);
        
        $(".block-tab .all-episode li, .block-tab .list-episode-item li").each((_, el) => {
          const a = $(el).find("a");
          const title = a.find(".title").text() || a.text();
          const href = a.attr("href");
          
            const parts = href.split("/series/");
            if (parts[1]) {
              const id = parts[1].replace(/\//g, "");
              if (!results.find(r => r.id === id)) {
                results.push({ id, title, url: href });
              }
            }
        });
      } catch (e: any) {
        console.error(`[Dramacool] Search page failed:`, e.message);
      }
    }

    return results;
  }

  static async getDramaDetail(id: string, signal?: AbortSignal): Promise<any> {
    const url = id.startsWith("http") ? id : `${DRAMACOOL_BASE}/series/${id}/`;
    console.log(`[Dramacool] Fetching detail: ${url}`);
    
    try {
      const res = await axios.get(url, { signal: signal as any, timeout: 10000 });
      const $ = cheerio.load(res.data);
      
      const episodes: any[] = [];
      $(".list-episode-item-2.all-episode li").each((_, el) => {
        const a = $(el).find("a");
        const title = a.find(".title").text() || a.text();
        const href = a.attr("href");
        
        // Extract episode number
        const epMatch = title.match(/Episode\s+(\d+(\.\d+)?)/i);
        const epNum = (epMatch && epMatch[1]) ? parseFloat(epMatch[1]) : 0;
        
        if (href) {
          episodes.push({
            id: href, // We'll use the full URL as ID for episodes
            number: epNum,
            title,
            url: href.startsWith("http") ? href : `${DRAMACOOL_BASE}${href}`
          });
        }
      });

      return {
        id,
        title: $("h1").text(),
        episodes: episodes.sort((a, b) => a.number - b.number)
      };
    } catch (e: any) {
      console.error(`[Dramacool] Detail failed:`, e.message);
      return null;
    }
  }

  static async getStream(
    dramaId: string,
    epUrl: string,
  ): Promise<MirrorStream[]> {
    console.log(`[Dramacool] Getting stream for: ${epUrl}`);
    
    try {
      // 1. Fetch episode page
      const res = await axios.get(epUrl, { 
        timeout: 10000,
        headers: {
          'User-Agent': UA
        }
      });
      const $ = cheerio.load(res.data);
      
      // 2. Find embed iframe
      let embedUrl = $("iframe[src*='embedload']").attr("src") || 
                    $("iframe[src*='asianembed']").attr("src") ||
                    $("iframe[src*='watch']").attr("src") ||
                    $(".play-video iframe").attr("src");
      
      if (!embedUrl) {
         embedUrl = $(".Standard.Server[data-video]").attr("data-video");
      }

      if (!embedUrl) {
        console.error(`[Dramacool] Embed URL not found on page`);
        return [];
      }

      if (embedUrl.startsWith("//")) embedUrl = "https:" + embedUrl;
      embedUrl = embedUrl.trim();

      console.log(`[Dramacool] Returning embed URL: ${embedUrl}`);

      return [{
        url: embedUrl,
        quality: "Embed",
        source: "Dramacool",
        type: "embed" as any, 
        headers: {
          Referer: epUrl
        }
      }];
    } catch (e: any) {
      console.error(`[Dramacool] Failed to get embed URL:`, e.message);
      return [];
    }
  }

  static async getExploreList(page: number = 1, country?: string) {
    try {
      let url = `${DRAMACOOL_BASE}/most-popular-drama/page/${page}/`;
      if (country) {
        url = `${DRAMACOOL_BASE}/country/${country}/page/${page}/`;
      }

      console.log(`[DRAMACOOL] Fetching explore: ${url}`);
      const response = await axios.get(url, { headers: { "User-Agent": UA } });
      const $ = cheerio.load(response.data);
      const results: any[] = [];

      $(".list-episode-item li").each((_, el) => {
        const a = $(el).find("a");
        const title = a.find(".title").text().trim();
        const img = a.find("img").attr("data-original") || a.find("img").attr("src");
        const id = a.attr("href")?.split("/").filter(Boolean).pop();
        
        if (id && title) {
          results.push({
            id,
            title,
            image: img,
            type: "tv",
            genre: "Drama",
            rating: "N/A",
            countryId: country || "All",
            origin: "dramacool",
            isDrama: true
          });
        }
      });

      return results;
    } catch (err: any) {
      console.error(`[DRAMACOOL] Explore Error: ${err.message}`);
      return [];
    }
  }
}
