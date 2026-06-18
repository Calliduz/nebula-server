/**
 * routes/filmu.ts
 * Standalone FilmU source scraper route — easily detachable from server.ts.
 *
 * Endpoint:
 *   GET  /api/filmu  — Returns FilmU mirror streams for a given tmdbId/type.
 *
 * To disable entirely:   set FILMU_ENABLED=false in .env and remove the
 *                        app.use(createFilmuRouter()) line from server.ts.
 */

import { Router, type Request, type Response } from "express";
import { StreamCache, DeadPool } from "../models/Cache.js";
import { FilmuScraper } from "../utils/filmu/index.js";

// ── Router factory ────────────────────────────────────────────────────────────
export function createFilmuRouter(): Router {
  const router = Router();

  /**
   * GET /api/filmu
   *
   * Query params:
   *   tmdbId   — TMDB numeric ID (required)
   *   type     — "movie" | "tv"  (required)
   *   season   — integer (required for TV)
   *   episode  — integer (required for TV)
   *   title    — URL-encoded title (optional, forwarded to TMDB lookup)
   *   releaseYear — 4-digit year (optional)
   *   force=1  — bypass cache and re-scrape
   *
   * Response shape (mirrors /api/vidlink):
   *   { "FilmU-Vortex": { url, type, quality }, "FilmU-Zenith": {...}, ... }
   */
  router.get("/api/filmu", async (req: Request, res: Response) => {
    if (process.env.FILMU_ENABLED === "false") {
      return res
        .status(503)
        .json({ error: "FilmU provider is currently disabled." });
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
        const filmuMirrors = (cachedRecord.mirrors as any[]).filter(
          (m: any) => typeof m.source === "string" && m.source.startsWith("FilmU"),
        );

        if (
          filmuMirrors.length > 0 &&
          (!cachedRecord.streamExpiresAt ||
            new Date() < cachedRecord.streamExpiresAt)
        ) {
          console.log(
            `[FILMU] Cache HIT ✔ for ${tmdbId} S${season}E${episode} (${filmuMirrors.length} mirrors)`,
          );
          return res.json(buildResponseObject(filmuMirrors));
        }
      }

      // ── 2. Live scrape with race timeout ──────────────────────────────────
      let fetchFinished = false;
      let fetchResult: Record<string, any> | null = null;

      const runScan = async () => {
        try {
          const title = req.query.title
            ? decodeURIComponent(req.query.title as string)
            : undefined;
          const releaseYear = req.query.releaseYear
            ? parseInt(req.query.releaseYear as string, 10) || undefined
            : undefined;

          const mirrors = await FilmuScraper.getStream({
            tmdbId,
            kind: type,
            season,
            episode,
            title,
            year: releaseYear,
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
              // Merge: keep non-FilmU mirrors, replace/add FilmU ones
              const nonFilmuMirrors = (existingRecord.mirrors as any[]).filter(
                (m: any) =>
                  typeof m.source !== "string" || !m.source.startsWith("FilmU"),
              );
              const mergedMirrors = [...nonFilmuMirrors, ...mirrors];

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
                  source: firstMirror.source || "FilmU",
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
            `[FILMU] Scan failed for ${tmdbId} S${season}E${episode}: ${err.message}`,
          );
          fetchFinished = true;
          return null;
        }
      };

      const scanPromise = runScan();
      // Give the scraper 7 seconds — FilmU requires TMDB lookups + parallel
      // provider scrapes, so it's slower than VidLink's direct WASM token.
      const raceTimeout = new Promise<void>((resolve) =>
        setTimeout(resolve, 7000),
      );

      await Promise.race([scanPromise, raceTimeout]);

      if (fetchFinished && fetchResult) {
        return res.json(fetchResult);
      } else {
        console.log(
          `[FILMU] Scan still running after 7s for ${tmdbId}. Returning empty — bg scan continues.`,
        );
        return res.json({});
      }
    } catch (error: any) {
      console.error("[FILMU] Route error:", error.message);
      return res
        .status(500)
        .json({ error: "Failed to fetch from FilmU providers" });
    }
  });

  return router;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Converts a MirrorStream[] from FilmuScraper into the keyed object shape
 * that the frontend's SourceSelectionModal expects (same as /api/vidlink).
 */
function buildResponseObject(mirrors: any[]): Record<string, any> {
  const responseData: Record<string, any> = {};
  const sourceCounts: Record<string, number> = {};

  mirrors.forEach((m: any) => {
    const baseSource = m.source || "FilmU";
    sourceCounts[baseSource] = (sourceCounts[baseSource] || 0) + 1;
    const count = sourceCounts[baseSource];
    const key = count === 1 ? baseSource : `${baseSource} #${count}`;
    responseData[key] = {
      url: m.url,
      type: m.type || "hls",
      quality: m.quality || "Auto",
      source: baseSource,
    };
  });

  return responseData;
}
