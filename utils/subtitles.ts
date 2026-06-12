import axios from "axios";
import { MetadataCache } from "../models/Cache.js";

// Fetch external IMDB id using TMDB id
export async function fetchImdbId(
  tmdbId: string | number,
  type: "movie" | "tv",
  title?: string,
): Promise<string | null> {
  const TMDB_API_KEY = process.env.TMDB_API_KEY;
  if (!TMDB_API_KEY) return null;

  let finalTmdbId = tmdbId.toString();

  // 1. Check local cache first
  const cached = await MetadataCache.findOne({ tmdbId: finalTmdbId });
  if (cached?.imdbId) return cached.imdbId;

  try {
    const isV4 = TMDB_API_KEY.length > 40;
    const url = `https://api.themoviedb.org/3/${type}/${finalTmdbId}/external_ids${isV4 ? "" : `?api_key=${TMDB_API_KEY}`}`;

    const response = await axios.get(url, {
      timeout: 5000,
      headers: isV4 ? { Authorization: `Bearer ${TMDB_API_KEY}` } : {},
    });

    const imdbId = response.data.imdb_id || null;

    // 2. Persist to cache for future requests
    if (imdbId) {
      await MetadataCache.findOneAndUpdate(
        { tmdbId: finalTmdbId },
        { imdbId },
        { upsert: true },
      ).catch(() => {});
    }

    return imdbId;
  } catch (error: any) {
    console.error(
      `[SUBS] Failed to fetch IMDB id for ${finalTmdbId}: ${error.message}`,
    );
    return null;
  }
}

// Fetch subtitles via Stremio
export async function getSubtitles(
  tmdbId: string | number,
  type: "movie" | "tv",
  season?: number,
  episode?: number,
  title?: string,
) {
  const imdbId = await fetchImdbId(tmdbId, type, title);
  if (!imdbId) return [];

  let url = "";
  if (type === "movie") {
    url = `https://opensubtitles-v3.strem.io/subtitles/movie/${imdbId}.json`;
  } else {
    url = `https://opensubtitles-v3.strem.io/subtitles/series/${imdbId}:${season || 1}:${episode || 1}.json`;
  }

  try {
    const response = await axios.get(url, { timeout: 8000 });
    const subs = response.data?.subtitles || [];

    // Group by language to keep multiple options (especially for sync issues)
    const langGroups: Record<string, any[]> = {};
    for (const sub of subs) {
      const lang = sub.lang || "unk";
      if (!langGroups[lang]) langGroups[lang] = [];
      // Keep up to 5 subtitles per language to give users choices if one is out of sync
      if (langGroups[lang].length < 5) {
        langGroups[lang].push(sub);
      }
    }

    const dedupedSubs = Object.values(langGroups).flat();

    // Map the Stremio response to a clean payload
    return dedupedSubs.map((sub: any, index: number) => ({
      id: sub.id || `${sub.lang}-${index}`,
      url: sub.url,
      lang: sub.lang, // ISO string e.g. "eng", "fre"
      languageName: getLanguageName(sub.lang),
      source: "OpenSubtitles",
    }));
  } catch (error) {
    console.error(`[SUBS] Failed to fetch subtitles for ${imdbId}`);
    return [];
  }
}

export function getLanguageName(iso: string) {
  const key = iso.toLowerCase().trim().substring(0, 3);
  const map: Record<string, string> = {
    eng: "English",
    en: "English",
    fre: "French",
    fra: "French",
    spa: "Spanish",
    esp: "Spanish",
    ger: "German",
    deu: "German",
    ita: "Italian",
    por: "Portuguese",
    rus: "Russian",
    chi: "Chinese",
    zho: "Chinese",
    jpn: "Japanese",
    nld: "Dutch",
    dut: "Dutch",
    nl: "Dutch",
    kor: "Korean",
    ara: "Arabic",
    tur: "Turkish",
    pol: "Polish",
    swe: "Swedish",
    dan: "Danish",
    fin: "Finnish",
    nor: "Norwegian",
    ind: "Indonesian",
    vie: "Vietnamese",
    tha: "Thai",
    hin: "Hindi",
    ben: "Bengali",
    pun: "Punjabi",
    per: "Persian",
    fas: "Persian",
    heb: "Hebrew",
    gre: "Greek",
    ell: "Greek",
    cze: "Czech",
    ces: "Czech",
    hun: "Hungarian",
    rum: "Romanian",
    ron: "Romanian",
    bul: "Bulgarian",
    hrv: "Croatian",
    srp: "Serbian",
    slo: "Slovak",
    slk: "Slovak",
    slv: "Slovenian",
    est: "Estonian",
    lav: "Latvian",
    lit: "Lithuanian",
    ukr: "Ukrainian",
    pob: "Portuguese (BR)",
    "pt-br": "Portuguese (BR)",
    bra: "Portuguese (BR)",
    pt: "Portuguese",
  };
  return map[key] || map[iso.toLowerCase().substring(0, 2)] || iso;
}
