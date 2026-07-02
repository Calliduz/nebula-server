import mongoose from "mongoose";

const MetadataCacheSchema = new mongoose.Schema({
  tmdbId: { type: String, required: true },
  type: { type: String, enum: ["movie", "tv"], default: "movie" },

  // External IDs
  imdbId: { type: String },

  // Stream data
  streamUrl: { type: String },
  streamExpiresAt: { type: Date },

  // Visual Metadata (Fanart)
  logoUrl: { type: String },
  backgroundUrl: { type: String },
  logoFetchedAt: { type: Date },

  // TTL field: new documents receive a 30-day expiry so stale art is eventually
  // cleaned up. Existing documents without this field are ignored by the reaper.
  expiresAt: { type: Date },
});

// Generic Metadata Cache (Logos & Backgrounds)
MetadataCacheSchema.index({ tmdbId: 1, type: 1 }, { unique: true });
// TTL index — deletes documents exactly when expiresAt is reached.
// expireAfterSeconds: 0 = "delete at the stored date, no additional delay".
MetadataCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const MetadataCache = mongoose.model(
  "MetadataCache",
  MetadataCacheSchema,
);

// Video Stream Cache (with season and episode support for TV Shows)
const StreamCacheSchema = new mongoose.Schema({
  tmdbId: { type: String, required: true },
  type: { type: String, enum: ["movie", "tv"], default: "movie" },
  season: { type: Number, default: 1 },
  episode: { type: Number, default: 1 },

  streamUrl: { type: String },
  source: { type: String },
  qualityTag: { type: String, default: "UNKNOWN" },
  resolution: { type: String, default: "UNKNOWN" },
  mirrors: { type: Array, default: [] }, // Array of { url, source, quality }
  subtitles: { type: Array, default: [] },

  // URL freshness: stream URLs expire in 4-6h (CDN-side).
  // The code checks this field before serving a cached URL.
  streamExpiresAt: { type: Date },

  // Document lifetime: 14 days. Keeps the document alive so the
  // "Verified" badge on movie cards persists long after the URL expires.
  // When a user re-plays the movie, a fresh scrape runs but the badge stays.
  expiresAt: { type: Date },
});

StreamCacheSchema.index(
  { tmdbId: 1, type: 1, season: 1, episode: 1 },
  { unique: true },
);
// TTL index on expiresAt (14 days) — NOT streamExpiresAt (4-6h).
// The document stays for 2 weeks so /api/stream/availability reports isVerified=true.
StreamCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const StreamCache = mongoose.model("StreamCache", StreamCacheSchema);

// Subtitle Cache (Aggregated from Stremio, Subscene, etc. — 90-day TTL)
const SubtitleCacheSchema = new mongoose.Schema({
  tmdbId: { type: String, required: true },
  type: { type: String, enum: ["movie", "tv"], default: "movie" },
  season: { type: Number, default: 1 },
  episode: { type: Number, default: 1 },

  subtitles: { type: Array, default: [] }, // Array of { id, url, lang, languageName }
  aggregatedAt: { type: Date, default: Date.now },

  // TTL field: new documents receive a 90-day expiry for eventual cleanup.
  // Existing documents without this field are safely ignored by the reaper.
  expiresAt: { type: Date },
});

SubtitleCacheSchema.index(
  { tmdbId: 1, type: 1, season: 1, episode: 1 },
  { unique: true },
);
// TTL index — deletes documents exactly when expiresAt is reached.
SubtitleCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const SubtitleCache = mongoose.model(
  "SubtitleCache",
  SubtitleCacheSchema,
);

// Discovery Cache (Stores KissKH Explore results)
const DiscoveryCacheSchema = new mongoose.Schema({
  key: { type: String, required: true }, // e.g. "discover-8-0-1" (country-type-page)
  results: { type: Array, default: [] },
  expiresAt: { type: Date, required: true },
});

DiscoveryCacheSchema.index({ key: 1 }, { unique: true });
DiscoveryCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const DiscoveryCache = mongoose.model(
  "DiscoveryCache",
  DiscoveryCacheSchema,
);

// Drama Detail Cache (Stores episode lists and metadata)
const DramaDetailCacheSchema = new mongoose.Schema({
  dramaId: { type: String, required: true },
  detail: { type: Object, required: true },
  expiresAt: { type: Date, required: true },
});

DramaDetailCacheSchema.index({ dramaId: 1 }, { unique: true });
DramaDetailCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const DramaDetailCache = mongoose.model(
  "DramaDetailCache",
  DramaDetailCacheSchema,
);

// DeadPool Cache (Stores movies/episodes that are currently unreachable)
const DeadPoolSchema = new mongoose.Schema({
  tmdbId: { type: String, required: true },
  type: { type: String, enum: ["movie", "tv"], default: "movie" },
  season: { type: Number, default: 1 },
  episode: { type: Number, default: 1 },
  lastChecked: { type: Date, default: Date.now },
  expiresAt: { type: Date, required: true },
});

DeadPoolSchema.index(
  { tmdbId: 1, type: 1, season: 1, episode: 1 },
  { unique: true },
);
DeadPoolSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const DeadPool = mongoose.model("DeadPool", DeadPoolSchema);

// TMDB Cache (Stores generic TMDB proxy response payloads)
const TmdbCacheSchema = new mongoose.Schema({
  key: { type: String, required: true },
  data: { type: mongoose.Schema.Types.Mixed, required: true },
  expiresAt: { type: Date, required: true },
});

TmdbCacheSchema.index({ key: 1 }, { unique: true });
TmdbCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const TmdbCache = mongoose.model("TmdbCache", TmdbCacheSchema);

// Failed Provider Cache (for caching 404/500 scraper failures)
const FailedProviderSchema = new mongoose.Schema({
  tmdbId: { type: String, required: true },
  type: { type: String, enum: ["movie", "tv"], default: "movie" },
  season: { type: Number, default: 1 },
  episode: { type: Number, default: 1 },
  provider: { type: String, required: true }, // e.g. "Neon", "Sage", etc.
  scraperName: { type: String, required: true }, // e.g. "videasy", etc.
  errorCode: { type: Number },
  expiresAt: { type: Date, required: true },
});

FailedProviderSchema.index(
  { tmdbId: 1, type: 1, season: 1, episode: 1, provider: 1, scraperName: 1 },
  { unique: true },
);
FailedProviderSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const FailedProvider = mongoose.model(
  "FailedProvider",
  FailedProviderSchema,
);
