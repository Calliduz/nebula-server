import mongoose from 'mongoose';

const MetadataCacheSchema = new mongoose.Schema({
  tmdbId: { type: String, required: true },
  type: { type: String, enum: ['movie', 'tv'], default: 'movie' },

  // Stream data
  streamUrl: { type: String },
  streamExpiresAt: { type: Date },

  // Visual Metadata (Fanart)
  logoUrl: { type: String },
  backgroundUrl: { type: String },
  logoFetchedAt: { type: Date },
});

// Generic Metadata Cache (Logos & Backgrounds)
MetadataCacheSchema.index({ tmdbId: 1, type: 1 }, { unique: true });
export const MetadataCache = mongoose.model('MetadataCache', MetadataCacheSchema);

// Video Stream Cache (with season and episode support for TV Shows)
const StreamCacheSchema = new mongoose.Schema({
  tmdbId: { type: String, required: true },
  type: { type: String, enum: ['movie', 'tv'], default: 'movie' },
  season: { type: Number, default: 1 },
  episode: { type: Number, default: 1 },
  
  streamUrl: { type: String },
  source: { type: String },
  qualityTag: { type: String, default: 'UNKNOWN' },
  resolution: { type: String, default: 'UNKNOWN' },
  mirrors: { type: Array, default: [] }, // Array of { url, source, quality }
  subtitles: { type: Array, default: [] },
  streamExpiresAt: { type: Date },
});

StreamCacheSchema.index({ tmdbId: 1, type: 1, season: 1, episode: 1 }, { unique: true });
// TTL index: MongoDB automatically deletes expired stream docs when streamExpiresAt is reached.
// expireAfterSeconds: 0 means "delete exactly at the date stored in the field".
StreamCacheSchema.index({ streamExpiresAt: 1 }, { expireAfterSeconds: 0 });
export const StreamCache = mongoose.model('StreamCache', StreamCacheSchema);

// Permanent Subtitle Cache (Aggregated from Stremio, Subscene, etc.)
const SubtitleCacheSchema = new mongoose.Schema({
  tmdbId: { type: String, required: true },
  type: { type: String, enum: ['movie', 'tv'], default: 'movie' },
  season: { type: Number, default: 1 },
  episode: { type: Number, default: 1 },
  
  subtitles: { type: Array, default: [] }, // Array of { id, url, lang, languageName }
  aggregatedAt: { type: Date, default: Date.now }
});

SubtitleCacheSchema.index({ tmdbId: 1, type: 1, season: 1, episode: 1 }, { unique: true });
export const SubtitleCache = mongoose.model('SubtitleCache', SubtitleCacheSchema);

// Discovery Cache (Stores KissKH Explore results)
const DiscoveryCacheSchema = new mongoose.Schema({
  key: { type: String, required: true }, // e.g. "discover-8-0-1" (country-type-page)
  results: { type: Array, default: [] },
  expiresAt: { type: Date, required: true }
});

DiscoveryCacheSchema.index({ key: 1 }, { unique: true });
DiscoveryCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const DiscoveryCache = mongoose.model('DiscoveryCache', DiscoveryCacheSchema);

// Drama Detail Cache (Stores episode lists and metadata)
const DramaDetailCacheSchema = new mongoose.Schema({
  dramaId: { type: Number, required: true },
  detail: { type: Object, required: true },
  expiresAt: { type: Date, required: true }
});

DramaDetailCacheSchema.index({ dramaId: 1 }, { unique: true });
DramaDetailCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const DramaDetailCache = mongoose.model('DramaDetailCache', DramaDetailCacheSchema);
