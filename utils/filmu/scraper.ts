import { gotScraping } from "got-scraping";
import type { MirrorStream, SubtitleStream } from "../scraper.js";
import { getLanguageName } from "../subtitles.js";
import {
  getKuroToken,
  searchKuro,
  getKuroMeta,
  getKuroStreams,
  getVortexStreams,
  getZenithStreams,
  getAuraStreams,
} from "./endpoints.js";

interface TMDBMetadata {
  title: string;
  year: number;
  imdbId?: string;
  isAnimation: boolean;
}

/**
 * Normalizes titles for fuzzy comparison
 */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

/**
 * Compares two titles for string match
 */
function isTitleMatch(t1: string, t2: string): boolean {
  const n1 = normalizeTitle(t1);
  const n2 = normalizeTitle(t2);
  return n1 === n2 || n1.includes(n2) || n2.includes(n1);
}

export class FilmuScraper {
  /**
   * Fetches metadata from TMDB API including genres (checking for Animation)
   */
  public static async getTMDBMetadata(
    tmdbId: string,
    kind: "movie" | "tv",
    signal?: AbortSignal | undefined,
  ): Promise<TMDBMetadata> {
    const apiKey = process.env.TMDB_API_KEY;
    if (!apiKey) {
      throw new Error("TMDB_API_KEY is not configured in the environment");
    }

    const typePath = kind === "movie" ? "movie" : "tv";
    const url = `https://api.themoviedb.org/3/${typePath}/${tmdbId}`;

    try {
      const response = await gotScraping.get(url, {
        headers: {
          Authorization: apiKey.length > 40 ? `Bearer ${apiKey}` : undefined,
        },
        searchParams: apiKey.length <= 40 ? { api_key: apiKey } : {},
        responseType: "json",
        timeout: { request: 8000 },
        signal,
      });

      const data = response.body as any;
      const title =
        kind === "movie"
          ? data.title || data.original_title
          : data.name || data.original_name;
      const dateStr =
        kind === "movie" ? data.release_date : data.first_air_date;
      const year = dateStr ? new Date(dateStr).getFullYear() : 0;
      const imdbId = data.imdb_id || undefined;

      const isAnimation =
        Array.isArray(data.genres) &&
        data.genres.some(
          (g: any) =>
            g.id === 16 || (g.name && g.name.toLowerCase() === "animation"),
        );

      return { title, year, imdbId, isAnimation };
    } catch (e: any) {
      console.error(
        `[FilmU Scraper] TMDB metadata fetch failed for ${tmdbId}:`,
        e.message,
      );
      throw e;
    }
  }

