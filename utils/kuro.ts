import type { MirrorStream, SubtitleStream } from "./scraper.js";

const BASE_API = "https://anime-scraper-v2.vercel.app";

const PROVIDERS = [
  "kuhi",
  "pahe",
  "rea",
  "koto",
  "egg",
  "neko",
  "anidb",
] as const;

export class KuroScraper {
  private static UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

  private static makeHeaders() {
    return {
      "User-Agent": this.UA,
      Accept: "application/json, text/plain, */*",
      Referer: "https://anime-scraper-v2.vercel.app/",
    };
  }

  /**
   * Cleans title string for search query (removes year, S1, etc.)
   */
  private static cleanTitle(title: string): string {
    return title
      .replace(/\(\d{4}\)/g, "")
      .replace(/Season\s+\d+/gi, "")
      .replace(/S\d+E\d+/gi, "")
      .replace(/S\d+/gi, "")
      .trim();
  }

  /**
   * Resolves AniList ID from Kuro search (/search?query=...)
   */
  private static async resolveAnilistId(
    title?: string,
    tmdbId?: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    if (!title && !tmdbId) return null;

    const searchStr = title ? this.cleanTitle(title) : tmdbId;
    if (!searchStr) return tmdbId ? String(tmdbId) : null;

    try {
      const reqInit: RequestInit = { headers: this.makeHeaders() };
      if (signal) reqInit.signal = signal;

      const res = await fetch(
        `${BASE_API}/search?query=${encodeURIComponent(searchStr)}&page=1&per_page=10`,
        reqInit,
      );

      if (res.ok) {
        const data = (await res.json()) as any;
        const mediaList = Array.isArray(data.media)
          ? data.media
          : Array.isArray(data.results)
            ? data.results
            : Array.isArray(data.data)
              ? data.data
              : [];

        if (mediaList.length > 0) {
          const targetClean = searchStr.toLowerCase();
          const match = mediaList.find((m: any) => {
            const rom = (m.title?.romaji || "").toLowerCase();
            const eng = (m.title?.english || "").toLowerCase();
            return (
              rom.includes(targetClean) ||
              targetClean.includes(rom) ||
              (eng && (eng.includes(targetClean) || targetClean.includes(eng)))
            );
          });

          const selected = match || mediaList[0];
          const foundId = selected.id || selected.anilistId;
          if (foundId) {
            console.log(
              `[KURO] AniList ID resolved for "${searchStr}": ${foundId} (${selected.title?.english || selected.title?.romaji})`,
            );
            return String(foundId);
          }
        }
      }
    } catch (err: any) {
      console.warn(`[KURO] AniList ID resolution failed: ${err.message}`);
    }

    return tmdbId ? String(tmdbId) : null;
  }

