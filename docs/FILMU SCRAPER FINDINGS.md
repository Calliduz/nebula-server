# FilmU Source Integration Manual

This manual serves as the developer documentation for integrating `embed.filmu.in` and its associated scraper backends into the `nebula` application.

---

## 1. Global Setup & Connection Context

### A. General Request Headers

Almost all backend requests must include these headers to bypass basic CORS restrictions and origin gates:

```typescript
const BASE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
  Origin: "https://embed.filmu.in",
  Referer: "https://embed.filmu.in/",
};
```

### B. Global Security Keys

- **Orion Key (API Key for movie/tv scrapers):** `filmu_moviebox_key_v1`
- **Anime Key (Yuki/HiAnime/Kuro):** `6b7a8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b`

---

## 2. Scraper Endpoint Directory

### Source 1: FilmU Vortex (RiveStream & VideasyHD)

Vortex is a multi-CDN global scraper. If RiveStream fails to return links, it automatically falls back to VideasyHD.

- **Endpoint:** `https://rive.filmu.in/scrape/{provider}/{type}/{id}`
  - `{provider}`: `rivestream` or `VideasyHD`
  - `{type}`: `movie` or `tv`
  - `{id}`: IMDb ID (e.g. `tt0137523`) or fallback TMDB ID (e.g. `550`)
- **Required Query Parameters:**
  - `title`: URL-encoded title (e.g. `Fight%20Club`)
  - `year`: Release year (e.g. `1999`)
  - `tmdbId`: Numeric TMDB ID
  - `imdbId`: IMDb string
  - `apikey`: `filmu_moviebox_key_v1`
  - `season` (TV only): Season number
  - `episode` (TV only): Episode number
- **Example Request URL:**
  `https://rive.filmu.in/scrape/rivestream/movie/tt0137523?title=Fight%20Club&year=1999&tmdbId=550&imdbId=tt0137523&apikey=filmu_moviebox_key_v1`
- **Response Structure:**
  ```json
  {
    "sources": [
      {
        "name": "RiveStream • PrimeVids",
        "url": "https://silent-wildflower-8004.8-716.workers.dev/movie/...",
        "quality": "1080p",
        "type": "m3u8",
        "headers": { "Referer": "https://www.rivestream.app/" }
      }
    ],
    "subtitles": []
  }
  ```

---

### Source 2: Kuro Anime (anichi-sub / anichi-dub)

Kuro Anime resolves subbed/dubbed anime links from `all-wish.me` via the `anime2.filmu.in` backend.

1.  **Generate Session Token:**
    - **Method:** `POST`
    - **URL:** `https://anime2.filmu.in/token`
    - **Headers:** `BASE_HEADERS`
    - **Response:** `{ "token": "eyJhbGciOiJI..." }`

2.  **Search Anime:**
    - **Method:** `GET`
    - **URL:** `https://anime2.filmu.in/search?q={query}`
    - **Headers:** `x-api-key: {token}`
    - **Response:**
      ```json
      {
        "results": [
          {
            "id": "one-piece-odmau",
            "title": "One Piece",
            "url": "https://all-wish.me/watch/one-piece-odmau/ep-1",
            "hasSub": true,
            "hasDub": true
          }
        ]
      }
      ```

3.  **Get Episode Metadata:**
    - **Method:** `GET`
    - **URL:** `https://anime2.filmu.in/meta?id={animeId}`
    - **Headers:** `x-api-key: {token}`
    - **Response:**
      ```json
      {
        "episodes": {
          "sub": [
            {
              "number": 1,
              "dataStr": "sub|SURLazJ4RWpB..."
            }
          ]
        }
      }
      ```

4.  **Get Stream Playlists:**
    - **Method:** `GET`
    - **URL:** `https://anime2.filmu.in/streams?data={encoded_dataStr}`
    - **Headers:** `x-api-key: {token}`
    - **Response:**
      ```json
      {
        "streams": [
          {
            "url": "https://s1.streamzone1.site/anime/...",
            "type": "m3u8",
            "referer": "https://megaplay.buzz/",
            "proxyUrl": "/proxy/m3u8?url=..."
          }
        ]
      }
      ```
    - **Playback Routing:**
      If playing via the Kuro Proxy, append `&apiKey={token}` to the proxy URL (resulting in `https://anime2.filmu.in/proxy/m3u8?url=...&apiKey={token}`).
      If playing directly, send the request with headers:
      `{ "Referer": "https://megaplay.buzz/" }`.

---

### Source 3: Mikazuki & Hikari (hianime megaplay)

Mikazuki resolves multi-audio anime from `hianime.filmu.in`.

1.  **Generate Session Token:**
    - **Method:** `POST`
    - **URL:** `https://hianime.filmu.in/token`
    - **Response:** `{ "token": "..." }`

2.  **Search Anime:**
    - **Method:** `GET`
    - **URL:** `https://hianime.filmu.in/search?q={query}`
    - **Headers:** `x-api-key: {token}`

3.  **Get Streams:**
    - **Method:** `GET`
    - **URL:** `https://hianime.filmu.in/hianime/megaplay?malId={malId}&ep={episode}&type={sub|dub}`
    - **Headers:** `x-api-key: {token}`
    - **Response:**
      ```json
      {
        "streams": [
          {
            "server": "HiAnime [MegaPlay]",
            "url": "https://cdn.mewstream.buzz/anime/...",
            "type": "m3u8",
            "referer": "https://megaplay.buzz/",
            "proxyUrl": "/proxy/m3u8?url=..."
          }
        ]
      }
      ```
    - **Playback Routing:** The direct stream is hosted on Mewstream. Use `Referer: https://megaplay.buzz/`.

---

### Source 4: FilmU Zenith (Vaplayer & Videasy CDN)

