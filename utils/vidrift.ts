import type { MirrorStream } from "./scraper.js";

export class VidriftScraper {
  private static UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

  private static makeHeaders(referer: string) {
    return {
      accept: "*/*",
      "accept-language": "en-US,en;q=0.6",
      "cache-control": "no-cache",
      pragma: "no-cache",
      referer,
      "user-agent": this.UA,
      "sec-ch-ua": '"Not;A=Brand";v="8", "Chromium";v="150", "Brave";v="150"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
      "sec-gpc": "1",
    };
  }

  public static async getStream(params: {
    tmdbId: string;
    kind: "movie" | "tv";
    season?: number;
    episode?: number;
    proxyUrl?: string | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<MirrorStream[]> {
    const { tmdbId, kind, season = 1, episode = 1, signal } = params;

    const referer =
      kind === "tv"
        ? `https://embed.vidrift.in/embed/tv/${tmdbId}/${season}/${episode}`
        : `https://embed.vidrift.in/embed/movie/${tmdbId}`;

    const servers = ["embed", "notorrent", "1embed"] as const;
    const serverDisplayNames: Record<string, string> = {
      embed: "Earth",
      notorrent: "Mars",
      "1embed": "Neptune",
    };

    console.log(`[VIDRIFT] Scraping streams for TMDB ${tmdbId} (${kind})`);

    // 1. Fetch Subtitles
    let subtitles: any[] = [];
    try {
      const subUrl =
        kind === "tv"
          ? `https://embed.vidrift.in/api/source/subtitles/tv/${tmdbId}/${season}/${episode}`
          : `https://embed.vidrift.in/api/source/subtitles/movie/${tmdbId}`;

      const reqInit1: RequestInit = { headers: this.makeHeaders(referer) };
      if (signal) reqInit1.signal = signal;

      const res = await fetch(subUrl, reqInit1);

      if (res.ok) {
        const subData = (await res.json()) as any;
        if (subData && subData.success && Array.isArray(subData.subtitles)) {
          subtitles = subData.subtitles
            .filter((s: any) => s.file)
            .map((s: any) => ({
              url: s.file,
              lang: s.label || "en",
              languageName: s.label || "English",
              source: "Vidrift",
            }));
          console.log(
            `[VIDRIFT] Found ${subtitles.length} subtitles for TMDB ${tmdbId}`,
          );
        }
      }
    } catch (err: any) {
      console.warn(
        `[VIDRIFT] Subtitle fetch failed for TMDB ${tmdbId}: ${err.message}`,
      );
    }

    // 2. Fetch Streams in parallel
    const scrapePromises = servers.map(async (server) => {
      let url =
        kind === "tv"
          ? `https://embed.vidrift.in/api/source/tv/${tmdbId}/${season}/${episode}?source=${server}`
          : `https://embed.vidrift.in/api/source/movie/${tmdbId}?source=${server}`;

      try {
        const reqInit2: RequestInit = { headers: this.makeHeaders(referer) };
        if (signal) reqInit2.signal = signal;

        const res = await fetch(url, reqInit2);

        if (!res.ok) {
          return null;
        }

        const data = (await res.json()) as any;

        if (!data || !data.success || !Array.isArray(data.streams)) {
          return null;
        }

        const firstStream = data.streams[0];
        if (!firstStream || !firstStream.url) {
          return null;
        }

        const label = serverDisplayNames[server] || server;
        return {
          url: firstStream.url,
          source: `Vidrift (${label})`,
          quality: "Auto",
          type: "hls" as const,
          subtitles,
        };
      } catch (err: any) {
        console.warn(
          `[VIDRIFT] Failed to fetch server ${server} for TMDB ${tmdbId}: ${err.message}`,
        );
        return null;
      }
    });

    const results = await Promise.all(scrapePromises);
    const validMirrors = results.filter((m) => m !== null) as MirrorStream[];

    return validMirrors;
  }
}
