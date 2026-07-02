/**
 * routes/subtitles.ts
 * Subtitle-related Express routes extracted from server.ts.
 *
 * Endpoints:
 *   GET  /api/subtitles          — Aggregated subtitle fetch (all sources)
 *   GET  /api/proxy/subtitle     — Subtitle proxy (CORS bypass, KissKH decrypt, SRT→VTT)
 */

import { Router, type Request, type Response } from "express";
import axios from "axios";
import jschardet from "jschardet";
import iconv from "iconv-lite";
import { StreamCache, SubtitleCache } from "../models/Cache.js";
import { getSubtitles } from "../utils/subtitles.js";
import { fetchWithCycleTLS, fetchWithGotScraping } from "../utils/bypass.js";
import { fetchVidVaultDownloads } from "../utils/vidvault.js";

// fetchVidLinkRaw is re-exported from server.ts — we call it via a lazy import
// to avoid circular deps. Instead we accept it as a parameter on the factory.
type FetchVidLinkRawFn = (
  url: string,
  headers?: Record<string, string>,
) => Promise<{
  statusCode: number;
  headers: any;
  body: Buffer;
  finalUrl: string;
}>;

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

// ── SSRF allowlist ────────────────────────────────────────────────────────────
// Expanded to include Videasy CDN domains (subtitle files served from their CDN)
export const SUBTITLE_ALLOWLIST = [
  "vidlink.pro",
  "megafiles.store",
  "storm.vodvidl.site",
  "cacdn.hakunaymatata.com",
  "hakunaymatata.com",
  "opensubtitles.org",
  "opensubtitles.com",
  "sub.webseries.vip",
  "s.megafiles.store",
  "strem.io",
  "stremio.com",
  "vdrk.site",
  "cache.vdrk.site",
  "vidrock.ru",
  "storrrrrrm.site",
  "workers.dev",
  "boopigcdn.com",
  "vidapi.cloud",
  // Videasy subtitle CDN domains
  "joe.goldweather.net",
  "api.videasy.net",
  "cdn.videasy.net",
  "sub.videasy.net",
  // FilmU subtitle domains
  "filmu.in",
  "anime2.filmu.in",
  "hianime.filmu.in",
  "rive.filmu.in",
  "box.filmu.in",
  "embed.filmu.in",
  // Vidnest & Vaplayer subtitle CDN domains
  "vidnest.fun",
  "new.vidnest.fun",
  "vaplayer.ru",
  "streamdata.vaplayer.ru",
];

// ── Source priority sort helpers ──────────────────────────────────────────────

function sourcePriority(source: string): number {
  if (source === "VidVault") return 1;
  if (source === "VidRock") return 2;
  if (source === "Videasy") return 3;
  if (source === "Vidnest") return 4;
  if (source === "Vaplayer") return 5;
  if (source === "VidLink") return 6;
  if (source && source.startsWith("FilmU")) return 7;
  if (source === "OpenSubtitles") return 8;
  return 9;
}

function isEnglish(s: any): boolean {
  return (
    (s.lang || "").toLowerCase().startsWith("en") ||
    (s.languageName || "").toLowerCase().includes("english")
  );
}

// ── Router factory ────────────────────────────────────────────────────────────
// Accepts fetchVidLinkRaw injected from server.ts to avoid circular imports.

