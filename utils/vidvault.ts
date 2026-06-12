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

const TMDB_API_KEY = process.env.TMDB_API_KEY || "";

export async function getMediaTitleAndYear(
  tmdbId: string,
  type: "movie" | "tv",
): Promise<{ title: string; year: string }> {
  const cacheKey = `media-title-year-${tmdbId}-${type}`;
  try {
    const cached = await TmdbCache.findOne({
      key: cacheKey,
      expiresAt: { $gt: new Date() },
    });
    if (cached) return cached.data;
  } catch (e) {
    console.warn(`[TMDB] Cache read failed for title-year lookup:`, e);
  }

  try {
    const res = await axios.get(
      `https://api.themoviedb.org/3/${type}/${tmdbId}`,
      {
        headers: { Authorization: `Bearer ${TMDB_API_KEY}` },
        timeout: 5000,
      },
    );
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
  source: "VidVault";
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
): Promise<VidVaultDownload[]> {
  const token = await fetchVidVaultToken();
  if (!token) return [];

  const mediaInfo = await getMediaTitleAndYear(tmdbId, kind);

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
      signal: AbortSignal.timeout(12000),
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
      const subFileName =
        kind === "movie"
          ? `${mediaInfo.title} (${mediaInfo.year}) - ${c.lanName}.${subExt}`
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
  const mp4FileName =
    kind === "movie"
      ? `${mediaInfo.title} (${mediaInfo.year}).mp4`
      : `${mediaInfo.title} S${(season ?? 1).toString().padStart(2, "0")}E${(episode ?? 1).toString().padStart(2, "0")}.mp4`;

  for (const d of downloads) {
    if (!d.url || !d.url.startsWith("http")) continue;
    const rawQuality = String(
      d.quality ?? d.definition ?? d.label ?? "HD",
    ).trim();
    const sizeBytes = parseSizeToBytes(d.filesize ?? d.size);
    const sizeStr = parseAndFormatSize(d.filesize ?? d.size);

    let quality = rawQuality;
    if (/^hd$/i.test(rawQuality) && sizeBytes > 0) {
      if (sizeBytes < 200 * 1024 * 1024) quality = "360p";
      else if (sizeBytes < 400 * 1024 * 1024) quality = "480p";
      else if (sizeBytes < 750 * 1024 * 1024) quality = "720p";
      else if (sizeBytes < 2000 * 1024 * 1024) quality = "1080p";
      else quality = "4K";
    }

    const direct_url = `/api/download/stream-file?url=${encodeURIComponent(d.url)}&name=${encodeURIComponent(mp4FileName)}`;

    const entry: VidVaultDownload = {
      title: "",
      quality,
      size: String(sizeStr),
      direct_url,
      source: "VidVault",
      format: "mp4",
      subtitles: captions,
      type: kind,
    };
    if (kind === "tv" && season !== undefined) entry.season = season;
    if (kind === "tv" && episode !== undefined) entry.episode = episode;
    results.push(entry);
  }

  // ── Extract MKV downloads (mkvData, mkvV2Data, mkvV3Data) ─────────────────
  const mkvFileName =
    kind === "movie"
      ? `${mediaInfo.title} (${mediaInfo.year}).mkv`
      : `${mediaInfo.title} S${(season ?? 1).toString().padStart(2, "0")}E${(episode ?? 1).toString().padStart(2, "0")}.mkv`;

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

        let mkvQuality = String(file.quality ?? mkvObj.quality ?? "HD")
          .replace(/\s*\(mkv\)/gi, "")
          .trim();
        if (/^hd$/i.test(mkvQuality) && sizeBytes > 0) {
          if (sizeBytes < 200 * 1024 * 1024) mkvQuality = "360p";
          else if (sizeBytes < 400 * 1024 * 1024) mkvQuality = "480p";
          else if (sizeBytes < 750 * 1024 * 1024) mkvQuality = "720p";
          else if (sizeBytes < 2000 * 1024 * 1024) mkvQuality = "1080p";
          else mkvQuality = "4K";
        }

        const direct_url = `/api/download/stream-file?url=${encodeURIComponent(file.url)}&name=${encodeURIComponent(mkvFileName)}`;

        const mkvEntry: VidVaultDownload = {
          title: "",
          quality: String(mkvQuality),
          size: String(sizeStr),
          direct_url,
          source: "VidVault",
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
      const rawMkvQuality = String(mkvObj.quality ?? "HD")
        .replace(/\s*\(mkv\)/gi, "")
        .trim();
      const sizeBytes = parseSizeToBytes(mkvObj.size);
      const mkvSizeStr = parseAndFormatSize(mkvObj.size);

      let mkvQuality = rawMkvQuality;
      if (/^hd$/i.test(rawMkvQuality) && sizeBytes > 0) {
        if (sizeBytes < 200 * 1024 * 1024) mkvQuality = "360p";
        else if (sizeBytes < 400 * 1024 * 1024) mkvQuality = "480p";
        else if (sizeBytes < 750 * 1024 * 1024) mkvQuality = "720p";
        else if (sizeBytes < 2000 * 1024 * 1024) mkvQuality = "1080p";
        else mkvQuality = "4K";
      }

      const direct_url = `/api/download/stream-file?url=${encodeURIComponent(mkvObj.url)}&name=${encodeURIComponent(mkvFileName)}`;

      const mkvEntry: VidVaultDownload = {
        title: "",
        quality: String(mkvQuality),
        size: String(mkvSizeStr),
        direct_url,
        source: "VidVault",
        format: "mkv",
        subtitles: [],
        type: kind,
      };
      if (kind === "tv" && season !== undefined) mkvEntry.season = season;
      if (kind === "tv" && episode !== undefined) mkvEntry.episode = episode;
      results.push(mkvEntry);
    }
  }

  console.log(
    `[VIDVAULT] Found ${results.length} download(s) for ${kind} tmdbId=${tmdbId}${kind === "tv" ? ` S${season}E${episode}` : ""}`,
  );
  return results;
}
