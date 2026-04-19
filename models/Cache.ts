import mongoose from 'mongoose';

const MetadataCacheSchema = new mongoose.Schema({
  tmdbId: { type: String, required: true, unique: true },
  
  // Stream data
  streamUrl: { type: String },
  streamExpiresAt: { type: Date },
  
  // Visual Metadata (Fanart)
  logoUrl: { type: String },
  logoFetchedAt: { type: Date },
});

export const MetadataCache = mongoose.model('MetadataCache', MetadataCacheSchema);
