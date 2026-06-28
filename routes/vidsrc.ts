/**
 * routes/vidsrc.ts
 * Standalone Vidsrc source scraper route — easily detachable from server.ts.
 *
 * Endpoint:
 *   GET  /api/vidsrc  — Returns Vidsrc mirror streams for a given tmdbId/type.
 */

import { Router, type Request, type Response } from "express";
import { StreamCache, DeadPool } from "../models/Cache.js";
import { VidsrcScraper } from "../utils/vidsrc.js";

// ── Router factory ────────────────────────────────────────────────────────────
export function createVidsrcRouter(): Router {
  const router = Router();

  /**
   * GET /api/vidsrc
   *
   * Query params:
   *   tmdbId   — TMDB numeric ID (required)
   *   type     — "movie" | "tv"  (required)
   *   season   — integer (required for TV)
   *   episode  — integer (required for TV)
   *   force=1  — bypass cache and re-scrape
   *
   * Response shape (mirrors /api/vidnest):
   *   { "Vidsrc (Server 1)": { url, type, quality, subtitles }, ... }
   */
  router.get("/api/vidsrc", async (req: Request, res: Response) => {
    const tmdbId = req.query.tmdbId as string;
    const type = req.query.type as "movie" | "tv";
    const seasonStr = req.query.season as string;
    const episodeStr = req.query.episode as string;

    if (!tmdbId || !type) {
      return res.status(400).json({ error: "Missing tmdbId or type" });
    }

    if (type === "tv" && (!seasonStr || !episodeStr)) {
      return res
        .status(400)
        .json({ error: "Missing season or episode for TV show" });
    }

    const season = type === "tv" ? parseInt(seasonStr, 10) : 1;
    const episode = type === "tv" ? parseInt(episodeStr, 10) : 1;

    if (isNaN(season) || isNaN(episode)) {
      return res
        .status(400)
        .json({ error: "Invalid season or episode (must be integers)" });
    }

    try {
      const force = req.query.force === "1" || req.query.nocache === "1";

      // ── 1. Cache check ────────────────────────────────────────────────────
      const cachedRecord = force
        ? null
        : await StreamCache.findOne({
            tmdbId: tmdbId.toString(),
            type,
            season,
            episode,
          }).catch(() => null);

      if (
        cachedRecord &&
        cachedRecord.mirrors &&
        cachedRecord.mirrors.length > 0
      ) {
        const vidsrcMirrors = (cachedRecord.mirrors as any[]).filter(
          (m: any) =>
            typeof m.source === "string" && m.source.startsWith("Vidsrc"),
        );

        if (
          vidsrcMirrors.length > 0 &&
          (!cachedRecord.streamExpiresAt ||
            new Date() < cachedRecord.streamExpiresAt)
        ) {
          console.log(
            `[VIDSRC] Cache HIT ✔ for ${tmdbId} S${season}E${episode} (${vidsrcMirrors.length} mirrors)`,
          );
          return res.json(buildResponseObject(vidsrcMirrors));
        }
      }

      // ── 2. Live scrape with race timeout ──────────────────────────────────
      let fetchFinished = false;
      let fetchResult: Record<string, any> | null = null;

      const runScan = async () => {
        try {
          const mirrors = await VidsrcScraper.getStream({
            tmdbId,
            kind: type,
            season,
            episode,
          });

          fetchFinished = true;
          if (!mirrors || mirrors.length === 0) return null;

          const responseData = buildResponseObject(mirrors);

          // ── Upsert back into StreamCache (same as /api/stream) ──────────
          const firstMirror = mirrors[0];
          if (firstMirror) {
            const cacheExpires = new Date();
            cacheExpires.setHours(cacheExpires.getHours() + 4);

            const existingRecord = await StreamCache.findOne({
              tmdbId: tmdbId.toString(),
              type,
              season,
              episode,
            }).catch(() => null);

            if (existingRecord && existingRecord.mirrors) {
              // Merge: keep non-Vidsrc mirrors, replace/add Vidsrc ones
              const nonVidsrcMirrors = (existingRecord.mirrors as any[]).filter(
                (m: any) =>
                  typeof m.source !== "string" ||
                  !m.source.startsWith("Vidsrc"),
              );
              const mergedMirrors = [...nonVidsrcMirrors, ...mirrors];

              await StreamCache.findOneAndUpdate(
                { tmdbId: tmdbId.toString(), type, season, episode },
                {
                  mirrors: mergedMirrors,
                  streamExpiresAt: cacheExpires,
                  expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
                },
              ).catch(() => null);
            } else {
              await StreamCache.findOneAndUpdate(
                { tmdbId: tmdbId.toString(), type, season, episode },
                {
                  streamUrl: firstMirror.url,
                  source: firstMirror.source || "Vidsrc",
                  qualityTag: "HD",
                  resolution: firstMirror.quality || "1080p",
                  mirrors,
                  streamExpiresAt: cacheExpires,
                  expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
                },
                { upsert: true },
              ).catch(() => null);
            }

            await DeadPool.deleteMany({
              tmdbId: { $in: [tmdbId.toString()] },
              type,
              season,
              episode,
            }).catch(() => null);
          }

          fetchResult = responseData;
          return responseData;
        } catch (err: any) {
          console.warn(
            `[VIDSRC] Scan failed for ${tmdbId} S${season}E${episode}: ${err.message}`,
          );
          fetchFinished = true;
          return null;
        }
      };

      const scanPromise = runScan();
      // Give the scraper 10 seconds to resolve (since we do parallel server fetching)
      const raceTimeout = new Promise<void>((resolve) =>
        setTimeout(resolve, 10000),
      );

      await Promise.race([scanPromise, raceTimeout]);

      if (fetchFinished) {
        return res.json(fetchResult || {});
      } else {
        console.log(
          `[VIDSRC] Scan still running after 10s for ${tmdbId}. Returning empty — bg scan continues.`,
        );
        return res.json({});
      }
    } catch (error: any) {
      console.error("[VIDSRC] Route error:", error.message);
      return res
        .status(500)
        .json({ error: "Failed to fetch from Vidsrc providers" });
    }
  });

  return router;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Converts a MirrorStream[] from VidsrcScraper into the keyed object shape
 * that the frontend expects (same as /api/filmu).
 */
function buildResponseObject(mirrors: any[]): Record<string, any> {
  const responseData: Record<string, any> = {};
  mirrors.forEach((m: any) => {
    responseData[m.source] = {
      url: m.url,
      type: m.type || "mp4",
      quality: m.quality || "Auto",
      source: m.source,
      subtitles: m.subtitles || [],
    };
  });
  return responseData;
}
