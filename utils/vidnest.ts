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
    const providers = [
      "hollymoviehd",
      "vidxyz",
      "klikxxi",
      "moviesapi",
      "allmovies",
      "vidlink",
      "movies5f",
      "moviebox",
      "videasy",
    ];

    const subUrl =
      kind === "movie"
        ? `https://sub.vdrk.site/v2/movie/${tmdbId}`
        : `https://sub.vdrk.site/v2/tv/${tmdbId}/${season}/${episode}`;

    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36",
      Origin: "https://vidnest.fun",
      Referer: "https://vidnest.fun/",
      accept: "*/*",
      "accept-language": "en-US,en;q=0.8",
      "sec-ch-ua": '"Not;A=Brand";v="8", "Chromium";v="150", "Brave";v="150"',
      "sec-ch-ua-mobile": "?1",
      "sec-ch-ua-platform": '"Android"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-site",
      "sec-gpc": "1",
    };

    const gotOptions: any = {
      headers,
      responseType: "json",
      timeout: { request: 15000 },
    };
    if (proxyUrl) gotOptions.proxyUrl = proxyUrl;
    if (signal) gotOptions.signal = signal;

    // Fetch subtitles and provider streams in parallel
    const subsPromise = gotScraping.get(subUrl, gotOptions).catch(() => null);
    const streamPromises = providers.map((provider) => {
      const streamUrl =
        kind === "movie"
          ? `${baseUrl}/${provider}/movie/${tmdbId}`
          : `${baseUrl}/${provider}/${kind}/${tmdbId}/${season}/${episode}`;
      return gotScraping.get(streamUrl, gotOptions).catch((err) => {
        console.warn(
          `[Vidnest Scraper] Provider ${provider} fetch failed:`,
          err.message,
        );
        return null;
      });
    });

    const [subsRes, ...streamsRes] = await Promise.all([
      subsPromise,
      ...streamPromises,
    ]);

    // Parse subtitles if successful
    let subtitles: SubtitleStream[] = [];
    if (subsRes) {
      const subsPayload = subsRes.body as any;
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
          .filter((s: any) => (s.url || s.file) && (s.lang || s.label))
          .map((s: any) => ({
            url: s.file || s.url,
            lang: s.label || s.lang,
            languageName: s.label || s.lang,
            source: "Vidnest",
          }));
      }
    }

    const workerPool = [
      "https://dawn-dream-9823.vidness-1.workers.dev",
      "https://yellow-band-0602.vidnestt.workers.dev",
      "https://restless-dew-1ec6.vidnests22-e71.workers.dev",
      "https://patient-flower-33aa.vidnest-4.workers.dev",
    ];

    const allStreams: MirrorStream[] = [];

    streamsRes.forEach((res, idx) => {
      if (!res) {
        console.log(
          `[VIDNEST] ❌ ${providers[idx]} — no response (fetch failed)`,
        );
        return;
      }
      const provider = providers[idx]!;
      const streamPayload = res.body as any;
      let streamData = streamPayload;

      if (streamPayload?.encrypted && streamPayload?.data) {
        try {
          const decryptedStr = decodeVidnest(streamPayload.data);
          streamData = JSON.parse(decryptedStr);
        } catch (err: any) {
          console.warn(
            `[Vidnest Scraper] Failed to decrypt/parse ${provider} streams:`,
            err.message,
          );
          return;
        }
      }

      type NormEntry = {
        link: string;
        resolution: string;
        type: "mp4" | "hls";
        headers?: Record<string, string>;
      };
      const normalised: NormEntry[] = [];

      // Helper to infer stream type
      const detectType = (urlStr: string, rawType?: string): "mp4" | "hls" => {
        if (
          urlStr.includes(".m3u8") ||
          urlStr.includes("/hls") ||
          urlStr.includes("master.m3u8")
        )
          return "hls";
        if (rawType === "direct" && urlStr.includes(".mp4")) return "mp4";
        if (rawType === "mp4") return "mp4";
        if (rawType === "hls") return "hls";
        return urlStr.includes(".mp4") ? "mp4" : "hls";
      };

      // Schema A — moviebox: url is an array of objects with { link }
      if (Array.isArray(streamData?.url)) {
        for (const u of streamData.url as any[]) {
          if (u?.link) {
            normalised.push({
              link: u.link,
              resolution: u.resolution || u.lang || "Auto",
              type: detectType(u.link, u.type),
              headers: u.headers,
            });
          }
        }
      }

      // Schema B — allmovies / hollymoviehd / moviesapi: { streams: [...] }
      if (Array.isArray(streamData?.streams)) {
        for (const s of streamData.streams as any[]) {
          if (s?.url) {
            normalised.push({
              link: s.url,
              resolution: s.quality || s.language || "Auto",
              type: detectType(s.url, s.type),
              headers: s.headers,
            });
          }
        }
      }

      // Schema C — movies5f: { code, data: { medias: [...], downloads: [...] } }
      const c5fMedias = streamData?.data?.medias;
      if (Array.isArray(c5fMedias)) {
        for (const m of c5fMedias as any[]) {
          if (m?.mediaUrl) {
            normalised.push({
              link: m.mediaUrl,
              resolution: m.definition || "Auto",
              type: detectType(m.mediaUrl, "mp4"),
              headers: m.headers,
            });
          }
        }
      }
      const c5fDownloads = streamData?.data?.downloads;
      if (Array.isArray(c5fDownloads)) {
        for (const d of c5fDownloads as any[]) {
          if (d?.url) {
            normalised.push({
              link: d.url,
              resolution: d.resolution ? `${d.resolution}p` : "Auto",
              type: detectType(d.url, "mp4"),
              headers: d.headers,
            });
          }
        }
      }

      // Schema D — klikxxi / vidxyz: { sources: [{url, quality, type}], title, ... }
      if (Array.isArray(streamData?.sources)) {
        for (const s of streamData.sources as any[]) {
          if (s?.url) {
            normalised.push({
              link: s.url,
              resolution: s.quality || "Auto",
              type: detectType(s.url, s.type),
              headers: s.headers,
            });
          }
        }
      }

      // Schema E — videasy: { url: "<string>", headers: {...} }
      if (
        typeof streamData?.url === "string" &&
        streamData.url.startsWith("http")
      ) {
        normalised.push({
          link: streamData.url,
          resolution: "Auto",
          type: detectType(streamData.url, "hls"),
          headers: streamData.headers,
        });
      }

      // Schema F — vidlink: { data: { stream: { playlist, qualities, captions } }, headers, provider }
      const vlStream = streamData?.data?.stream;
      if (vlStream) {
        const playlist = vlStream?.playlist;
        if (typeof playlist === "string" && playlist.startsWith("http")) {
          normalised.push({
            link: playlist,
            resolution: "Auto",
            type: detectType(playlist, "hls"),
            headers: streamData.headers || vlStream.headers,
          });
        }
        if (vlStream?.qualities && typeof vlStream.qualities === "object") {
          for (const [res, q] of Object.entries(vlStream.qualities)) {
            const url = (q as any)?.url;
            if (typeof url === "string" && url.startsWith("http")) {
              normalised.push({
                link: url,
                resolution: `${res}p`,
                type: detectType(url, (q as any)?.type),
                headers: streamData.headers || (q as any)?.headers,
              });
            }
          }
        }
        if (Array.isArray(vlStream?.sources)) {
          for (const s of vlStream.sources as any[]) {
            if (s?.url) {
              normalised.push({
                link: s.url,
                resolution: s.quality || "Auto",
                type: detectType(s.url, s.type),
                headers: s.headers,
              });
            }
          }
        }
      }

      // Prioritize direct IP streams (e.g. 185.237.x.x, 203.188.x.x) over Cloudflare .txt manifests
      normalised.sort((a, b) => {
        const aIp = /https?:\/\/\d+\.\d+\.\d+\.\d+/.test(a.link);
        const bIp = /https?:\/\/\d+\.\d+\.\d+\.\d+/.test(b.link);
        if (aIp && !bIp) return -1;
        if (!aIp && bIp) return 1;
        const aTxt = a.link.includes(".txt") || a.link.includes("cf-master");
        const bTxt = b.link.includes(".txt") || b.link.includes("cf-master");
        if (aTxt && !bTxt) return 1;
        if (!aTxt && bTxt) return -1;
        return 0;
      });

      const providerNameMapped =
        provider === "moviebox"
          ? "MovieBox"
          : provider === "allmovies"
            ? "AllMovies"
            : provider === "klikxxi"
              ? "KlikXXI"
              : provider === "hollymoviehd"
                ? "HollyMovieHD"
                : provider === "moviesapi"
                  ? "MoviesAPI"
                  : provider === "videasy"
                    ? "Videasy"
                    : provider === "vidlink"
                      ? "VidLink"
                      : provider === "movies5f"
                        ? "Movies5F"
                        : provider === "vidxyz"
                          ? "VidXYZ"
                          : provider;

      if (normalised.length === 0) {
        console.log(`[VIDNEST] ❌ ${providerNameMapped} — no streams found`);
        return;
      }

      console.log(
        `[VIDNEST] ✅ ${providerNameMapped} — found ${normalised.length} streams`,
      );

      normalised.forEach((u) => {
        let link = u.link;

        // 1. Unwrap dead Cloudflare Workers (workers.dev/mp4-proxy?url=) to extract real target URL
        if (link.includes("workers.dev/mp4-proxy?url=")) {
          const parts = link.split("workers.dev/mp4-proxy?url=");
          if (parts[1]) {
            try {
              const decoded = decodeURIComponent(parts[1]);
              if (decoded.startsWith("http")) link = decoded;
            } catch {}
          }
        }

        // 2. If hakunaymatata.com without proxy, attach megacloud proxy with vidrock referer
        if (
          link.includes("hakunaymatata.com") &&
          !link.includes("animanga.fun/proxy")
        ) {
          const params = new URLSearchParams({
            Referer: "https://vidrock.ru/",
          });
          link = `https://megacloud.animanga.fun/proxy?url=${encodeURIComponent(link)}&headers=${encodeURIComponent(params.toString())}`;
        } else if (
          u.headers &&
          typeof u.headers === "object" &&
          Object.keys(u.headers).length > 0
        ) {
          const params = new URLSearchParams();
          for (const [k, v] of Object.entries(u.headers)) {
            params.append(k, String(v));
          }
          link = `https://megacloud.animanga.fun/proxy?url=${encodeURIComponent(link)}&headers=${encodeURIComponent(params.toString())}`;
        }

        const sourceSuffix =
          providerNameMapped === "MovieBox" ? "" : ` - ${providerNameMapped}`;
        allStreams.push({
          url: link,
          source: `Vidnest${sourceSuffix} (${u.resolution})`,
          quality: u.resolution,
          type: u.type,
          subtitles: subtitles,
        });
      });
    });

    // Deduplicate by URL — some providers return identical links multiple times
    const seen = new Set<string>();
    const deduped = allStreams.filter((m) => {
      if (seen.has(m.url)) return false;
      seen.add(m.url);
      return true;
    });

    console.log(
      `[VIDNEST] Completed scan for ${tmdbId} S${season}E${episode}. Found ${deduped.length} unique mirrors.`,
    );
    return deduped;
  }
}
