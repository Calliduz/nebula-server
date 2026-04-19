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

// Compound unique index so movie:12345 and tv:12345 are distinct records
MetadataCacheSchema.index({ tmdbId: 1, type: 1 }, { unique: true });

export const MetadataCache = mongoose.model('MetadataCache', MetadataCacheSchema);
