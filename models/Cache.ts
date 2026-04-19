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
  subtitles: { type: Array, default: [] },
  streamExpiresAt: { type: Date },
});

StreamCacheSchema.index({ tmdbId: 1, type: 1, season: 1, episode: 1 }, { unique: true });
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
