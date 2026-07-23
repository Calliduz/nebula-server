import { gotScraping } from "got-scraping";
import crypto from "crypto";
import type { MirrorStream, SubtitleStream } from "./scraper.js";

const KEY_HEX =
  "a8f2a1b5e9c470814f6b2c3a5d8e7f9c1a2b3c4d5e3f7a8b8cad1e2d0a4d5c5d";
const BASE_STREAM_API = "https://usa.eat-peach.sbs";
const BASE_SUB_API = "https://uwu.eat-peach.sbs";

const PROVIDERS = ["air", "holly", "moviebox", "net", "multi"];

function decodeBase64Url(str: string): Uint8Array {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4) {
    base64 += "=";
  }
  const binary = Buffer.from(base64, "base64");
  return new Uint8Array(binary);
}

async function decryptAesGcm(
  encryptedData: string,
  keyHex: string,
): Promise<any> {
  try {
    const parts = encryptedData.split(".");
    if (parts.length !== 3) {
      throw new Error("Invalid encrypted data format");
    }

    const iv = decodeBase64Url(parts[0]!);
    const ciphertext = decodeBase64Url(parts[1]!);
    const tag = decodeBase64Url(parts[2]!);

    const keyBuffer = Buffer.from(keyHex, "hex");

    const decipher = crypto.createDecipheriv("aes-256-gcm", keyBuffer, iv);
    decipher.setAuthTag(tag);

    let decrypted = decipher.update(ciphertext);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return JSON.parse(decrypted.toString("utf8"));
  } catch (err: any) {
    console.error("[PEACHIFY] Decryption failed:", err.message);
    return null;
  }
}

export class PeachifyScraper {
  private static UA =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";

  private static makeHeaders() {
    return {
      Origin: "https://peachify.pro",
      Referer: "https://peachify.pro/",
      "User-Agent": this.UA,
    };
  }

  public static async getStream(params: {
    tmdbId: string;
    kind: "movie" | "tv";
    season?: number;
    episode?: number;
    proxyUrl?: string | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<MirrorStream[]> {
    const { tmdbId, kind, season = 1, episode = 1, signal } = params;

    console.log(`[PEACHIFY] Scraping streams for TMDB ${tmdbId} (${kind})`);

    // 1. Fetch Subtitles
    let subtitles: SubtitleStream[] = [];
    try {
      const subUrl =
        kind === "tv"
          ? `${BASE_SUB_API}/subs/tv/${tmdbId}/${season}/${episode}`
          : `${BASE_SUB_API}/subs/movie/${tmdbId}`;

      const res = await gotScraping.get(subUrl, {
        headers: this.makeHeaders(),
        responseType: "json",
        signal,
        timeout: { request: 5000 },
      });

      if (Array.isArray(res.body)) {
        subtitles = res.body
          .filter((s: any) => s.url)
          .map((s: any) => ({
            url: s.url,
            lang: s.language || s.display || "en",
            languageName: s.display || "English",
            source: "Peachify",
          }));
        console.log(
          `[PEACHIFY] Found ${subtitles.length} subtitles for TMDB ${tmdbId}`,
        );
      }
    } catch (err: any) {
      console.warn(
        `[PEACHIFY] Subtitle fetch failed for TMDB ${tmdbId}: ${err.message}`,
      );
    }

    // 2. Fetch Streams from parallel providers
    const scrapePromises = PROVIDERS.map(async (provider) => {
      let url =
        kind === "tv"
          ? `${BASE_STREAM_API}/${provider}/tv/${tmdbId}/${season}/${episode}`
          : `${BASE_STREAM_API}/${provider}/movie/${tmdbId}`;

      try {
        const res = await gotScraping.get(url, {
          headers: this.makeHeaders(),
          responseType: "json",
          signal,
          timeout: { request: 8000 },
        });

        const body = res.body as any;
        let data = body;

        if (body?.isEncrypted && body?.data) {
          data = await decryptAesGcm(body.data, KEY_HEX);
        }

        if (!data || !Array.isArray(data.sources)) {
          return [];
        }

        const providerStreams: MirrorStream[] = [];
        for (const src of data.sources) {
          if (!src.url) continue;

          // Normalize type/format
          const type =
            src.url.includes(".m3u8") || src.type?.includes("mpegurl")
              ? "hls"
              : "mp4";

          providerStreams.push({
            url: src.url,
            source: `Peachify (${provider.toUpperCase()})`,
            quality: src.quality ? `${src.quality}p` : "Auto",
            type,
            headers: src.headers || {},
            subtitles,
          });
        }

        return providerStreams;
      } catch (err: any) {
        console.warn(
          `[PEACHIFY] Failed to fetch server ${provider} for TMDB ${tmdbId}: ${err.message}`,
        );
        return [];
      }
    });

    const results = await Promise.all(scrapePromises);
    const validMirrors = results.flat();

    console.log(`[PEACHIFY] Resolved ${validMirrors.length} valid mirrors`);
    return validMirrors;
  }
}