  /**
   * Main entry point to scrape all FilmU providers in parallel
   */
  public static async getStream(params: {
    tmdbId: string;
    imdbId?: string | undefined;
    kind: "movie" | "tv";
    season?: number | undefined;
    episode?: number | undefined;
    title?: string | undefined;
    year?: number | undefined;
    signal?: AbortSignal | undefined;
    proxyUrl?: string | undefined;
  }): Promise<MirrorStream[]> {
    const { tmdbId, kind, season, episode, signal, proxyUrl } = params;
    const mirrors: MirrorStream[] = [];

    try {
      // 1. Fetch TMDB Metadata to get clean title, year, IMDb ID, and genre classification
      const metadata = await this.getTMDBMetadata(tmdbId, kind, signal);
      const title = params.title || metadata.title;
      const year = params.year || metadata.year;
      const imdbId = params.imdbId || metadata.imdbId;
      const numericTmdbId = parseInt(tmdbId, 10);

      if (isNaN(numericTmdbId)) {
        throw new Error(`Invalid numeric TMDB ID: ${tmdbId}`);
      }

      console.log(
        `[FilmU Scraper] Scraping FilmU providers for: "${title}" (${year}), IMDb: ${imdbId || "N/A"}, Animation: ${metadata.isAnimation}`,
      );

      // Define our parallel execution promises
      const tasks: Promise<MirrorStream[]>[] = [];

      // ── Task A: Vortex (RiveStream) ──
      if (imdbId) {
        tasks.push(
          (async () => {
            try {
              const res = await getVortexStreams(
                "rivestream",
                imdbId,
                numericTmdbId,
                title,
                year,
                kind,
                season,
                episode,
                proxyUrl,
                signal,
              );
              const sources = res?.sources || [];
              const subtitles = Array.isArray(res?.subtitles)
                ? res.subtitles.map((s: any) => ({
                    url: s.url,
                    lang: s.lang || "en",
                    languageName: s.label || getLanguageName(s.lang || "en"),
                    source: "FilmU-Vortex",
                  }))
                : [];

              return sources.map((s: any) => ({
                url: s.workerProxyUrl || s.url,
                source: s.name ? `FilmU-Vortex (${s.name})` : "FilmU-Vortex",
                quality: s.quality || "1080p",
                type: s.type === "m3u8" ? "hls" : "mp4",
                headers: s.headers || {},
                subtitles,
              }));
            } catch (err: any) {
              console.warn(
                `[FilmU Scraper] Vortex extraction failed:`,
                err.message,
              );
              return [];
            }
          })(),
        );
      }

      // ── Task C: Aura VidRock ──
      tasks.push(
        (async () => {
          try {
            const res = await getAuraStreams(
              numericTmdbId,
              title,
              year,
              kind,
              season,
              episode,
              proxyUrl,
              signal,
            );
            const sources = res?.sources || [];
            const subtitles = Array.isArray(res?.subtitles)
              ? res.subtitles.map((s: any) => ({
                  url: s.url,
                  lang: s.lang || "en",
                  languageName: s.label || getLanguageName(s.lang || "en"),
                  source: "FilmU-Aura",
                }))
              : [];

            return sources.map((s: any) => {
              // Orion links direct play requires specific Origin/Referer headers
              const isOrion = s.name && s.name.toLowerCase().includes("orion");
              const headers = isOrion
                ? {
                    Origin: "https://vidrock.ru",
                    Referer: "https://vidrock.ru/",
                  }
                : undefined;

              return {
                url: s.url,
                source: `FilmU-Aura (${s.name || "VidRock"})`,
                quality: s.quality || "Auto",
                type: s.type === "m3u8" ? "hls" : "mp4",
                headers,
                subtitles,
              };
            });
          } catch (err: any) {
            console.warn(
              `[FilmU Scraper] Aura extraction failed:`,
              err.message,
            );
            return [];
          }
        })(),
      );

      // ── Task D: Kuro Anime (Only run for Animation content type) ──
      if (metadata.isAnimation) {
        tasks.push(
          (async () => {
            try {
              const token = await getKuroToken(proxyUrl, signal);
              const searchRes = await searchKuro(
                title,
                token,
                proxyUrl,
                signal,
              );
              const results = searchRes?.results || [];

              // Heuristic Title Search Match
              const match = results.find((r: any) =>
                isTitleMatch(r.title, title),
              );
              if (!match) {
                console.log(
                  `[FilmU Scraper] Kuro: No matching anime found for "${title}"`,
                );
                return [];
              }

              console.log(
                `[FilmU Scraper] Kuro matched: "${match.title}" (id: ${match.id})`,
              );
              const metaRes = await getKuroMeta(
                match.id,
                token,
                proxyUrl,
                signal,
              );
              const episodesMap = metaRes?.episodes || {};

              // We check both sub and dub options based on episode number
              const targetEpNum = episode || 1;
              const subEp = episodesMap.sub?.find(
                (e: any) => e.number === targetEpNum,
              );
              const dubEp = episodesMap.dub?.find(
                (e: any) => e.number === targetEpNum,
              );

              const kuroStreams: MirrorStream[] = [];

              const processEpData = async (epData: any, isDub: boolean) => {
                if (!epData?.dataStr) return;
                try {
                  const streamRes = await getKuroStreams(
                    epData.dataStr,
                    token,
                    proxyUrl,
                    signal,
                  );
                  const streams = streamRes?.streams || [];
                  const subtitles = Array.isArray(streamRes?.subtitles)
                    ? streamRes.subtitles.map((s: any) => ({
                        url: s.url,
                        lang: s.lang || "en",
                        languageName:
                          s.label || getLanguageName(s.lang || "en"),
                        source: `FilmU-Kuro-${isDub ? "Dub" : "Sub"}`,
                      }))
                    : [];

                  streams.forEach((s: any) => {
                    const suffix = isDub ? "Dub" : "Sub";

                    // Direct stream playback URL
                    if (s.url) {
                      kuroStreams.push({
                        url: s.url,
                        source: `FilmU-Kuro (${suffix} Direct)`,
                        quality: "Auto",
                        type: "hls",
                        headers: {
                          Referer: s.referer || "https://megaplay.buzz/",
                        },
                        subtitles,
                      });
                    }

                    // Backend proxy playback URL
                    if (s.proxyUrl) {
                      let proxyPath = s.proxyUrl;
                      if (proxyPath.startsWith("/")) {
                        proxyPath = "https://anime2.filmu.in" + proxyPath;
                      }
                      kuroStreams.push({
                        url: `${proxyPath}&apiKey=${token}`,
                        source: `FilmU-Kuro (${suffix} Proxied)`,
                        quality: "Auto",
                        type: "hls",
                        headers: {
                          Origin: "https://all-wish.me",
                          Referer: "https://all-wish.me/",
                        },
                        subtitles,
                      });
                    }
                  });
                } catch (err: any) {
                  console.warn(
                    `[FilmU Scraper] Kuro ep streams fetch failed:`,
                    err.message,
                  );
                }
              };

              if (subEp) await processEpData(subEp, false);
              if (dubEp) await processEpData(dubEp, true);

              return kuroStreams;
            } catch (err: any) {
              console.warn(
                `[FilmU Scraper] Kuro Anime extraction failed:`,
                err.message,
              );
              return [];
            }
          })(),
        );
      }

      // Execute all scrapers in parallel
      const results = await Promise.allSettled(tasks);

      // Merge all successful mirror results
      results.forEach((r) => {
        if (r.status === "fulfilled") {
          mirrors.push(...r.value);
        }
      });

      // Group and consolidate same-server different-quality HLS streams for FilmU
      const parseMirrorSource = (name: string) => {
        const match = name.match(
          /^(.*?)\s*-\s*(\d+(?:p)?|Auto|Original)\s*\)?$/i,
        );
        if (match) {
          let base = (match[1] || "").trim();
          if (name.includes("(") && !base.endsWith(")")) {
            base = base + ")";
          }
          return { base, quality: (match[2] || "").trim() };
        }
        return { base: name, quality: "Auto" };
      };

      const hlsGroups: Record<
        string,
        {
          base: string;
          streams: { url: string; quality: string; headers?: any }[];
          subtitles?: SubtitleStream[] | undefined;
          audio?: string | undefined;
          flag?: string | undefined;
        }
      > = {};

      const nonHlsMirrors: MirrorStream[] = [];

      mirrors.forEach((m) => {
        if (m.type !== "hls") {
          nonHlsMirrors.push(m);
          return;
        }

        const { base, quality } = parseMirrorSource(m.source || "");
        let cleanQual = quality;
        if (quality === "Auto" && m.quality) {
          cleanQual = m.quality;
        }

        if (!hlsGroups[base]) {
          hlsGroups[base] = {
            base,
            streams: [] as { url: string; quality: string; headers?: any }[],
            subtitles: m.subtitles,
            audio: (m as any).audio,
            flag: (m as any).flag,
          };
        }
        hlsGroups[base]!.streams.push({
          url: m.url,
          quality: cleanQual,
          headers: m.headers,
        });
      });

      const consolidatedMirrors: MirrorStream[] = [...nonHlsMirrors];

      for (const [base, group] of Object.entries(hlsGroups)) {
        if (group.streams.length === 1) {
          const s = group.streams[0];
          if (s) {
            consolidatedMirrors.push({
              url: s.url,
              source: base,
              quality: s.quality,
              type: "hls",
              headers: s.headers,
              subtitles: group.subtitles,
              audio: group.audio,
              flag: group.flag,
            } as any);
          }
        } else {
          // Sort streams by quality height descending
          group.streams.sort((a, b) => {
            const heightA = parseInt(a.quality.replace(/\D/g, ""), 10) || 0;
            const heightB = parseInt(b.quality.replace(/\D/g, ""), 10) || 0;
            return heightB - heightA;
          });

          const urls: string[] = [];
          const qualities: number[] = [];

          group.streams.forEach((s) => {
            let height = parseInt(s.quality.replace(/\D/g, ""), 10);
            if (isNaN(height) || !height) {
              height = 1080;
            }
            // Bake headers into the url parameters so they persist through proxy
            let finalUrl = s.url;
            if (s.headers) {
              try {
                const urlObj = new URL(finalUrl);
                urlObj.searchParams.set("headers", JSON.stringify(s.headers));
                finalUrl = urlObj.href;
              } catch {}
            }
            urls.push(encodeURIComponent(finalUrl));
            qualities.push(height);
          });

          consolidatedMirrors.push({
            url: `/api/videasy/master.m3u8?urls=${urls.join(",")}&qualities=${qualities.join(",")}`,
            source: base,
            quality: "Auto",
            type: "hls",
            subtitles: group.subtitles,
            audio: group.audio,
            flag: group.flag,
          } as any);
        }
      }

      mirrors.length = 0;
      mirrors.push(...consolidatedMirrors);
    } catch (e: any) {
      console.error(`[FilmU Scraper] Unified scraping failed:`, e.message);
    }

    return mirrors;
  }
}
