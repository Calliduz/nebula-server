import axios from "axios";

// Fetch external IMDB id using TMDB id
export async function fetchImdbId(
  tmdbId: string | number,
  type: "movie" | "tv",
): Promise<string | null> {
  const TMDB_API_KEY = process.env.TMDB_API_KEY;
  if (!TMDB_API_KEY) return null;

  try {
    const url = `https://api.themoviedb.org/3/${type}/${tmdbId}/external_ids?api_key=${TMDB_API_KEY}`;
    const response = await axios.get(url, { timeout: 5000 });
    return response.data.imdb_id || null;
  } catch (error) {
    console.error(`[SUBS] Failed to fetch IMDB id for ${tmdbId}`);
    return null;
  }
}

// Fetch subtitles via Stremio
export async function getSubtitles(
  tmdbId: string | number,
  type: "movie" | "tv",
  season?: number,
  episode?: number,
) {
  const imdbId = await fetchImdbId(tmdbId, type);
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
    
    // Map the Stremio response to a clean payload
    return subs.map((sub: any) => ({
      id: sub.id,
      url: sub.url,
      lang: sub.lang, // ISO string e.g. "eng", "fre"
      languageName: getLanguageName(sub.lang),
    }));
  } catch (error) {
    console.error(`[SUBS] Failed to fetch subtitles for ${imdbId}`);
    return [];
  }
}

function getLanguageName(iso: string) {
  const map: Record<string, string> = {
    eng: "English",
    fre: "French",
    spa: "Spanish",
    ger: "German",
    ita: "Italian",
    por: "Portuguese",
    rus: "Russian",
    chi: "Chinese",
    jpn: "Japanese",
    kor: "Korean",
    ara: "Arabic",
    hin: "Hindi",
    pol: "Polish",
    tur: "Turkish",
    dut: "Dutch",
    swe: "Swedish",
    dan: "Danish",
    fin: "Finnish",
    nor: "Norwegian",
    cze: "Czech",
    gre: "Greek",
    hun: "Hungarian",
    rum: "Romanian",
    bul: "Bulgarian",
    srp: "Serbian",
    hrv: "Croatian",
    slv: "Slovenian",
    slk: "Slovak",
    ukr: "Ukrainian",
    tha: "Thai",
    vie: "Vietnamese",
    ind: "Indonesian",
    msa: "Malay",
    tgl: "Tagalog",
    heb: "Hebrew",
    fas: "Persian",
    urd: "Urdu",
  };
  return map[iso.toLowerCase()] || iso;
}