  /**
   * Extracts streams and subtitles from a Kuro watch payload (Sub or Dub)
   */
  private static parseKuroPayload(
    data: any,
    providerName: string,
    subDubType: "sub" | "dub",
  ): { streams: MirrorStream[]; subtitles: SubtitleStream[] } {
    if (!data) return { streams: [], subtitles: [] };

    const subtitles: SubtitleStream[] = [];
    const streams: MirrorStream[] = [];

    // Navigate nested ssub / sdub / response containers
    const containers = [
      data.ssub,
      data.sdub,
      data.response?.ssub,
      data.response?.sdub,
      data.response,
      data,
    ].filter(Boolean);

    // 1. Extract subtitles
    containers.forEach((c: any) => {
      const subList = c.subtitles || c.subs;
      if (Array.isArray(subList)) {
        subList.forEach((s: any) => {
          const fileUrl = s.file || s.url;
          if (fileUrl && !subtitles.some((sub) => sub.url === fileUrl)) {
            subtitles.push({
              url: fileUrl,
              lang: s.language || s.lang || "en",
              languageName: s.label || s.language || "English",
              source: "Kuro",
            });
          }
        });
      }
    });

    // 2. Extract streams
    const subDubTag = subDubType.toUpperCase(); // SUB or DUB
    containers.forEach((c: any) => {
      const streamList = c.streams || c.sources;
      if (Array.isArray(streamList)) {
        streamList.forEach((s: any) => {
          const streamUrl = s.url || s.file;
          if (!streamUrl || s.type === "embed") return; // Skip embed iframe URLs

          const isHls =
            streamUrl.includes(".m3u8") ||
            s.type === "hls" ||
            s.type?.includes("mpegurl") ||
            s.isM3U8;

          const serverName = s.server || providerName.toUpperCase();
          const defaultReferer =
            serverName.toLowerCase().includes("vidwish") ||
            providerName.toLowerCase().includes("vidwish")
              ? "https://vidwish.live/"
              : "https://megaplay.buzz/";

          streams.push({
            url: streamUrl,
            source: `Kuro (${serverName} ${subDubTag})`,
            quality: s.quality ? `${s.quality}p` : "Auto",
            type: isHls ? "hls" : "mp4",
            audio: subDubType === "dub" ? "English Dub" : "Japanese Sub",
            headers: {
              Referer: s.referer || defaultReferer,
              ...(s.headers || {}),
            },
            subtitles,
          });
        });
      }
    });

    // Fallback: direct m3u8 property
    if (streams.length === 0 && data.m3u8) {
      const defaultReferer = providerName.toLowerCase().includes("vidwish")
        ? "https://vidwish.live/"
        : "https://megaplay.buzz/";

      streams.push({
        url: data.m3u8,
        source: `Kuro (${providerName.toUpperCase()} ${subDubTag})`,
        quality: "Auto",
        type: "hls",
        audio: subDubType === "dub" ? "English Dub" : "Japanese Sub",
        headers: { Referer: defaultReferer },
        subtitles,
      });
    }

    return { streams, subtitles };
  }

  public static async getStream(params: {
    tmdbId: string;
    title?: string | undefined;
    kind: "movie" | "tv";
    season?: number | undefined;
    episode?: number | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<MirrorStream[]> {
    const { tmdbId, title, kind, season = 1, episode = 1, signal } = params;

    console.log(
      `[KURO] Scraping anime streams for TMDB/ID ${tmdbId} title="${title || ""}" S${season}E${episode}`,
    );

    const targetId = await this.resolveAnilistId(title, tmdbId, signal);
    if (!targetId) {
      console.warn(`[KURO] Could not resolve AniList target ID for ${tmdbId}`);
      return [];
    }

    // Query default endpoint + parallel provider endpoints for BOTH sub and dub
    const providerList = ["default", ...PROVIDERS] as const;
    const subDubTypes = ["sub", "dub"] as const;

    const scrapePromises: Promise<MirrorStream[]>[] = [];

    providerList.forEach((provider) => {
      subDubTypes.forEach((subDub) => {
        scrapePromises.push(
          (async (): Promise<MirrorStream[]> => {
            const isDefault = provider === "default";
            const watchUrl = isDefault
              ? `${BASE_API}/default/${targetId}/${subDub}/${episode}`
              : `${BASE_API}/watch/${provider}/${targetId}/${subDub}/${provider}-${episode}`;

            try {
              const reqInit: RequestInit = { headers: this.makeHeaders() };
              if (signal) reqInit.signal = signal;

              const res = await fetch(watchUrl, reqInit);
              if (!res.ok) return [];

              const data = (await res.json()) as any;
              const { streams } = this.parseKuroPayload(
                data,
                provider,
                subDub,
              );
              return streams;
            } catch (err: any) {
              return [];
            }
          })(),
        );
      });
    });

    const results = await Promise.all(scrapePromises);
    const validMirrors = results.flat();

    // Deduplicate by URL
    const seenUrls = new Set<string>();
    const dedupedMirrors = validMirrors.filter((m) => {
      if (seenUrls.has(m.url)) return false;
      seenUrls.add(m.url);
      return true;
    });

    console.log(
      `[KURO] Resolved ${dedupedMirrors.length} valid anime sub/dub mirrors for TMDB ${tmdbId} (AniList ${targetId})`,
    );
    return dedupedMirrors;
  }
}