export function createSubtitleRouter(
  fetchVidLinkRaw: FetchVidLinkRawFn,
): Router {
  const router = Router();

  // ── GET /api/subtitles ──────────────────────────────────────────────────────
  // Aggregates subtitles from: VidVault, Videasy, VidLink, OpenSubtitles, Drama
  // ?force=1 — bypass SubtitleCache and refetch all sources fresh
  router.get("/api/subtitles", async (req: Request, res: Response) => {
    const tmdbId = req.query.tmdbId as string;
    const kind = req.query.type as "movie" | "tv";
    const season = parseInt((req.query.season as string) || "1", 10);
    const episode = parseInt((req.query.episode as string) || "1", 10);
    const title = req.query.title as string;
    const force = req.query.force === "1";

    if (!tmdbId || !kind) {
      return res.status(400).json({ error: "Missing tmdbId or type" });
    }

    try {
      // 1. Permanent cache — skip when force=1
      if (!force) {
        const cached = await SubtitleCache.findOne({
          tmdbId,
          type: kind,
          season,
          episode,
        });
        if (cached && cached.subtitles?.length > 0) {
          console.log(`[SUBS] Cache HIT for ${tmdbId} S${season}E${episode}`);
          return res.json({ subtitles: cached.subtitles });
        }
      } else {
        console.log(
          `[SUBS] Force-refetch for ${tmdbId} S${season}E${episode} — bypassing cache`,
        );
      }

      console.log(
        `[SUBS] Aggregating tracks for ${tmdbId} S${season}E${episode}...`,
      );

      const results = await Promise.allSettled([
        // A — OpenSubtitles (via Stremio API)
        getSubtitles(tmdbId, kind, season, episode, title),

        // C — VidVault subtitles
        (async () => {
          try {
            const downloads = await fetchVidVaultDownloads(
              kind,
              tmdbId,
              season,
              episode,
            );
            const first = downloads.find(
              (d) => d.subtitles && d.subtitles.length > 0,
            );
            if (first) {
              return first.subtitles.map((s) => ({
                id:
                  kind === "tv"
                    ? `vidvault-${s.lan}-${season}-${episode}`
                    : `vidvault-${s.lan}`,
                url: s.url,
                lang: s.lan,
                languageName: s.lanName,
                source: "VidVault",
              }));
            }
          } catch (err: any) {
            console.warn(`[SUBS] VidVault extraction failed: ${err.message}`);
          }
          return [];
        })(),

        // D — Videasy subtitles from StreamCache
        (async () => {
          try {
            const videasyCache = await StreamCache.findOne({
              tmdbId: `${tmdbId}-videasy`,
              type: kind,
              season,
              episode,
            });
            if (!videasyCache?.mirrors?.length) return [];
            const subMap = new Map<string, any>();
            videasyCache.mirrors.forEach((m: any) => {
              m.subtitles?.forEach((s: any) => {
                if (s?.url && !subMap.has(s.url)) {
                  subMap.set(s.url, {
                    id: `videasy-${s.lang || s.language || "unk"}-${subMap.size}`,
                    url: s.url,
                    lang: s.lang || s.language || "unk",
                    languageName:
                      s.label || s.languageName || s.lang || "Unknown",
                    source: "Videasy",
                  });
                }
              });
            });
            return Array.from(subMap.values());
          } catch (err: any) {
            console.warn(
              `[SUBS] Videasy cache extraction failed: ${err.message}`,
            );
            return [];
          }
        })(),

        // E — VidLink subtitles from StreamCache
        (async () => {
          try {
            const vidlinkCache = await StreamCache.findOne({
              tmdbId: tmdbId.toString(),
              type: kind,
              season,
              episode,
            });
            if (!vidlinkCache?.mirrors?.length) return [];
            const subMap = new Map<string, any>();
            vidlinkCache.mirrors
              .filter((m: any) => m.source === "VidLink")
              .forEach((m: any) => {
                m.subtitles?.forEach((s: any) => {
                  if (s?.url && !subMap.has(s.url)) {
                    subMap.set(s.url, {
                      id: `vidlink-${s.lang || "unk"}-${subMap.size}`,
                      url: s.url,
                      lang: s.lang || "unk",
                      languageName:
                        s.languageName || s.label || s.lang || "Unknown",
                      source: "VidLink",
                    });
                  }
                });
              });
            return Array.from(subMap.values());
          } catch (err: any) {
            console.warn(
              `[SUBS] VidLink cache extraction failed: ${err.message}`,
            );
            return [];
          }
        })(),

        // F — FilmU subtitles from StreamCache
        (async () => {
          try {
            const filmuCache = await StreamCache.findOne({
              tmdbId: tmdbId.toString(),
              type: kind,
              season,
              episode,
            });
            if (!filmuCache?.mirrors?.length) return [];
            const subMap = new Map<string, any>();
            filmuCache.mirrors
              .filter((m: any) => m.source && m.source.startsWith("FilmU"))
              .forEach((m: any) => {
                m.subtitles?.forEach((s: any) => {
                  if (s?.url && !subMap.has(s.url)) {
                    subMap.set(s.url, {
                      id: `filmu-${s.lang || "unk"}-${subMap.size}`,
                      url: s.url,
                      lang: s.lang || "unk",
                      languageName:
                        s.languageName || s.label || s.lang || "Unknown",
                      source: m.source,
                    });
                  }
                });
              });
            return Array.from(subMap.values());
          } catch (err: any) {
            console.warn(
              `[SUBS] FilmU cache extraction failed: ${err.message}`,
            );
            return [];
          }
        })(),

        // G — Vidnest subtitles from StreamCache
        (async () => {
          try {
            const vidnestCache = await StreamCache.findOne({
              tmdbId: tmdbId.toString(),
              type: kind,
              season,
              episode,
            });
            if (!vidnestCache?.mirrors?.length) return [];
            const subMap = new Map<string, any>();
            vidnestCache.mirrors
              .filter(
                (m: any) =>
                  typeof m.source === "string" &&
                  m.source.startsWith("Vidnest"),
              )
              .forEach((m: any) => {
                m.subtitles?.forEach((s: any) => {
                  if (s?.url && !subMap.has(s.url)) {
                    subMap.set(s.url, {
                      id: `vidnest-${s.lang || "unk"}-${subMap.size}`,
                      url: s.url,
                      lang: s.lang || "unk",
                      languageName:
                        s.languageName || s.label || s.lang || "Unknown",
                      source: "Vidnest",
                    });
                  }
                });
              });
            return Array.from(subMap.values());
          } catch (err: any) {
            console.warn(
              `[SUBS] Vidnest cache extraction failed: ${err.message}`,
            );
            return [];
          }
        })(),

        // H — Vaplayer subtitles from StreamCache
        (async () => {
          try {
            const vaplayerCache = await StreamCache.findOne({
              tmdbId: tmdbId.toString(),
              type: kind,
              season,
              episode,
            });
            if (!vaplayerCache?.mirrors?.length) return [];
            const subMap = new Map<string, any>();
            vaplayerCache.mirrors
              .filter(
                (m: any) =>
                  typeof m.source === "string" &&
                  m.source.startsWith("Vaplayer"),
              )
              .forEach((m: any) => {
                m.subtitles?.forEach((s: any) => {
                  if (s?.url && !subMap.has(s.url)) {
                    subMap.set(s.url, {
                      id: `vaplayer-${s.lang || "unk"}-${subMap.size}`,
                      url: s.url,
                      lang: s.lang || "unk",
                      languageName:
                        s.languageName || s.label || s.lang || "Unknown",
                      source: "Vaplayer",
                    });
                  }
                });
              });
            return Array.from(subMap.values());
          } catch (err: any) {
            console.warn(
              `[SUBS] Vaplayer cache extraction failed: ${err.message}`,
            );
            return [];
          }
        })(),
      ]);

      const [
        openSubsResult,
        vidVaultResult,
        videasyResult,
        vidLinkResult,
        filmuResult,
        vidnestResult,
        vaplayerResult,
      ] = results;

      const openSubsTrack =
        openSubsResult.status === "fulfilled" ? openSubsResult.value : [];
      const vidVaultTrack =
        vidVaultResult.status === "fulfilled" ? vidVaultResult.value : [];
      const videasyTrack =
        videasyResult.status === "fulfilled" ? videasyResult.value : [];
      const vidLinkTrack =
        vidLinkResult.status === "fulfilled" ? vidLinkResult.value : [];
      const filmuTrack =
        filmuResult && filmuResult.status === "fulfilled"
          ? filmuResult.value
          : [];
      const vidnestTrack =
        vidnestResult && vidnestResult.status === "fulfilled"
          ? vidnestResult.value
          : [];
      const vaplayerTrack =
        vaplayerResult && vaplayerResult.status === "fulfilled"
          ? vaplayerResult.value
          : [];

      console.log(
        `[SUBS] Sources — VidVault:${vidVaultTrack.length} Videasy:${videasyTrack.length} VidLink:${vidLinkTrack.length} FilmU:${filmuTrack.length} Vidnest:${vidnestTrack.length} Vaplayer:${vaplayerTrack.length} OpenSubs:${openSubsTrack.length}`,
      );

      // Deduplicate by URL across sources
      const seenUrls = new Set<string>();
      const dedup = (tracks: any[]): any[] =>
        tracks.filter((s) => {
          if (!s?.url || seenUrls.has(s.url)) return false;
          seenUrls.add(s.url);
          return true;
        });

      // Merge in priority order (English VidLink/Videasy before non-English)
      const allTracksOrdered = [
        ...dedup(vidVaultTrack),
        ...dedup(filmuTrack.filter(isEnglish)),
        ...dedup(vidLinkTrack.filter(isEnglish)),
        ...dedup(videasyTrack.filter(isEnglish)),
        ...dedup(vidnestTrack.filter(isEnglish)),
        ...dedup(vaplayerTrack.filter(isEnglish)),
        ...dedup(filmuTrack.filter((s) => !isEnglish(s))),
        ...dedup(vidLinkTrack.filter((s) => !isEnglish(s))),
        ...dedup(videasyTrack.filter((s) => !isEnglish(s))),
        ...dedup(vidnestTrack.filter((s) => !isEnglish(s))),
        ...dedup(vaplayerTrack.filter((s) => !isEnglish(s))),
        ...dedup(openSubsTrack),
      ];

      // Final sort: English first, then by source priority within each language tier
      const sorted = allTracksOrdered.sort((a, b) => {
        const aEng = isEnglish(a);
        const bEng = isEnglish(b);
        if (aEng && !bEng) return -1;
        if (!aEng && bEng) return 1;
        return sourcePriority(a.source) - sourcePriority(b.source);
      });

      // 2. Persist to SubtitleCache (upsert — also refreshes on force-refetch)
      if (sorted.length > 0) {
        await SubtitleCache.findOneAndUpdate(
          { tmdbId, type: kind, season, episode },
          {
            subtitles: sorted,
            aggregatedAt: new Date(),
            expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
          },
          { upsert: true },
        ).catch(() => null);
      }

      const proxied = sorted.map((s) => {
        if (s.url?.startsWith("http")) {
          return {
            ...s,
            url: `/api/proxy/subtitle?url=${encodeURIComponent(s.url)}`,
          };
        }
        return s;
      });

      return res.json({ subtitles: proxied });
    } catch (err: any) {
      console.error(`[SUBS ERROR] ${err.message}`);
      return res.status(500).json({ error: err.message, subtitles: [] });
    }
  });

  // ── GET /api/proxy/subtitle ─────────────────────────────────────────────────
  // CORS bypass + KissKH decryption + SRT→VTT conversion
  router.get("/api/proxy/subtitle", async (req: Request, res: Response) => {
    const url = req.query.url as string;
    if (!url) return res.status(400).send("Missing url");

    // SSRF guard
    try {
      const parsed = new URL(url);
      const allowed = SUBTITLE_ALLOWLIST.some(
        (domain) =>
          parsed.hostname === domain || parsed.hostname.endsWith(`.${domain}`),
      );
      if (!allowed) {
        console.warn(`[SUBS] Blocked SSRF attempt: ${parsed.hostname}`);
        return res.status(403).send("Domain not allowed");
      }
    } catch {
      return res.status(400).send("Invalid url");
    }

    try {
      let rawBuffer: Buffer;
      let finalUrl = url;

      let referer = process.env.FRONTEND_URL || "https://nebulawatch.tech/";
      let origin: string | undefined;

      if (
        url.includes("vidlink") ||
        url.includes("megafiles") ||
        url.includes("storm.vodvidl.site") ||
        url.includes("cacdn.hakunaymatata.com")
      ) {
        referer = "https://vidlink.pro/";
        origin = "https://vidlink.pro";
      } else if (
        url.includes("vdrk.site") ||
        url.includes("vidrock.ru") ||
        /stor+m\.site/.test(url) ||
        url.includes("workers.dev") ||
        (url.includes("hakunaymatata.com") &&
          !url.includes("cacdn.hakunaymatata.com"))
      ) {
        referer = "https://vidrock.ru/";
        origin = "https://vidrock.ru";
      } else if (url.includes("videasy") || url.includes("goldweather.net")) {
        referer = "https://vidlink.pro/";
        origin = "https://vidlink.pro";
      }

      const headers: Record<string, string> = {
        "User-Agent": UA,
        Referer: referer,
      };
      if (origin) headers.Origin = origin;

      let bypass: any;
      if (url.includes("storm.vodvidl.site")) {
        const raw = await fetchVidLinkRaw(url, headers);
        bypass = {
          statusCode: raw.statusCode,
          headers: raw.headers,
          body: raw.body,
          finalUrl: raw.finalUrl,
        };
      } else {
        bypass = await fetchWithGotScraping(url, headers);
      }

      // CycleTLS fallback for Cloudflare-protected domains
      if (
        bypass.statusCode >= 400 &&
        (url.includes("vidlink") || url.includes("megafiles"))
      ) {
        console.warn(
          `[SUBS] GotScraping failed (${bypass.statusCode}). Trying CycleTLS JA3 Spoofer...`,
        );
        try {
          const cycle = await fetchWithCycleTLS(url, headers);
          if (cycle.statusCode < 400) {
            bypass = cycle;
          }
        } catch (cycleErr: any) {
          console.error(`[SUBS] CycleTLS failed: ${cycleErr.message}`);
        }
      }

      if (bypass.statusCode >= 400) {
        console.warn(
          `[SUBS] All bypasses failed for ${url} (${bypass.statusCode}). Falling back to Axios...`,
        );
        const response = await axios.get(url, {
          timeout: 45000,
          headers,
          responseType: "arraybuffer",
        });
        rawBuffer = Buffer.from(response.data);
      } else {
        rawBuffer = bypass.body;
        finalUrl = bypass.finalUrl || url;
      }

      // ── Step 1: Decode to UTF-8 ────────────────────────────────────────────
      let content: string;
      const detected = jschardet.detect(rawBuffer);
      if (
        detected.encoding &&
        detected.confidence > 0.5 &&
        !detected.encoding.toLowerCase().includes("utf") &&
        !detected.encoding.toLowerCase().includes("ascii")
      ) {
        console.log(
          `[SUBS/proxy] Detected encoding: ${detected.encoding} (${(detected.confidence * 100).toFixed(0)}%) — converting to UTF-8`,
        );
        content = iconv.decode(rawBuffer, detected.encoding);
      } else {
        content = rawBuffer.toString("utf-8");
      }

      // ── Step 2: Strip BOM & normalize line endings ─────────────────────────
      content = content.replace(/^\uFEFF/, "");
      content = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

      // ── Step 4: SRT → VTT conversion ──────────────────────────────────────
      const trimmed = content.trim();
      if (!trimmed.startsWith("WEBVTT")) {
        content = content.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
        content = content.replace(/^\d+\n(?=\d{2}:\d{2}:\d{2})/gm, "");
        content = "WEBVTT\n\n" + content.trim() + "\n";
      }

      // ── Step 5: Clean up formatting artifacts ─────────────────────────────
      content = content.replace(/\{\\an\d+\}/g, "");
      content = content.replace(/<font[^>]*>/gi, "").replace(/<\/font>/gi, "");
      content = content.replace(
        /(\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3})\n\n/g,
        "",
      );

      res.setHeader("Content-Type", "text/vtt; charset=utf-8");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "public, max-age=86400");
      return res.send(content);
    } catch (e: any) {
      console.error(`[SUBS/proxy] Failed for ${url}: ${e.message}`);
      return res.status(500).send("Subtitle proxy failed");
    }
  });

  return router;
}
