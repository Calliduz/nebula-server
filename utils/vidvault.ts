/**
 * utils/vidvault.ts
 * VidVault direct-download helpers extracted from server.ts.
 * VidVault returns signed CDN URLs (~6h TTL) so results are NOT cached long-term.
 */

import axios from "axios";
import { TmdbCache } from "../models/Cache.js";

// ── Shared byte-size utilities ────────────────────────────────────────────────

export function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return "0 Bytes";
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ["Bytes", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + " " + sizes[i];
}

export function parseSizeToBytes(rawSize: any): number {
  if (!rawSize) return 0;
  if (typeof rawSize === "number") return rawSize;
  const str = String(rawSize).toLowerCase().trim();
  const num = parseFloat(str);
  if (isNaN(num)) return 0;
  if (str.includes("gb")) return num * 1024 * 1024 * 1024;
  if (str.includes("mb")) return num * 1024 * 1024;
  if (str.includes("kb")) return num * 1024;
  return num;
}

export function parseAndFormatSize(rawSize: any): string {
  if (rawSize === undefined || rawSize === null) return "Unknown";
  if (typeof rawSize === "number") return formatBytes(rawSize);
  const str = String(rawSize).trim();
  if (/[a-zA-Z]/.test(str)) return str; // Already has unit suffix
  const bytes = parseInt(str, 10);
  return bytes > 0 ? formatBytes(bytes) : "Unknown";
}

// ── TMDB metadata helper ──────────────────────────────────────────────────────

export async function getMediaTitleAndYear(
  tmdbId: string,
  type: "movie" | "tv",
): Promise<{ title: string; year: string }> {
  const apiKey = process.env.TMDB_API_KEY || "8410c58030558e2d6e4f340d8ab92858";
  const cacheKey = `media-title-year-${tmdbId}-${type}`;
  try {
    const cached = await TmdbCache.findOne({
      key: cacheKey,
      expiresAt: { $gt: new Date() },
    });
    if (
      cached &&
      cached.data &&
      cached.data.title &&
      cached.data.title !== "Media"
    ) {
      return cached.data;
    }
  } catch (e) {
    console.warn(`[TMDB] Cache read failed for title-year lookup:`, e);
  }

  try {
    const isV4 = apiKey.startsWith("eyJ") || apiKey.length > 40;
    const tmdbUrl = `https://api.themoviedb.org/3/${type}/${tmdbId}${isV4 ? "" : `?api_key=${apiKey}`}`;
    const headers = isV4 ? { Authorization: `Bearer ${apiKey}` } : {};

    const res = await axios.get(tmdbUrl, {
      headers,
      timeout: 8000,
    });
    const data = res.data;
    const title =
      type === "movie"
        ? data.title || data.original_title
        : data.name || data.original_name;
    const dateStr = type === "movie" ? data.release_date : data.first_air_date;
    const year = dateStr ? dateStr.substring(0, 4) : "";
    const result = { title: title || "Media", year: year || "" };

    const ttl = 1000 * 60 * 60 * 24 * 30; // 30 days
    await TmdbCache.findOneAndUpdate(
      { key: cacheKey },
      { data: result, expiresAt: new Date(Date.now() + ttl) },
      { upsert: true },
    ).catch(() => null);

    return result;
  } catch (err: any) {
    console.warn(
      `[TMDB] Failed to fetch title and year for ${type} ${tmdbId}: ${err.message}`,
    );
    return { title: "Media", year: "" };
  }
}

// ── VidVault constants & types ────────────────────────────────────────────────

export const VIDVAULT_BASE = "https://vidvault.ru";
export const VIDVAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

export interface VidVaultCaption {
  lan: string; // ISO language code, e.g. "en"
  lanName: string; // Human-readable name, e.g. "English"
  url: string; // Direct .srt / .vtt URL
}

export interface VidVaultDownload {
  title: string;
  quality: string;
  size: string;
  direct_url: string;
  source: string;
  format: "mp4" | "mkv"; // mp4 = no embedded subs; mkv = embedded subs
  subtitles: VidVaultCaption[]; // populated for mp4 entries only
  type: "movie" | "tv";
  season?: number;
  episode?: number;
}

// ── Token fetcher ─────────────────────────────────────────────────────────────

