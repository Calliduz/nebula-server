import { Router, type Request, type Response } from "express";
import { StreamCache, DeadPool } from "../models/Cache.js";
import { NetNaijaScraper } from "../utils/netnaija.js";

// ── Router factory ────────────────────────────────────────────────────────────
export function createNetnaijaRouter(): Router {
  const router = Router();

  /**
   * GET /api/netnaija
   *
   * Query params:
   *   tmdbId   — TMDB numeric ID (required)
   *   type     — "movie" | "tv"  (required)
   *   season   — integer (required for TV)
   *   episode  — integer (required for TV)
   *   title    — optional movie/show title
   *   force=1  — bypass cache and re-scrape
   */
  router.get("/api/netnaija", async (req: Request, res: Response) => {
    const tmdbId = req.query.tmdbId as string;
    const type = req.query.type as "movie" | "tv";
    const seasonStr = req.query.season as string;
    const episodeStr = req.query.episode as string;
    const title = req.query.title as string | undefined;

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
            tmdbId: `${tmdbId}-netnaija`,
            type,
            season,
            episode,
          }).catch(() => null);

      if (
        cachedRecord &&
        cachedRecord.mirrors &&
        cachedRecord.mirrors.length > 0
      ) {
        const netnaijaMirrors = (cachedRecord.mirrors as any[]).filter(
          (m: any) =>
            typeof m.source === "string" &&
            (m.source.startsWith("Vesper") || m.source.startsWith("NetNaija")),
        );

        if (
          netnaijaMirrors.length > 0 &&
          (!cachedRecord.streamExpiresAt ||
            new Date() < cachedRecord.streamExpiresAt)
        ) {
          console.log(
            `[VESPER/NETNAIJA] Cache HIT ✔ for ${tmdbId} S${season}E${episode} (${netnaijaMirrors.length} mirrors)`,
          );
          return res.json(buildResponseObject(netnaijaMirrors));
        }
      }

      // ── 2. Live scrape with race timeout ──────────────────────────────────
      let fetchFinished = false;
      let fetchResult: Record<string, any> | null = null;

      const runScan = async () => {
        try {
          const mirrors = await NetNaijaScraper.getStream({
            tmdbId,
            kind: type,
            season,
            episode,
            title,
          });

          fetchFinished = true;
          if (!mirrors || mirrors.length === 0) return null;

          const responseData = buildResponseObject(mirrors);

          // ── Upsert back into StreamCache ──────────────────────────────────
          const firstMirror = mirrors[0];
          if (firstMirror) {
            const cacheExpires = new Date();
            cacheExpires.setHours(cacheExpires.getHours() + 4);

            await StreamCache.findOneAndUpdate(
              { tmdbId: `${tmdbId}-netnaija`, type, season, episode },
              {
                streamUrl: firstMirror.url,
                source: firstMirror.source || "Vesper",
                qualityTag: "HD",
                resolution: firstMirror.quality || "1080p",
                mirrors,
                streamExpiresAt: cacheExpires,
                expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
              },
              { upsert: true },
            ).catch(() => null);

            await DeadPool.deleteMany({
              tmdbId: { $in: [tmdbId.toString(), `${tmdbId}-netnaija`] },
              type,
              season,
              episode,
            }).catch(() => null);
          }

          fetchResult = responseData;
          return responseData;
        } catch (err: any) {
          console.warn(
            `[VESPER/NETNAIJA] Scan failed for ${tmdbId} S${season}E${episode}: ${err.message}`,
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
          `[VESPER/NETNAIJA] Scan still running after 8s for ${tmdbId}. Returning empty — bg scan continues.`,
        );
        return res.json({});
      }
    } catch (error: any) {
      console.error("[VESPER/NETNAIJA] Route error:", error.message);
      return res
        .status(500)
        .json({ error: "Failed to fetch from Vesper providers" });
    }
  });

  return router;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildResponseObject(mirrors: any[]): Record<string, any> {
  const responseData: Record<string, any> = {};
  let globalSubtitles: any[] = [];

  mirrors.forEach((m: any, index: number) => {
    if (
      Array.isArray(m.subtitles) &&
      m.subtitles.length > 0 &&
      globalSubtitles.length === 0
    ) {
      globalSubtitles = m.subtitles;
    }

    const audio = m.audio || "English";
    const baseSource = m.source || "Vesper";
    const audioTag = audio !== "English" ? ` [${audio}]` : "";

    let key = `${baseSource}${audioTag}`;
    if (responseData[key]) {
      key = `${baseSource}${audioTag} (${index + 1})`;
    }

    responseData[key] = {
      url: m.url,
      type: m.type || "mp4",
      quality: m.quality || "Auto",
      source: key,
      audio,
      headers: m.headers || {},
      subtitles: m.subtitles || [],
    };
  });

  if (globalSubtitles.length > 0) {
    responseData.subtitles = globalSubtitles;
  }
  return responseData;
}
