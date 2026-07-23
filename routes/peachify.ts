/**
 * routes/peachify.ts
 * Standalone Peachify source scraper route.
 *
 * Endpoint:
 *   GET  /api/peachify  — Returns Peachify mirror streams for a given tmdbId/type.
 */

import { Router, type Request, type Response } from "express";
import { StreamCache, DeadPool } from "../models/Cache.js";
import { PeachifyScraper } from "../utils/peachify.js";

export function createPeachifyRouter(): Router {
  const router = Router();

  /**
   * GET /api/peachify
   *
   * Query params:
   *   tmdbId   — TMDB numeric ID (required)
   *   type     — "movie" | "tv"  (required)
   *   season   — integer (required for TV)
   *   episode  — integer (required for TV)
   *   force=1  — bypass cache and re-scrape
   */
  router.get("/api/peachify", async (req: Request, res: Response) => {
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

      // 1. Cache check
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
        const peachifyMirrors = (cachedRecord.mirrors as any[]).filter(
          (m: any) =>
            typeof m.source === "string" && m.source.startsWith("Peachify"),
        );

        if (
          peachifyMirrors.length > 0 &&
          (!cachedRecord.streamExpiresAt ||
            new Date() < cachedRecord.streamExpiresAt)
        ) {
          console.log(
            `[PEACHIFY] Cache HIT ✔ for ${tmdbId} S${season}E${episode} (${peachifyMirrors.length} mirrors)`,
          );
          return res.json(buildResponseObject(peachifyMirrors));
        }
      }

      // 2. Live scrape with race timeout
      let fetchFinished = false;
      let fetchResult: Record<string, any> | null = null;

      const runScan = async () => {
        try {
          const mirrors = await PeachifyScraper.getStream({
            tmdbId,
            kind: type,
            season,
            episode,
          });

          fetchFinished = true;
          if (!mirrors || mirrors.length === 0) return null;

          const responseData = buildResponseObject(mirrors);

          // Upsert back into StreamCache
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
              // Merge: keep non-Peachify mirrors, replace/add Peachify ones
              const nonPeachifyMirrors = (
                existingRecord.mirrors as any[]
              ).filter(
                (m: any) =>
                  typeof m.source !== "string" ||
                  !m.source.startsWith("Peachify"),
              );
              const mergedMirrors = [...nonPeachifyMirrors, ...mirrors];

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
                  source: firstMirror.source || "Peachify",
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
            `[PEACHIFY] Scan failed for ${tmdbId} S${season}E${episode}: ${err.message}`,
          );
          fetchFinished = true;
          return null;
        }
      };

      const scanPromise = runScan();
      const raceTimeout = new Promise<void>((resolve) =>
        setTimeout(resolve, 6000),
      );

      await Promise.race([scanPromise, raceTimeout]);

      if (fetchFinished && fetchResult) {
        return res.json(fetchResult);
      } else {
        console.log(
          `[PEACHIFY] Scan still running after 6s for ${tmdbId}. Returning empty — bg scan continues.`,
        );
        return res.json({});
      }
    } catch (error: any) {
      console.error("[PEACHIFY] Route error:", error.message);
      return res
        .status(500)
        .json({ error: "Failed to fetch from Peachify providers" });
    }
  });

  return router;
}

function buildResponseObject(mirrors: any[]): Record<string, any> {
  const responseData: Record<string, any> = {};
  const sourceCounts: Record<string, number> = {};

  mirrors.forEach((m: any) => {
    const baseSource = m.source || "Peachify";
    sourceCounts[baseSource] = (sourceCounts[baseSource] || 0) + 1;
    const count = sourceCounts[baseSource];
    const key = count === 1 ? baseSource : `${baseSource} #${count}`;
    responseData[key] = {
      url: m.url,
      type: m.type || "hls",
      quality: m.quality || "Auto",
      source: baseSource,
      headers: m.headers || {},
      subtitles: m.subtitles || [],
    };
  });

  return responseData;
}
