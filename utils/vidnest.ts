import { gotScraping } from "got-scraping";
import type { MirrorStream, SubtitleStream } from "./scraper.js";

const VIDNEST_ALPHA =
  "RB0fpH8ZEyVLkv7c2i6MAJ5u3IKFDxlS1NTsnGaqmXYdUrtzjwObCgQP94hoeW+/=";
const STANDARD_ALPHA =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";

export function decodeVidnest(data: string): string {
  const charMap: Record<string, string> = {};
  for (let i = 0; i < VIDNEST_ALPHA.length; i++) {
    charMap[VIDNEST_ALPHA[i]!] = STANDARD_ALPHA[i]!;
  }

  let standardBase64 = "";
  for (let i = 0; i < data.length; i++) {
    const char = data[i]!;
    standardBase64 += charMap[char] || char;
  }

  return Buffer.from(standardBase64, "base64").toString("utf-8");
}

export class VidnestScraper {
  public static async getStream(params: {
    tmdbId: string;
    kind: "movie" | "tv";
    season?: number;
    episode?: number;
    proxyUrl?: string | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<MirrorStream[]> {
    const { tmdbId, kind, season = 1, episode = 1, proxyUrl, signal } = params;

    const baseUrl = "https://new.vidnest.fun";
    const streamUrl =
      kind === "movie"
        ? `${baseUrl}/moviebox/movie/${tmdbId}`
        : `${baseUrl}/moviebox/tv/${tmdbId}/${season}/${episode}`;

    const subUrl =
      kind === "movie"
        ? `${baseUrl}/subtitles/${tmdbId}`
        : `${baseUrl}/subtitles/${tmdbId}/${season}/${episode}`;

    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
      Origin: "https://vidnest.fun",
      Referer: "https://vidnest.fun/",
    };

    const gotOptions: any = {
      headers,
      responseType: "json",
      timeout: { request: 15000 },
    };
    if (proxyUrl) gotOptions.proxyUrl = proxyUrl;
    if (signal) gotOptions.signal = signal;

    // Fetch streams and subtitles in parallel
    const [streamsRes, subsRes] = await Promise.allSettled([
      gotScraping.get(streamUrl, gotOptions),
      gotScraping.get(subUrl, gotOptions),
    ]);

    if (streamsRes.status === "rejected") {
      throw new Error(
        `Vidnest streams fetch failed: ${streamsRes.reason.message}`,
      );
    }

    const streamPayload = streamsRes.value.body as any;
    let streamData: any = streamPayload;
    if (streamPayload?.encrypted && streamPayload?.data) {
      try {
        const decryptedStr = decodeVidnest(streamPayload.data);
        streamData = JSON.parse(decryptedStr);
      } catch (err: any) {
        throw new Error(
          `Failed to decrypt/parse Vidnest streams: ${err.message}`,
        );
      }
    }

    const urls = streamData?.url || [];
    if (!Array.isArray(urls) || urls.length === 0) {
      return [];
    }

    // Parse subtitles if successful
    let subtitles: SubtitleStream[] = [];
    if (subsRes.status === "fulfilled") {
      const subsPayload = subsRes.value.body as any;
      let subsData = subsPayload;
      if (subsPayload?.encrypted && subsPayload?.data) {
        try {
          const decryptedStr = decodeVidnest(subsPayload.data);
          subsData = JSON.parse(decryptedStr);
        } catch (err) {
          console.warn("[Vidnest Scraper] Failed to decrypt subtitles:", err);
        }
      }

      if (Array.isArray(subsData)) {
        subtitles = subsData
          .filter((s: any) => s.url && s.lang)
          .map((s: any) => ({
            url: s.url,
            lang: s.lang,
            languageName: s.lang,
            source: "Vidnest",
          }));
      }
    }

    // Map links to MirrorStream
    return urls.map((u: any) => {
      let link = u.link;
      // Re-route hakunaymatata.com through Cloudflare worker proxy
      if (
        link &&
        link.includes("hakunaymatata.com") &&
        !link.includes("cacdn.hakunaymatata.com") &&
        !link.includes("workers.dev")
      ) {
        link = `https://dreadnought.47qzoobg8k.workers.dev/${encodeURIComponent(link)}`;
      }

      return {
        url: link || "",
        source: `Vidnest (${u.resolution || "Auto"})`,
        quality: u.resolution || "Auto",
        type: u.type === "mp4" ? "mp4" : "hls",
        subtitles: subtitles,
      };
    });
  }
}
