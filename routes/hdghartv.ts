/**
 * routes/hdghartv.ts
 * Standalone HDGharTV source scraper route.
 *
 * Endpoint:
 *   GET /api/hdghartv — Returns HDGharTV mirrors for tmdbId/type.
 */

import { Router, type Request, type Response } from "express";
import { StreamCache } from "../models/Cache.js";
import { HdgHarTvScraper } from "../utils/hdghartv.js";

function buildResponseObject(mirrors: any[]) {
  const result: Record<string, any> = {};
  for (const m of mirrors) {
    const key = m.name || m.source || "HDGharTV";
    result[key] = {
      url: m.url,
      type: m.type || "hls",
      quality: m.quality || "1080p",
      headers: m.headers || {
        Referer: "https://hdghartv.cc/",
        Origin: "https://hdghartv.cc",
      },
    };
  }
  return result;
}

export function createHdgHarTvRouter(): Router {
  const router = Router();

  /**
   * GET /api/hdghartv
   *
   * Query params:
   *   tmdbId   — TMDB numeric ID (required)
   *   type     — "movie" | "tv" (required)
   *   season   — integer (required for TV)
   *   episode  — integer (required for TV)
   *   title    — optional title fallback
   *   force=1  — bypass cache
   */
  router.get("/api/hdghartv", async (req: Request, res: Response) => {
    if (process.env.HDGHARTV_ENABLED === "false") {
      return res.status(503).json({ error: "HDGharTV provider is currently disabled." });
    }

    const tmdbId = req.query.tmdbId as string;
    const type = req.query.type as "movie" | "tv";
    const seasonStr = req.query.season as string;
    const episodeStr = req.query.episode as string;
    const title = req.query.title as string | undefined;

    if (!tmdbId || !type) {
      return res.status(400).json({ error: "Missing tmdbId or type" });
    }

    if (type === "tv" && (!seasonStr || !episodeStr)) {
      return res.status(400).json({ error: "Missing season or episode for TV show" });
    }

    const season = type === "tv" ? parseInt(seasonStr, 10) : 1;
    const episode = type === "tv" ? parseInt(episodeStr, 10) : 1;

    if (isNaN(season) || isNaN(episode)) {
      return res.status(400).json({ error: "Invalid season or episode (must be integers)" });
    }

    try {
      const force = req.query.force === "1" || req.query.nocache === "1";

      // 1. Cache Check
      const cachedRecord = force
        ? null
        : await StreamCache.findOne({
            tmdbId: tmdbId.toString(),
            type,
            season,
            episode,
          }).catch(() => null);

      if (cachedRecord && cachedRecord.mirrors && cachedRecord.mirrors.length > 0) {
        const hdghartvMirrors = (cachedRecord.mirrors as any[]).filter(
          (m: any) =>
            typeof m.source === "string" && m.source.toLowerCase().includes("hdghartv")
        );

        if (
          hdghartvMirrors.length > 0 &&
          (!cachedRecord.streamExpiresAt || new Date() < cachedRecord.streamExpiresAt)
        ) {
          console.log(
            `[HDGHARTV] Cache HIT ✔ for ${tmdbId} S${season}E${episode} (${hdghartvMirrors.length} mirrors)`
          );
          return res.json(buildResponseObject(hdghartvMirrors));
        }
      }

      // 2. Live Scrape
      const mirrors = await HdgHarTvScraper.getStream({
        tmdbId,
        type,
        season,
        episode,
        title,
      });

      if (!mirrors || mirrors.length === 0) {
        return res.status(404).json({ error: "No mirrors found on HDGharTV" });
      }

      // 3. Cache Update
      try {
        const cacheExpires = new Date(Date.now() + 4 * 60 * 60 * 1000); // 4 hrs
        await StreamCache.updateOne(
          { tmdbId: tmdbId.toString(), type, season, episode },
          {
            $addToSet: { mirrors: { $each: mirrors } },
            $set: { streamExpiresAt: cacheExpires },
          },
          { upsert: true }
        );
      } catch (cacheErr: any) {
        console.warn("[HDGHARTV] Failed to write to StreamCache:", cacheErr.message);
      }

      return res.json(buildResponseObject(mirrors));
    } catch (err: any) {
      console.error(`[HDGHARTV] Router error for TMDB ${tmdbId}:`, err.message);
      return res.status(500).json({ error: "Internal server error fetching HDGharTV streams" });
    }
  });

  return router;
}
