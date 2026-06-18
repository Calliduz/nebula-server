# Filmu API Analysis & Viability Report

This document details the reverse-engineered API paths, authentication patterns, and stream playability validation results for the scrapers used by the `embed.filmu.in` player.

---

## 1. Summary of Scraper Viability

Through direct backend inspection and validation, we successfully bypassed browser-level anti-debugging/anti-puppeteer guards (which force headless browsers to `about:blank`) by querying the backend servers directly with correct headers. Below is the functionality matrix of the scrapers:

| Scraper / Provider              | Domain / Endpoint Prefix           | Status             | Verification Result                                      | Playability Status                                           |
| :------------------------------ | :--------------------------------- | :----------------- | :------------------------------------------------------- | :----------------------------------------------------------- |
| **Kuro Anime** (anichi-sub/dub) | `https://anime2.filmu.in`          | **Functional**     | Search -> Meta -> Stream flow works.                     | **200 OK** (both direct mewstream and proxied streams).      |
| **Mikazuki** (megaplay)         | `https://hianime.filmu.in`         | **Viable**         | MAL ID megaplay stream resolution works.                 | **Variable** (subject to strict CDN client IP/Origin locks). |
| **Vortex** (RiveStream)         | `https://rive.filmu.in`            | **Functional**     | Requires `imdbId` and `tmdbId` query parameters.         | **200 OK** (AsiaCloud and kkphimplayer m3u8 streams).        |
| **Zenith** (Vaplayer)           | `https://box.filmu.in`             | **Functional**     | showbox-proxy retrieves encrypted m3u8 streams.          | **200 OK** (when proxied via `box.filmu.in/proxy/m3u8`).     |
| **Aura** (VidRock Nova)         | `https://embed.filmu.in/api/proxy` | **Functional**     | Resolves multi-CDN stream sources.                       | **200 OK** (Orion m3u8 streams).                             |
| **Nexus** (VegaMovies)          | `https://box.filmu.in`             | **Empty/Inactive** | Bollywood streams return empty arrays.                   | N/A                                                          |
| **Atlas** (Peachify)            | `https://embed.filmu.in/api/proxy` | **Expired**        | Stream links contain short-lived BunnyCDN secure tokens. | **403 Expired** (on raw dreadnought/bunny links).            |

---

## 2. API Endpoint Reference

### A. Kuro Anime Scraper

Kuro requires an API token generated per session to make requests to search, meta, and stream endpoints.

- **Generate Session Token:**
  - **Method:** `POST`
  - **URL:** `https://anime2.filmu.in/token`
  - **Headers:**
    ```json
    {
      "User-Agent": "Mozilla/5.0 ...",
      "Origin": "https://embed.filmu.in",
      "Referer": "https://embed.filmu.in/"
    }
    ```
  - **Response:** `{ "token": "eyJhbGciOiJIUzI..." }`

- **Search Anime:**
  - **Method:** `GET`
  - **URL:** `https://anime2.filmu.in/search?q={query}`
  - **Headers:** `x-api-key: {token}`

- **Get Metadata / Episode List:**
  - **Method:** `GET`
  - **URL:** `https://anime2.filmu.in/meta?id={animeId}`
  - **Headers:** `x-api-key: {token}`
  - **Response:** Includes an `episodes` map containing `sub` and `dub` items. Each episode contains a base64-encoded `dataStr` string.

- **Get Stream URLs:**
  - **Method:** `GET`
  - **URL:** `https://anime2.filmu.in/streams?data={encoded_dataStr}`
  - **Headers:** `x-api-key: {token}`
  - **Response:** Returns direct `.m3u8` URLs and `proxyUrl` paths.
  - **Playability Note:** The `proxyUrl` must be appended with `&apiKey={token}`. The direct URL requires `Referer: https://megaplay.buzz/`.

---

### B. Mikazuki Anime Scraper

Mikazuki relies on MyAnimeList IDs and episode numbers to resolve streams from `HiAnime [MegaPlay]`.

- **Generate Session Token:**
  - **Method:** `POST`
  - **URL:** `https://hianime.filmu.in/token`
  - **Response:** `{ "token": "eyJhbGci..." }`

- **Get Streams:**
  - **Method:** `GET`
  - **URL:** `https://hianime.filmu.in/hianime/megaplay?malId={malId}&ep={episode}&type={sub|dub}`
  - **Headers:** `x-api-key: {token}`

---

### C. Vortex (RiveStream Scraper)

Vortex resolves stream endpoints using IMDb or TMDB movie identifiers.

- **Get Streams:**
  - **Method:** `GET`
  - **URL:** `https://rive.filmu.in/scrape/rivestream/movie/{imdbId}?title={title}&year={year}&tmdbId={tmdbId}&imdbId={imdbId}&apikey=filmu_moviebox_key_v1`
  - **Query Constraints:** If both `imdbId` and `tmdbId` are not supplied in the query string, the endpoint returns a `404 Extractor not found or missing required IDs` error.
  - **Headers:**
    ```json
    {
      "User-Agent": "Mozilla/5.0 ...",
      "Origin": "https://embed.filmu.in",
      "Referer": "https://embed.filmu.in/"
    }
    ```

---

### D. Zenith (Vaplayer Scraper)

Zenith proxies requests to `box.filmu.in` through the embed proxy.

- **Get Streams:**
  - **Method:** `GET`
  - **URL:** `https://embed.filmu.in/api/showbox-proxy?path={encodedPath}`
  - **Encoded Path Example:** `/scrape/Vaplayer/movie/550?title=Fight Club&year=1999&tmdbId=550` (URI encoded).
  - **Playability Route:** The response returns HLS URLs pointing to `https://wormhole.filmu.in/proxy/m3u8?url=...`. Clients must replace `wormhole.filmu.in` with `box.filmu.in` to bypass the stricter origin gate, resulting in `200 OK` responses.

---

## 3. Verification Details

Validation was performed via Node.js scripts directly in the `/scratch` directory:

1.  **Direct API Requests:** [test_filmu_api.ts](file:///c:/Users/chuchi/Desktop/Repositories/nebula/nebula-server/scratch/test_filmu_api.ts) was executed to fetch the data.
2.  **Playability Assertions:** For each successful stream output, a partial content fetch was performed to confirm the playlist structure (`#EXTM3U` and `#EXT-X-STREAM-INF`) loads properly without returning 403 or 502 errors.
