/**
 * routes/cinesrc.ts
 * Standalone CineSrc source scraper route — easily detachable from server.ts.
 *
 * Endpoint:
 *   GET /api/cinesrc — Returns CineSrc mirror streams for a given tmdbId/type.
 *
 * To disable entirely: set CINESRC_ENABLED=false in .env and remove the
 *                      app.use(createCineSrcRouter()) line from server.ts.
 */

import { Router, type Request, type Response } from "express";
import { StreamCache, DeadPool } from "../models/Cache.js";
import { CineSrcScraper } from "../utils/cinesrc.js";

// ── Router factory ────────────────────────────────────────────────────────────
export function createCineSrcRouter(): Router {
  const router = Router();

  /**
   * GET /api/cinesrc
   *
   * Query params:
   *   tmdbId   — TMDB numeric ID (required)
   *   type     — "movie" | "tv"  (required)
   *   season   — integer (required for TV)
   *   episode  — integer (required for TV)
   *   force=1  — bypass cache and re-scrape
   *
   * Response shape:
   *   { "CineSrc (1080p)": { url, type, quality, source }, ... }
   */
  router.get("/api/cinesrc", async (req: Request, res: Response) => {
    if (process.env.CINESRC_ENABLED === "false") {
      return res
        .status(503)
        .json({ error: "CineSrc provider is currently disabled." });
    }

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
        const cinesrcMirrors = (cachedRecord.mirrors as any[]).filter(
          (m: any) =>
            typeof m.source === "string" &&
            (m.source.toLowerCase().includes("cinesrc") ||
              m.source.toLowerCase().includes("starlight") ||
              [
                "NEBULA",
                "THUNDER",
                "SURGE",
                "SPARK",
                "STORM",
                "FLUX",
                "RUSH",
                "WATER",
                "MIST",
                "WAVE",
              ].includes(m.source.toUpperCase())),
        );

        if (
          cinesrcMirrors.length > 0 &&
          (!cachedRecord.streamExpiresAt ||
            new Date() < cachedRecord.streamExpiresAt)
        ) {
          console.log(
            `[CINESRC] Cache HIT ✔ for ${tmdbId} S${season}E${episode} (${cinesrcMirrors.length} mirrors)`,
          );
          return res.json(buildResponseObject(cinesrcMirrors));
        }
      }

      // ── 2. Live scrape with race timeout ──────────────────────────────────
      let fetchFinished = false;
      let fetchResult: Record<string, any> | null = null;

      const runScan = async () => {
        try {
          const mirrors = await CineSrcScraper.getStream(
            tmdbId.toString(),
            type,
            season,
            episode,
          );

          fetchFinished = true;
          if (!mirrors || mirrors.length === 0) return null;

          const responseData = buildResponseObject(mirrors);

          // ── Upsert back into StreamCache ──────────
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
              // Merge: keep non-CineSrc mirrors, replace/add CineSrc ones
              const nonCinesrcMirrors = (
                existingRecord.mirrors as any[]
              ).filter(
                (m: any) =>
                  typeof m.source !== "string" ||
                  (!m.source.startsWith("CineSrc") &&
                    !m.source.startsWith("cinesrc")),
              );
              const mergedMirrors = [...nonCinesrcMirrors, ...mirrors];

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
                  source: firstMirror.source || "CineSrc",
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
            `[CINESRC] Scan failed for ${tmdbId} S${season}E${episode}: ${err.message}`,
          );
          fetchFinished = true;
          return null;
        }
      };

      const scanPromise = runScan();
      const raceTimeout = new Promise<void>((resolve) =>
        setTimeout(resolve, 8000),
      );

      await Promise.race([scanPromise, raceTimeout]);

      if (fetchFinished && fetchResult) {
        return res.json(fetchResult);
      } else {
        console.log(
          `[CINESRC] Scan still running after 8s for ${tmdbId}. Returning empty — bg scan continues.`,
        );
        return res.json({});
      }
    } catch (error: any) {
      console.error("[CINESRC] Route error:", error.message);
      return res
        .status(500)
        .json({ error: "Failed to fetch from CineSrc providers" });
    }
  });

  return router;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildResponseObject(mirrors: any[]): Record<string, any> {
  const responseData: Record<string, any> = {};
  mirrors.forEach((m: any) => {
    const rawKey = m.source || "CineSrc";
    const key =
      rawKey
        .replace(/^cinesrc-?/i, "")
        .replace(/^starlight-?/i, "")
        .toUpperCase() || "NEBULA";

    responseData[key] = {
      url: m.url,
      type: m.type || "hls",
      quality: m.quality || "1080p",
      source: key,
      headers: m.headers,
      subtitles: m.subtitles || [],
    };
  });
  return responseData;
}