export async function fetchVidVaultToken(): Promise<string | null> {
  try {
    const res = await fetch(`${VIDVAULT_BASE}/api/get-token`, {
      method: "GET",
      headers: {
        accept: "*/*",
        "user-agent": VIDVAULT_UA,
        referer: `${VIDVAULT_BASE}/`,
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.warn(`[VIDVAULT] Token fetch failed: HTTP ${res.status}`);
      return null;
    }
    const json = (await res.json()) as {
      t?: string;
      token?: string;
      e?: number;
    };
    const token = json.t ?? json.token ?? null;
    if (!token) {
      console.warn(
        `[VIDVAULT] Token parse failed — unexpected shape:`,
        Object.keys(json),
      );
      return null;
    }
    return token;
  } catch (err: any) {
    console.warn(`[VIDVAULT] Token request error: ${err.message}`);
    return null;
  }
}

// ── Main download fetcher ─────────────────────────────────────────────────────

export async function fetchVidVaultDownloads(
  kind: "movie" | "tv",
  tmdbId: string,
  season?: number,
  episode?: number,
  passedTitle?: string,
): Promise<VidVaultDownload[]> {
  const token = await fetchVidVaultToken();
  if (!token) return [];

  const mediaInfo = await getMediaTitleAndYear(tmdbId, kind);
  if ((!mediaInfo.title || mediaInfo.title === "Media") && passedTitle) {
    mediaInfo.title = passedTitle;
  }

  const requestBody: Record<string, any> =
    kind === "movie"
      ? { type: "movie", tmdbId }
      : { type: "tv", tmdbId, season: season ?? 1, episode: episode ?? 1 };

  let proxyRes: Response;
  try {
    proxyRes = await fetch(`${VIDVAULT_BASE}/api/download-proxy`, {
      method: "POST",
      headers: {
        accept: "*/*",
        "content-type": "application/json",
        "user-agent": VIDVAULT_UA,
        referer: `${VIDVAULT_BASE}/`,
        "x-request-token": token,
        "sec-fetch-site": "same-origin",
        "sec-fetch-mode": "cors",
        "sec-fetch-dest": "empty",
      },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(18000),
    });
  } catch (err: any) {
    console.warn(`[VIDVAULT] Proxy request error: ${err.message}`);
    return [];
  }

  if (!proxyRes.ok) {
    console.warn(`[VIDVAULT] Proxy returned HTTP ${proxyRes.status}`);
    return [];
  }

  let data: any;
  try {
    data = await proxyRes.json();
  } catch {
    console.warn(`[VIDVAULT] Proxy response is not JSON`);
    return [];
  }

  const results: VidVaultDownload[] = [];

  // ── Extract Subtitles ──────────────────────────────────────────────────────
  const rawCaptions: any[] = data?.mp4Data?.downloadInfo?.data?.captions ?? [];
  const captions: VidVaultCaption[] = rawCaptions
    .filter((c: any) => c?.url?.startsWith("http"))
    .map((c: any) => {
      const subExt = c.url.split("?")[0].split(".").pop() || "srt";
      const yearStr = mediaInfo.year ? ` (${mediaInfo.year})` : "";
      const subFileName =
        kind === "movie"
          ? `${mediaInfo.title}${yearStr} - ${c.lanName}.${subExt}`
          : `${mediaInfo.title} S${(season ?? 1).toString().padStart(2, "0")}E${(episode ?? 1).toString().padStart(2, "0")} - ${c.lanName}.${subExt}`;

      const subUrl = `/api/download/stream-file?url=${encodeURIComponent(c.url)}&name=${encodeURIComponent(subFileName)}`;

      return {
        lan: String(c.lan ?? "und"),
        lanName: String(c.lanName ?? c.lan ?? "Unknown"),
        url: subUrl,
      };
    });

  // ── Extract MP4 downloads ──────────────────────────────────────────────────
  const downloads: any[] = data?.mp4Data?.downloadInfo?.data?.downloads ?? [];
  const yearStr = mediaInfo.year ? ` (${mediaInfo.year})` : "";
  const mp4FileName =
    kind === "movie"
      ? `${mediaInfo.title}${yearStr}.mp4`
      : `${mediaInfo.title} S${(season ?? 1).toString().padStart(2, "0")}E${(episode ?? 1).toString().padStart(2, "0")}.mp4`;

  for (const d of downloads) {
    if (!d.url || !d.url.startsWith("http")) continue;
    const rawQuality = d.resolution
      ? `${d.resolution}p`
      : String(d.quality ?? d.definition ?? d.label ?? "HD").trim();
    const sizeBytes = parseSizeToBytes(d.filesize ?? d.size);
    const sizeStr = parseAndFormatSize(d.filesize ?? d.size);

    let quality = rawQuality;
    if (/^hd$/i.test(rawQuality) && sizeBytes > 0) {
      if (sizeBytes < 350 * 1024 * 1024) quality = "360p";
      else if (sizeBytes < 700 * 1024 * 1024) quality = "480p";
      else if (sizeBytes < 1500 * 1024 * 1024) quality = "720p";
      else quality = "1080p";
    }

    const itemMp4FileName =
      kind === "movie"
        ? `${mediaInfo.title}${yearStr} [${quality}].mp4`
        : `${mediaInfo.title} S${(season ?? 1).toString().padStart(2, "0")}E${(episode ?? 1).toString().padStart(2, "0")} [${quality}].mp4`;

    const direct_url = `/api/download/stream-file?url=${encodeURIComponent(d.url)}&name=${encodeURIComponent(itemMp4FileName)}`;

    const entry: VidVaultDownload = {
      title: "",
      quality,
      size: String(sizeStr),
      direct_url,
      source: "Titan",
      format: "mp4",
      subtitles: captions,
      type: kind,
    };
    if (kind === "tv" && season !== undefined) entry.season = season;
    if (kind === "tv" && episode !== undefined) entry.episode = episode;
    results.push(entry);
  }

  // ── Extract MKV downloads (mkvData, mkvV2Data, mkvV3Data) ─────────────────
  const mkvKeys = ["mkvData", "mkvV2Data", "mkvV3Data"] as const;
  for (const key of mkvKeys) {
    const mkvObj = data?.[key];
    if (!mkvObj) continue;

    if (Array.isArray(mkvObj.files)) {
      for (const file of mkvObj.files) {
        if (
          !file ||
          typeof file.url !== "string" ||
          !file.url.startsWith("http")
        )
          continue;
        const sizeBytes = parseSizeToBytes(file.size);
        const sizeStr = parseAndFormatSize(file.size);

        let mkvQuality = file.resolution
          ? `${file.resolution}p`
          : String(file.quality ?? mkvObj.quality ?? "HD")
              .replace(/\s*\(mkv\)/gi, "")
              .trim();
        if (/^hd$/i.test(mkvQuality) && sizeBytes > 0) {
          if (sizeBytes < 350 * 1024 * 1024) mkvQuality = "360p";
          else if (sizeBytes < 700 * 1024 * 1024) mkvQuality = "480p";
          else if (sizeBytes < 1500 * 1024 * 1024) mkvQuality = "720p";
          else mkvQuality = "1080p";
        }

        const itemMkvFileName =
          kind === "movie"
            ? `${mediaInfo.title}${yearStr} [${mkvQuality}].mkv`
            : `${mediaInfo.title} S${(season ?? 1).toString().padStart(2, "0")}E${(episode ?? 1).toString().padStart(2, "0")} [${mkvQuality}].mkv`;

        const direct_url = `/api/download/stream-file?url=${encodeURIComponent(file.url)}&name=${encodeURIComponent(itemMkvFileName)}`;

        const mkvEntry: VidVaultDownload = {
          title: "",
          quality: String(mkvQuality),
          size: String(sizeStr),
          direct_url,
          source: "Titan",
          format: "mkv",
          subtitles: [],
          type: kind,
        };
        if (kind === "tv" && season !== undefined) mkvEntry.season = season;
        if (kind === "tv" && episode !== undefined) mkvEntry.episode = episode;
        results.push(mkvEntry);
      }
    } else if (
      typeof mkvObj.url === "string" &&
      mkvObj.url.startsWith("http")
    ) {
      const rawMkvQuality = mkvObj.resolution
        ? `${mkvObj.resolution}p`
        : String(mkvObj.quality ?? "HD")
            .replace(/\s*\(mkv\)/gi, "")
            .trim();
      const sizeBytes = parseSizeToBytes(mkvObj.size);
      const mkvSizeStr = parseAndFormatSize(mkvObj.size);

      let mkvQuality = rawMkvQuality;
      if (/^hd$/i.test(rawMkvQuality) && sizeBytes > 0) {
        if (sizeBytes < 350 * 1024 * 1024) mkvQuality = "360p";
        else if (sizeBytes < 700 * 1024 * 1024) mkvQuality = "480p";
        else if (sizeBytes < 1500 * 1024 * 1024) mkvQuality = "720p";
        else mkvQuality = "1080p";
      }

      const itemMkvFileName =
        kind === "movie"
          ? `${mediaInfo.title}${yearStr} [${mkvQuality}].mkv`
          : `${mediaInfo.title} S${(season ?? 1).toString().padStart(2, "0")}E${(episode ?? 1).toString().padStart(2, "0")} [${mkvQuality}].mkv`;

      const direct_url = `/api/download/stream-file?url=${encodeURIComponent(mkvObj.url)}&name=${encodeURIComponent(itemMkvFileName)}`;

      const mkvEntry: VidVaultDownload = {
        title: "",
        quality: String(mkvQuality),
        size: String(mkvSizeStr),
        direct_url,
        source: "Titan",
        format: "mkv",
        subtitles: [],
        type: kind,
      };
      if (kind === "tv" && season !== undefined) mkvEntry.season = season;
      if (kind === "tv" && episode !== undefined) mkvEntry.episode = episode;
      results.push(mkvEntry);
    }
  }

  const epLabel =
    kind === "tv" && season !== undefined && episode !== undefined
      ? ` S${season}E${episode}`
      : "";
  console.log(
    `[VIDVAULT] Found ${results.length} download(s) for ${kind} tmdbId=${tmdbId}${epLabel}`,
  );
  return results;
}