Zenith proxies showbox-style scraper engines through the main `embed.filmu.in` proxy.

- **Get Streams:**
  - **Method:** `GET`
  - **URL:** `https://embed.filmu.in/api/showbox-proxy?path={encodedPath}`
  - **Path construction:**
    `/scrape/Vaplayer/{type}/{id}?title={title}&year={year}&tmdbId={tmdbId}`
    (or `/scrape/Videasy/...`)
  - **Example Path:**
    `https://embed.filmu.in/api/showbox-proxy?path=%2Fscrape%2FVaplayer%2Fmovie%2F550%3Ftitle%3DFight%20Club%26year%3D1999%26tmdbId%3D550`
- **Stream URL Extraction:**
  The response returns paths pointing to `https://wormhole.filmu.in/proxy/m3u8?url=...`.
  **CRITICAL INTEGRATION RULE:** You MUST replace `https://wormhole.filmu.in/proxy/` with `https://box.filmu.in/proxy/` in the client's player script to bypass connection gateways and allow `200 OK` playbacks.

---

### Source 5: FilmU Aura (VidRock Nova / Orion / Helios)

Aura is a scraper backend that resolves VidRock provider sources.

- **Get Streams:**
  - **Method:** `GET`
  - **URL:** `https://embed.filmu.in/api/proxy?path={encodedPath}`
  - **Path Construction:** `/scrape/VidRock/{type}/tmdb{tmdbId}?title={title}&year={year}&tmdbId={tmdbId}`
- **Playback Routing:**
  - **Orion Links:** Streamed directly via `https://orion.hydrostorm.workers.dev/...`. Add headers:
    `{ "Origin": "https://vidrock.ru", "Referer": "https://vidrock.ru/" }`.
  - **Atlas/Helios Direct MP4 Links:** Proxied via `https://wormhole.filmu.in/proxy/file?url=...`. Make sure to pass `Origin: https://embed.filmu.in` and `Referer: https://embed.filmu.in/` to the proxy endpoint.

---

## 3. Proxy Configurations & Routing Table

When integrating the source streams into the native HTML5 player or HLS wrapper, refer to this routing table:

| Host Pattern                           | Target Header Rule                         | Proxy Domain        |
| :------------------------------------- | :----------------------------------------- | :------------------ |
| `https://wormhole.filmu.in/proxy/m3u8` | Replace domain with `https://box.filmu.in` | `box.filmu.in`      |
| `https://wormhole.filmu.in/proxy/file` | Keep origin `https://embed.filmu.in`       | `wormhole.filmu.in` |
| `/proxy/m3u8` (Kuro)                   | Append `&apiKey={kuroToken}`               | `anime2.filmu.in`   |
| `*.workers.dev` (Orion)                | Set `Origin: https://vidrock.ru`           | Direct              |

---

## 4. Integration Blueprint (TypeScript)

Here is a clean blueprint template for integrating these scraper methods inside the `nebula` server layer:

```typescript
import axios from "axios";

export class FilmuScraper {
  private static readonly ORION_KEY = "filmu_moviebox_key_v1";
  private static readonly BASE_HEADERS = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36",
    Origin: "https://embed.filmu.in",
    Referer: "https://embed.filmu.in/",
  };

  /**
   * Scrapes Zenith Vaplayer sources
   */
  public async scrapeZenith(
    tmdbId: number,
    title: string,
    year: number,
    isMovie: boolean,
  ): Promise<any[]> {
    const type = isMovie ? "movie" : "tv";
    const scraperPath = `/scrape/Vaplayer/${type}/${tmdbId}?title=${encodeURIComponent(title)}&year=${year}&tmdbId=${tmdbId}`;
    const proxyUrl = `https://embed.filmu.in/api/showbox-proxy?path=${encodeURIComponent(scraperPath)}`;

    try {
      const response = await axios.get(proxyUrl, {
        headers: FilmuScraper.BASE_HEADERS,
      });
      const sources = response.data.sources || [];

      return sources.map((s: any) => {
        // Rewrite proxy host to avoid 403 blocks
        const playUrl = s.url
          ? s.url.replace(
              "https://wormhole.filmu.in/proxy/",
              "https://box.filmu.in/proxy/",
            )
          : "";
        return {
          name: s.name || "Zenith Vaplayer",
          url: playUrl,
          type: "application/x-mpegurl",
          quality: s.quality || "Auto",
        };
      });
    } catch (e: any) {
      console.error("[Filmu] Zenith scraping failed:", e.message);
      return [];
    }
  }

  /**
   * Scrapes Vortex RiveStream sources
   */
  public async scrapeVortex(
    imdbId: string,
    tmdbId: number,
    title: string,
    year: number,
    isMovie: boolean,
  ): Promise<any[]> {
    const type = isMovie ? "movie" : "tv";
    // Ensure all identifiers are present to bypass the 404 query checks
    const targetUrl = `https://rive.filmu.in/scrape/rivestream/${type}/${imdbId}?title=${encodeURIComponent(title)}&year=${year}&tmdbId=${tmdbId}&imdbId=${imdbId}&apikey=${FilmuScraper.ORION_KEY}`;

    try {
      const response = await axios.get(targetUrl, {
        headers: FilmuScraper.BASE_HEADERS,
      });
      const sources = response.data.sources || [];
      return sources.map((s: any) => ({
        name: s.name || "Vortex RiveStream",
        url: s.workerProxyUrl || s.url,
        type: s.type === "m3u8" ? "application/x-mpegurl" : "video/mp4",
        headers: s.headers || {},
      }));
    } catch (e: any) {
      console.error("[Filmu] Vortex scraping failed:", e.message);
      return [];
    }
  }
}
```
