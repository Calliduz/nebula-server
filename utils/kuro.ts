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
   * Resolves AniList ID and target episode from Kuro search (/search?query=...)
   */
  public static async resolveAnilistTarget(
    title?: string,
    tmdbId?: string,
    kind: "movie" | "tv" = "tv",
    season: number = 1,
    episode: number = 1,
    signal?: AbortSignal,
  ): Promise<{ targetId: string | null; targetEpisode: number }> {
    if (!title && !tmdbId) return { targetId: null, targetEpisode: episode };

    const cleanBase = title ? this.cleanTitle(title) : tmdbId;
    if (!cleanBase)
      return {
        targetId: tmdbId ? String(tmdbId) : null,
        targetEpisode: episode,
      };

    const ordinal =
      season === 1
        ? "1st"
        : season === 2
          ? "2nd"
          : season === 3
            ? "3rd"
            : `${season}th`;

    const queries: string[] = [];
    if (kind === "tv" && season > 1) {
      queries.push(`${cleanBase} Season ${season}`);
      queries.push(`${cleanBase} ${ordinal} Season`);
      queries.push(cleanBase);
    } else {
      queries.push(cleanBase);
    }

    const baseLower = cleanBase.toLowerCase();
    let selectedMedia: any = null;

    for (const q of queries) {
      try {
        const reqInit: RequestInit = { headers: this.makeHeaders() };
        if (signal) reqInit.signal = signal;

        const res = await fetch(
          `${BASE_API}/search?query=${encodeURIComponent(q)}&page=1&per_page=10`,
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
            const relevantMedia = mediaList.filter((m: any) => {
              const eng = (m.title?.english || "").toLowerCase();
              const rom = (m.title?.romaji || "").toLowerCase();
              return (
                eng.includes(baseLower) ||
                rom.includes(baseLower) ||
                baseLower.includes(eng) ||
                baseLower.includes(rom)
              );
            });

            const candidates =
              relevantMedia.length > 0 ? relevantMedia : mediaList;
            let match: any = null;

            if (kind === "tv") {
              if (season > 1) {
                const sRegex = new RegExp(
                  `Season\\s*${season}|${season}(st|nd|rd|th)\\s*Season|Part\\s*${season}`,
                  "i",
                );
                match = candidates.find((m: any) => {
                  const eng = m.title?.english || "";
                  const rom = m.title?.romaji || "";
                  return (
                    (m.format === "TV" ||
                      m.format === "ONA" ||
                      m.format === "TV_SHORT") &&
                    (sRegex.test(eng) || sRegex.test(rom))
                  );
                });
              } else if (season === 1) {
                match = candidates.find((m: any) => {
                  const eng = m.title?.english || "";
                  const rom = m.title?.romaji || "";
                  const isOtherSeason =
                    /Season\s*[2-9]|\d+(nd|rd|th)\s*Season/i.test(eng) ||
                    /Season\s*[2-9]|\d+(nd|rd|th)\s*Season/i.test(rom);
                  return (
                    (m.format === "TV" ||
                      m.format === "ONA" ||
                      m.format === "TV_SHORT") &&
                    !isOtherSeason
                  );
                });
              }
            }

            if (!match && q.includes("Season")) {
              match = candidates.find(
                (m: any) =>
                  m.format === "TV" ||
                  m.format === "ONA" ||
                  m.format === "TV_SHORT",
              );
            }

            if (!match && q !== cleanBase) continue;
            if (!match)
              match =
                candidates.find(
                  (m: any) => m.format === "TV" || m.format === "ONA",
                ) || candidates[0];

            if (match) {
              selectedMedia = match;
              break;
            }
          }
        }
      } catch (err: any) {
        console.warn(
          `[KURO] AniList ID resolution error for "${q}": ${err.message}`,
        );
      }
    }

    if (!selectedMedia) {
      return {
        targetId: tmdbId ? String(tmdbId) : null,
        targetEpisode: episode,
      };
    }

    let targetId = String(selectedMedia.id || selectedMedia.anilistId);
    let targetEpisode = episode;

    // Episode Overflow Handling specifically scoped for Campfire Cooking (or TMDB consolidated S1)
    const isCampfireCooking = /campfire\s*cooking/i.test(title || "");
    if (
      kind === "tv" &&
      season === 1 &&
      isCampfireCooking &&
      selectedMedia.episodes &&
      episode > selectedMedia.episodes
    ) {
      const overflowEp = episode - selectedMedia.episodes;
      try {
        const reqInit: RequestInit = { headers: this.makeHeaders() };
        if (signal) reqInit.signal = signal;

        const s2Res = await fetch(
          `${BASE_API}/search?query=${encodeURIComponent(`${cleanBase} Season 2`)}&page=1&per_page=5`,
          reqInit,
        );

        if (s2Res.ok) {
          const s2Data = (await s2Res.json()) as any;
          const s2List = s2Data.media || s2Data.results || [];
          const s2Match =
            s2List.find((m: any) => {
              const eng = m.title?.english || "";
              const rom = m.title?.romaji || "";
              return (
                (m.format === "TV" || m.format === "ONA") &&
                (/Season\s*2|2nd\s*Season/i.test(eng) ||
                  /Season\s*2|2nd\s*Season/i.test(rom))
              );
            }) || s2List[0];

          if (s2Match) {
            targetId = String(s2Match.id || s2Match.anilistId);
            targetEpisode = overflowEp;
            console.log(
              `[KURO OVERFLOW] Mapped TMDB S1 E${episode} -> Season 2 AniList ID ${targetId} (${s2Match.title?.english || s2Match.title?.romaji}), Episode ${targetEpisode}`,
            );
          }
        }
      } catch (err: any) {
        console.warn(
          `[KURO OVERFLOW] Error fetching Season 2 overflow: ${err.message}`,
        );
      }
    }

    console.log(
      `[KURO] AniList target resolved for "${title || tmdbId}" (S${season}E${episode}): ID=${targetId}, Ep=${targetEpisode} (${selectedMedia.title?.english || selectedMedia.title?.romaji})`,
    );

    return { targetId, targetEpisode };
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

    const { targetId, targetEpisode } = await this.resolveAnilistTarget(
      title,
      tmdbId,
      kind,
      season,
      episode,
      signal,
    );
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
              ? `${BASE_API}/default/${targetId}/${subDub}/${targetEpisode}`
              : `${BASE_API}/watch/${provider}/${targetId}/${subDub}/${provider}-${targetEpisode}`;

            try {
              const reqInit: RequestInit = { headers: this.makeHeaders() };
              if (signal) reqInit.signal = signal;

              const res = await fetch(watchUrl, reqInit);
              if (!res.ok) return [];

              const data = (await res.json()) as any;
              const { streams } = this.parseKuroPayload(data, provider, subDub);
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
