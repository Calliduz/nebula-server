import axios from "axios";
import crypto from "crypto";
import type { MirrorStream, SubtitleStream } from "./scraper.js";
import { getLanguageName } from "./subtitles.js";
import { parseAndFormatSize, getMediaTitleAndYear } from "./vidvault.js";

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
      console.warn(
        `[Vesper/NetNaija] Failed to get guest token: ${err.message}`,
      );
      return null;
    }
  }

  /**
   * Fetches multi-language captions/subtitles for a given subject stream
   */
  private static async getCaptions(
    format: string,
    id: string,
    subjectId: string | number,
    detailPath: string,
    token: string,
  ): Promise<SubtitleStream[]> {
    try {
      const clientToken = this.kp();
      const captionUrl = `https://h5-api.aoneroom.com/wefeed-h5api-bff/subject/caption?format=${encodeURIComponent(format)}&id=${encodeURIComponent(id)}&subjectId=${encodeURIComponent(subjectId)}&detailPath=${encodeURIComponent(detailPath)}`;

      const res = await axios.get(captionUrl, {
        headers: {
          accept: "application/json",
          "x-client-token": clientToken,
          authorization: `Bearer ${token}`,
          cookie: `token=${token}; netnaija_i18n_lang=en`,
          origin: BASE_URL,
          referer: `${BASE_URL}/`,
          "user-agent": UA,
        },
        timeout: 5000,
      });

      const captions = res.data?.data?.captions;
      if (!Array.isArray(captions) || captions.length === 0) {
        return [];
      }

      return captions
        .filter((c: any) => c && c.url)
        .map((c: any) => {
          const lang = (c.lan || "en").toLowerCase();
          const langName = c.lanName || getLanguageName(lang) || "English";
          return {
            url: c.url,
            lang,
            languageName: langName,
            source: "Vesper",
          };
        });
    } catch (err: any) {
      console.warn(
        `[Vesper/NetNaija] Failed to fetch captions: ${err.message}`,
      );
      return [];
    }
  }

  /**
   * Resolves TMDB details (title and release year) if details are not passed directly
   */
  private static async getTmdbDetails(
    tmdbId: number,
    type: "movie" | "tv",
  ): Promise<{ title?: string; year?: string }> {
    try {
      const tmdbApiKey =
        process.env.TMDB_API_KEY || "8410c58030558e2d6e4f340d8ab92858";
      const isV4 = tmdbApiKey.startsWith("eyJ");
      const url = `https://api.themoviedb.org/3/${type}/${tmdbId}${isV4 ? "" : `?api_key=${tmdbApiKey}`}`;
      const headers = isV4 ? { Authorization: `Bearer ${tmdbApiKey}` } : {};
      const res = await axios.get(url, { headers, timeout: 5000 });
      const title = res.data?.title || res.data?.name || undefined;
      const releaseDate =
        res.data?.release_date || res.data?.first_air_date || "";
      const year = releaseDate ? releaseDate.substring(0, 4) : undefined;
      return { title, year };
    } catch {
      return {};
    }
  }

  /**
   * Helper to detect audio language from NetNaija item corner tag or title brackets
   */
  private static getAudioFromItem(item: any): string {
    const corner = (item.corner || "").trim();
    const title = (item.title || item.name || "").trim();

    if (
      corner.toLowerCase() === "tagalog" ||
      title.toLowerCase().includes("[tagalog]")
    ) {
      return "Filipino";
    }
    if (corner) return corner;

    const dubMatch = title.match(/\[([A-Za-z\s]+)\]/);
    if (dubMatch && dubMatch[1]) {
      const d = dubMatch[1].trim();
      if (d.toLowerCase() === "tagalog") return "Filipino";
      return d;
    }
    return "English";
  }

  /**
   * Main entry point to scrape video stream mirrors & subtitles
   */
  public static async getStream(
    options: NetNaijaOptions,
  ): Promise<MirrorStream[]> {
    const { tmdbId, kind, season = 1, episode = 1 } = options;
    const numericTmdbId =
      typeof tmdbId === "string" ? parseInt(tmdbId, 10) : tmdbId;

    try {
      let searchTitle = options.title;
      let targetYear: string | undefined;

      if (numericTmdbId) {
        const tmdbDetails = await this.getTmdbDetails(numericTmdbId, kind);
        if (!searchTitle) searchTitle = tmdbDetails.title;
        targetYear = tmdbDetails.year;
      }

      if (!searchTitle) {
        console.warn(
          `[Vesper/NetNaija] Could not resolve title for TMDB ID: ${tmdbId}`,
        );
        return [];
      }

      console.log(
        `[Vesper/NetNaija] Searching for "${searchTitle}" (TMDB ${numericTmdbId}, ${kind}${targetYear ? `, ${targetYear}` : ""})...`,
      );

      const token = await this.getGuestToken();
      if (!token) {
        console.warn(
          `[Vesper/NetNaija] Unable to obtain guest authentication token`,
        );
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

      const normalize = (str: string) =>
        str
          .toLowerCase()
          .replace(/\[.*?\]|\(.*?\)/g, "")
          .replace(/[^a-z0-9\s]/g, "")
          .replace(/\s+/g, " ")
          .trim();

      const normSearch = normalize(searchTitle);
      const searchWords = normSearch.split(" ").filter((w) => w.length > 1);

      const candidates = searchItems
        .filter(
          (item: any) =>
            item &&
            item.subjectType === targetType &&
            item.subjectId &&
            item.detailPath,
        )
        .map((item: any) => {
          const itemTitle = item.title || item.name || "";
          const normItemClean = normalize(itemTitle);
          const audio = this.getAudioFromItem(item);
          const itemYear = item.releaseDate
            ? item.releaseDate.substring(0, 4)
            : "";

          let isMatch = false;
          let score = 0;

          if (normItemClean === normSearch) {
            isMatch = true;
            score = 100;
          } else if (
            normItemClean.includes(normSearch) ||
            normSearch.includes(normItemClean)
          ) {
            isMatch = true;
            score = 50;
          } else if (searchWords.length > 0) {
            const itemWordSet = new Set(normItemClean.split(" "));
            const matchedWords = searchWords.filter((w) => itemWordSet.has(w));
            const matchRatio = matchedWords.length / searchWords.length;
            if (matchRatio >= 0.75) {
              isMatch = true;
              score = 30;
            }
          }

          if (isMatch) {
            if (audio === "English") score += 10;
            if (targetYear && itemYear === targetYear) score += 40;
          }

          return { item, audio, score, isMatch };
        })
        .filter((c: any) => c.isMatch)
        .sort((a: any, b: any) => b.score - a.score);

      if (candidates.length === 0) {
        console.log(
          `[Vesper/NetNaija] Match failed for TMDB ${numericTmdbId} ("${searchTitle}")`,
        );
        return [];
      }

      // Select primary candidate (top score, English preferred)
      const primaryCandidate = candidates[0];
      if (!primaryCandidate) return [];
      const itemsToFetch = [primaryCandidate];

      // Include extra dub candidates matching the title (e.g. Tagalog/Filipino)
      const extraDubs = candidates.filter(
        (c: any) =>
          c &&
          c.audio !== primaryCandidate.audio &&
          c.score >= primaryCandidate.score - 20,
      );
      itemsToFetch.push(...extraDubs);

      console.log(
        `[Vesper/NetNaija] Selected primary item: "${primaryCandidate.item.title}" (${primaryCandidate.audio}), plus ${extraDubs.length} dub variants`,
      );

      const mirrors: MirrorStream[] = [];
      const se = kind === "tv" ? season : 0;
      const ep = kind === "tv" ? episode : 0;

      for (const candidate of itemsToFetch) {
        const item = candidate.item;
        const itemAudio = candidate.audio;

        const playUrl = `${BASE_URL}/wefeed-h5api-bff/subject/play?subjectId=${item.subjectId}&se=${se}&ep=${ep}&detailPath=${encodeURIComponent(item.detailPath)}`;
        const downloadUrl = `${BASE_URL}/wefeed-h5api-bff/subject/download?subjectId=${item.subjectId}&se=${se}&ep=${ep}&detailPath=${encodeURIComponent(item.detailPath)}`;
        const reqHeaders = {
          ...authHeaders,
          cookie: `token=${token}; netnaija_token="${token}"; netnaija_i18n_lang=en`,
          referer: `${BASE_URL}/videoPlayPage/${item.detailPath}?type=/${kind}/detail`,
        };

        try {
          const [playResResult, downloadResResult] = await Promise.allSettled([
            axios.get(playUrl, { headers: reqHeaders, timeout: 7000 }),
            axios.get(downloadUrl, { headers: reqHeaders, timeout: 7000 }),
          ]);

          const playRes =
            playResResult.status === "fulfilled" ? playResResult.value : null;
          const downloadRes =
            downloadResResult.status === "fulfilled"
              ? downloadResResult.value
              : null;

          let subtitles: SubtitleStream[] = [];

          // 1. Try captions directly from download API response if present
          const captionsData = downloadRes?.data?.data?.captions;
          if (Array.isArray(captionsData) && captionsData.length > 0) {
            subtitles = captionsData
              .filter((c: any) => c && c.url)
              .map((c: any) => {
                const lang = (c.lan || "en").toLowerCase();
                const langName =
                  c.lanName || getLanguageName(lang) || "English";
                return {
                  url: c.url,
                  lang,
                  languageName: langName,
                  source: "Vesper",
                };
              });
          }

          // 2. Fallback to getCaptions if captions empty
          const streamsData = playRes?.data?.data?.streams;
          if (
            subtitles.length === 0 &&
            Array.isArray(streamsData) &&
            streamsData[0]?.id
          ) {
            subtitles = await this.getCaptions(
              streamsData[0].format || "MP4",
              streamsData[0].id,
              item.subjectId,
              item.detailPath,
              token,
            );
          }

          // 3. Process play streams
          if (Array.isArray(streamsData)) {
            for (const s of streamsData) {
              if (!s.url) continue;
              const resLabel = s.resolutions ? `${s.resolutions}p` : "HD";

              mirrors.push({
                url: s.url,
                quality: resLabel,
                type: "mp4",
                source: `Vesper (${resLabel})`,
                audio: itemAudio,
                headers: {
                  Referer: `${BASE_URL}/`,
                  Origin: BASE_URL,
                  "User-Agent": UA,
                },
                subtitles,
              });
            }
          }

          // 4. Process direct downloads from download API
          const downloadsData = downloadRes?.data?.data?.downloads;
          if (Array.isArray(downloadsData)) {
            for (const d of downloadsData) {
              if (!d.url || d.vipLocked) continue;
              const resLabel = d.resolution ? `${d.resolution}p` : "HD";

              // Avoid duplicate mirror if exact URL is already in mirrors
              if (mirrors.some((m) => m.url === d.url)) continue;

              mirrors.push({
                url: d.url,
                quality: resLabel,
                type: "mp4",
                source: `Vesper Direct (${resLabel})`,
                audio: itemAudio,
                headers: {
                  Referer: `${BASE_URL}/`,
                  Origin: BASE_URL,
                  "User-Agent": UA,
                },
                subtitles,
              });
            }
          }
        } catch (err: any) {
          console.warn(
            `[Vesper/NetNaija] Failed fetching streams for ${item.title}: ${err.message}`,
          );
        }
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

  /**
   * Fetches direct download sources formatted for the download endpoints
   */
  public static async getDirectDownloads(
    options: NetNaijaOptions,
  ): Promise<any[]> {
    const { tmdbId, kind, season = 1, episode = 1 } = options;
    const numericTmdbId =
      typeof tmdbId === "string" ? parseInt(tmdbId, 10) : tmdbId;

    try {
      let searchTitle = options.title;
      let targetYear: string | undefined;

      if (numericTmdbId) {
        const mediaInfo = await getMediaTitleAndYear(
          String(numericTmdbId),
          kind,
        );
        if (!searchTitle) searchTitle = mediaInfo.title;
        targetYear = mediaInfo.year;
      }

      if (!searchTitle) return [];

      const token = await this.getGuestToken();
      if (!token) return [];

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

      const searchRes = await axios.post(
        `${BASE_URL}/wefeed-h5api-bff/subject/search`,
        { keyword: searchTitle, page: 1, perPage: 10 },
        { headers: authHeaders, timeout: 7000 },
      );

      const searchItems = searchRes.data?.data?.items;
      if (!Array.isArray(searchItems) || searchItems.length === 0) return [];

      const targetType = kind === "movie" ? 1 : 2;
      const normalize = (str: string) =>
        str
          .toLowerCase()
          .replace(/\[.*?\]|\(.*?\)/g, "")
          .replace(/[^a-z0-9\s]/g, "")
          .replace(/\s+/g, " ")
          .trim();

      const normSearch = normalize(searchTitle);
      const searchWords = normSearch.split(" ").filter((w) => w.length > 1);

      const candidates = searchItems
        .filter(
          (item: any) =>
            item &&
            item.subjectType === targetType &&
            item.subjectId &&
            item.detailPath,
        )
        .map((item: any) => {
          const itemTitle = item.title || item.name || "";
          const normItemClean = normalize(itemTitle);
          const audio = this.getAudioFromItem(item);
          const itemYear = item.releaseDate
            ? item.releaseDate.substring(0, 4)
            : "";

          let isMatch = false;
          let score = 0;

          if (normItemClean === normSearch) {
            isMatch = true;
            score = 100;
          } else if (
            normItemClean.includes(normSearch) ||
            normSearch.includes(normItemClean)
          ) {
            isMatch = true;
            score = 50;
          } else if (searchWords.length > 0) {
            const itemWordSet = new Set(normItemClean.split(" "));
            const matchedWords = searchWords.filter((w) => itemWordSet.has(w));
            const matchRatio = matchedWords.length / searchWords.length;
            if (matchRatio >= 0.75) {
              isMatch = true;
              score = 30;
            }
          }

          if (isMatch) {
            if (audio === "English") score += 10;
            if (targetYear && itemYear === targetYear) score += 40;
          }

          return { item, audio, score, isMatch };
        })
        .filter((c: any) => c.isMatch)
        .sort((a: any, b: any) => b.score - a.score);

      if (candidates.length === 0 || !candidates[0]) return [];
      const candidate = candidates[0].item;

      const se = kind === "tv" ? season : 0;
      const ep = kind === "tv" ? episode : 0;

      const downloadUrl = `${BASE_URL}/wefeed-h5api-bff/subject/download?subjectId=${candidate.subjectId}&se=${se}&ep=${ep}&detailPath=${encodeURIComponent(candidate.detailPath)}`;
      const playUrl = `${BASE_URL}/wefeed-h5api-bff/subject/play?subjectId=${candidate.subjectId}&se=${se}&ep=${ep}&detailPath=${encodeURIComponent(candidate.detailPath)}`;

      const downloadHeaders = {
        ...authHeaders,
        cookie: `token=${token}; netnaija_token="${token}"; netnaija_i18n_lang=en`,
        referer: `${BASE_URL}/videoPlayPage/${candidate.detailPath}?type=/${kind}/detail`,
      };

      const [downloadResResult, playResResult] = await Promise.allSettled([
        axios.get(downloadUrl, { headers: downloadHeaders, timeout: 7000 }),
        axios.get(playUrl, { headers: downloadHeaders, timeout: 7000 }),
      ]);

      const downloadRes =
        downloadResResult.status === "fulfilled"
          ? downloadResResult.value
          : null;
      const playRes =
        playResResult.status === "fulfilled" ? playResResult.value : null;

      const downloadsData = downloadRes?.data?.data?.downloads;
      const streamsData = playRes?.data?.data?.streams;
      const captionsData = downloadRes?.data?.data?.captions;

      const titleName =
        searchTitle && searchTitle !== "Media"
          ? searchTitle
          : candidate.title || "Media";
      const yearSuffix = targetYear ? ` (${targetYear})` : "";

      const mp4FileName =
        kind === "movie"
          ? `${titleName}${yearSuffix}.mp4`
          : `${titleName} S${season.toString().padStart(2, "0")}E${episode.toString().padStart(2, "0")}.mp4`;

      const subtitles = Array.isArray(captionsData)
        ? captionsData
            .filter((c: any) => c && c.url)
            .map((c: any) => {
              const subExt = c.url.split("?")[0].split(".").pop() || "srt";
              const subFileName =
                kind === "movie"
                  ? `${titleName} - ${c.lanName || c.lan}.${subExt}`
                  : `${titleName} S${season.toString().padStart(2, "0")}E${episode.toString().padStart(2, "0")} - ${c.lanName || c.lan}.${subExt}`;
              return {
                lan: String(c.lan ?? "und"),
                lanName: String(c.lanName ?? "Unknown"),
                url: `/api/download/stream-file?url=${encodeURIComponent(c.url)}&name=${encodeURIComponent(subFileName)}`,
              };
            })
        : [];

      const results: any[] = [];
      const addedQualities = new Set<string>();

      // 1. Add direct download items
      if (Array.isArray(downloadsData)) {
        for (const d of downloadsData) {
          if (!d.url || d.vipLocked) continue;
          const resLabel = d.resolution ? `${d.resolution}p` : "HD";
          const sizeStr = parseAndFormatSize(d.size);
          addedQualities.add(resLabel);

          const itemMp4FileName =
            kind === "movie"
              ? `${titleName}${yearSuffix} [${resLabel}].mp4`
              : `${titleName} S${season.toString().padStart(2, "0")}E${episode.toString().padStart(2, "0")} [${resLabel}].mp4`;

          results.push({
            title: titleName,
            quality: resLabel,
            size: sizeStr,
            direct_url: `/api/download/stream-file?url=${encodeURIComponent(d.url)}&name=${encodeURIComponent(itemMp4FileName)}`,
            source: "Vortex",
            format: "mp4",
            subtitles,
            type: kind,
            ...(kind === "tv" ? { season, episode } : {}),
          });
        }
      }

      // 2. Add unlocked play streams (e.g. 1080p) if missing from download items
      if (Array.isArray(streamsData)) {
        for (const s of streamsData) {
          if (!s.url) continue;
          const resLabel = s.resolutions ? `${s.resolutions}p` : "HD";
          if (addedQualities.has(resLabel)) continue;
          addedQualities.add(resLabel);
          const sizeStr = parseAndFormatSize(s.size);

          const itemMp4FileName =
            kind === "movie"
              ? `${titleName}${yearSuffix} [${resLabel}].mp4`
              : `${titleName} S${season.toString().padStart(2, "0")}E${episode.toString().padStart(2, "0")} [${resLabel}].mp4`;

          results.push({
            title: titleName,
            quality: resLabel,
            size: sizeStr,
            direct_url: `/api/download/stream-file?url=${encodeURIComponent(s.url)}&name=${encodeURIComponent(itemMp4FileName)}`,
            source: "Vortex",
            format: "mp4",
            subtitles,
            type: kind,
            ...(kind === "tv" ? { season, episode } : {}),
          });
        }
      }

      return results;
    } catch (err: any) {
      console.warn(`[Vortex] Direct download fetch error: ${err.message}`);
      return [];
    }
  }
}
