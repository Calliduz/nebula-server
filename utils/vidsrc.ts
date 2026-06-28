import type { MirrorStream } from "./scraper.js";

export class VidsrcScraper {
  private static readonly baseUrl = "https://vsembed.ru";

  /**
   * Returns the vsembed.ru embed URL as a client-side iframe mirror.
   *
   * Server-side HLS extraction is blocked by Cloudflare Turnstile on the
   * Cloudnestra /prorcp/ player endpoint. The embed URL is returned instead
   * so the real browser handles the CAPTCHA + ad rendering transparently.
   *
   * ⚠ Limitations of embed mode:
   *   - Third-party ads from vsembed.ru are uncontrollable.
   *   - Nebula subtitle overlay is not available.
   *   - Custom player controls (quality picker, skip, AirPlay) are disabled.
   *
   * Supports: Movie & TV (TMDB ID). Anime via MAL/Anilist ID ("ani<id>")
   * is natively supported by vidsrc — extend when needed.
   */
  public static async getStream(params: {
    tmdbId: string;
    kind: "movie" | "tv";
    season?: number;
    episode?: number;
    proxyUrl?: string | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<MirrorStream[]> {
    const { tmdbId, kind, season = 1, episode = 1 } = params;

    const embedUrl =
      kind === "tv"
        ? `${this.baseUrl}/embed/tv/${tmdbId}/${season}/${episode}`
        : `${this.baseUrl}/embed/movie/${tmdbId}`;

    console.log(`[Vidsrc] Embed → ${embedUrl}`);

    return [
      {
        url: embedUrl,
        source: "Vidsrc (Embed)",
        quality: "Auto",
        type: "embed",
        subtitles: [],
      },
    ];
  }
}
