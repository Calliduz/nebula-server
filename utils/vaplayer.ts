import { gotScraping } from "got-scraping";
import type { MirrorStream, SubtitleStream } from "./scraper.js";

export class VaplayerScraper {
  public static async getStream(params: {
    tmdbId: string;
    kind: "movie" | "tv";
    season?: number;
    episode?: number;
    proxyUrl?: string | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<MirrorStream[]> {
    const { tmdbId, kind, season = 1, episode = 1, proxyUrl, signal } = params;

    let url = `https://streamdata.vaplayer.ru/api.php?tmdb=${tmdbId}&type=${kind}`;
    if (kind === "tv") {
      url += `&season=${season}&episode=${episode}`;
    }

    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
      "Origin": "https://nextgencloudfabric.com",
      "Referer": "https://nextgencloudfabric.com/",
    };

    const gotOptions: any = {
      headers,
      responseType: "json",
      timeout: { request: 15000 },
    };
    if (proxyUrl) gotOptions.proxyUrl = proxyUrl;
    if (signal) gotOptions.signal = signal;

    console.log(`[VAPLAYER] Scraping stream from: ${url}`);
    const res = await gotScraping.get(url, gotOptions);
    const payload = res.body as any;

    const isSuccess =
      payload?.status_code === "200" || payload?.status_code === 200;
    if (!isSuccess || !payload?.data) {
      console.warn(
        `[VAPLAYER] API returned non-200 or empty data for TMDB ${tmdbId}`,
      );
      return [];
    }

    const streams = payload.data.stream_urls || [];
    if (!Array.isArray(streams) || streams.length === 0) {
      return [];
    }

    // Parse subtitles if present in default_subs
    let subtitles: SubtitleStream[] = [];
    if (Array.isArray(payload.default_subs)) {
      subtitles = payload.default_subs
        .filter((s: any) => s.url)
        .map((s: any) => ({
          url: s.url,
          lang: s.lang || s.label || "en",
          languageName: s.label || s.lang || "English",
          source: "Vaplayer",
        }));
    }

    // Map each stream URL to a MirrorStream
    return streams.map((streamUrl: string, index: number) => {
      return {
        url: streamUrl || "",
        source: `Vaplayer (Mirror ${index + 1})`,
        quality: "Auto",
        type: "hls",
        subtitles,
      };
    });
  }
}
