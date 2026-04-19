import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { makeProviders, makeStandardFetcher, targets } from '@movie-web/providers';
import { MOVIES } from '@consumet/extensions';
import { MetadataCache } from './models/Cache';

// Load Environment Variables
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// Initialize MongoDB
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/nebula-local';
const FANART_API_KEY = process.env.FANART_API_KEY || '';

const connectDB = async (retryCount = 5) => {
  try {
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 10000,
    });
    console.log('MongoDB Uplink Established');
  } catch (err: any) {
    if (retryCount > 0) {
      console.warn(`[DB] Uplink Failed. Retrying in 5s... (${retryCount} left)`);
      setTimeout(() => connectDB(retryCount - 1), 5000);
    } else {
      console.error('[DB] Uplink Failed Permanently. Running in volatile mode.', err.message);
    }
  }
};

connectDB();

// Primary Scraper (@movie-web/providers)
const providers = makeProviders({
  fetcher: makeStandardFetcher(fetch),
  target: targets.ANY,
  consistentIpForRequests: true,
});

// Fallback Scraper (@consumet/extensions)
const flixhq = new MOVIES.FlixHQ();

// Endpoint: Fetch Media Stream
app.get('/api/stream', async (req, res) => {
  const tmdbId = req.query.tmdbId as string;
  const kind = req.query.type as 'movie' | 'tv'; 
  const title = (req.query.title as string) || '';
  const releaseYear = (req.query.releaseYear as string) || '';

  if (!tmdbId || !kind) {
    return res.status(400).json({ error: 'Missing tmdbId or type' });
  }

  try {
    // 1. Check Cache First
    const cachedRecord = await MetadataCache.findOne({ tmdbId }).catch(() => null);
    if (cachedRecord && cachedRecord.streamUrl && cachedRecord.streamExpiresAt) {
      if (new Date() < cachedRecord.streamExpiresAt) {
         console.log(`[STREAM] Cache HIT for ${tmdbId}`);
         return res.json({ streamUrl: cachedRecord.streamUrl, source: 'cache' });
      }
    }

    let extractedUrl: string | null = null;
    let sourceName = '';

    console.log(`[STREAM] Searching ${title} (${releaseYear}) using Primary Engine...`);
    
    // 2. Primary Engine
    try {
      const media = {
        type: kind,
        title: title,
        releaseYear: parseInt(releaseYear, 10),
        tmdbId: tmdbId
      };
      
      const searchResult = await providers.runAll({ media: media as any });
      if (searchResult && searchResult.stream) {
        if (searchResult.stream.type === 'hls') {
           extractedUrl = searchResult.stream.playlist;
           sourceName = searchResult.sourceId;
        }
      }
    } catch (e: any) {
      console.warn(`[STREAM] Primary Engine skipped: ${e.message}`);
    }

    // 3. Fallback Engine
    if (!extractedUrl && title) {
      console.log(`[STREAM] Searching ${title} using Fallback Engine...`);
      try {
        const fallbackSearch = await flixhq.search(title);
        if (fallbackSearch.results.length > 0) {
           const info = await flixhq.fetchMediaInfo(fallbackSearch.results[0].id);
           if (info.episodes && info.episodes.length > 0) {
             const stream = await flixhq.fetchEpisodeSources(info.episodes[0].id, info.id);
             if (stream && stream.sources.length > 0) {
               // Find highest quality or auto
               const bestSource = stream.sources.find((s: any) => s.quality === 'auto') || stream.sources[0];
               extractedUrl = bestSource.url;
               sourceName = 'FlixHQ (Fallback)';
             }
           }
        }
      } catch (e: any) {
        console.warn(`[STREAM] Fallback Engine skipped: ${e.message}`);
      }
    }

    if (extractedUrl) {
      // 4. Save to Cache (Expire in 4 hours)
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + 4);

      await MetadataCache.findOneAndUpdate(
        { tmdbId },
        { streamUrl: extractedUrl, streamExpiresAt: expiresAt },
        { upsert: true, returnDocument: 'after' }
      ).catch(() => null);

      return res.json({ streamUrl: extractedUrl, source: sourceName });
    }

    return res.status(404).json({ error: 'No stream sources found on primary or secondary engines.' });

  } catch (error: any) {
    console.error(`[STREAM ERROR] Critical failure handling ${tmdbId}:`, error);
    return res.status(500).json({ error: 'Scraper engine runtime error.', details: error.message });
  }
});

// Endpoint: Fetch Visual Metadata (Fanart Logos)
app.get('/api/metadata', async (req, res) => {
  const tmdbId = req.query.tmdbId as string;
  const isBatch = req.query.batch as string; 

  if (isBatch) {
     const ids = isBatch.split(',').filter(id => id.trim());
     const results = await Promise.all(ids.map(async (id) => {
       const res = await getFanartMetadata(id);
       return { id, ...res };
     }));
     return res.json({ results });
  }

  if (!tmdbId) return res.status(400).json({ error: 'Missing tmdbId' });

  try {
     const result = await getFanartMetadata(tmdbId);
     return res.json(result || { logoUrl: null, backgroundUrl: null });
  } catch (error: any) {
     console.error(`[METADATA ERROR] ${error.message}`);
     return res.status(500).json({ error: 'Failed to extract metadata' });
  }
});

// Endpoint: Image Proxy (Bypasses TMDB Blocks/CORS)
app.get('/api/image', async (req, res) => {
  const url = req.query.url as string;
  if (!url) return res.status(400).send('Missing url');

  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Proxy upstream error');
    const arrayBuffer = await response.arrayBuffer();
    
    // Pass along content type
    const contentType = response.headers.get('content-type');
    if (contentType) res.setHeader('Content-Type', contentType);
    
    // Add long caching
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    
    res.end(Buffer.from(arrayBuffer));
  } catch (e: any) {
    res.status(500).send('Image proxy failed');
  }
});

async function getFanartMetadata(tmdbId: string) {
  if (!FANART_API_KEY || FANART_API_KEY === 'your_fanart_api_key_here') {
    return { logoUrl: null, backgroundUrl: null }; // Disabled
  }

  // Check Cache
  const cached = await MetadataCache.findOne({ tmdbId }).catch(() => null);
  if (cached && cached.logoFetchedAt) { 
     return { logoUrl: cached.logoUrl, backgroundUrl: cached.backgroundUrl };
  }

  try {
    const raw = await fetch(`https://webservice.fanart.tv/v3/movies/${tmdbId}?api_key=${FANART_API_KEY}`);
    const data = await raw.json();

    let hdLogo = null;
    let backgroundUrl = null;

    if (data.hdmovieclearart && data.hdmovieclearart.length > 0) hdLogo = data.hdmovieclearart[0].url;
    else if (data.hdmovielogo && data.hdmovielogo.length > 0) hdLogo = data.hdmovielogo[0].url;
    else if (data.moviebrowser && data.moviebrowser.length > 0) hdLogo = data.moviebrowser[0].url;

    if (data.moviebackground && data.moviebackground.length > 0) backgroundUrl = data.moviebackground[0].url;

    // Save to Cache
    await MetadataCache.findOneAndUpdate(
      { tmdbId },
      { logoUrl: hdLogo, backgroundUrl, logoFetchedAt: new Date() },
      { upsert: true, returnDocument: 'after' }
    ).catch(() => null); 

    return { logoUrl: hdLogo, backgroundUrl };

  } catch (e: any) {
    if (e.message.includes('404')) {
        await MetadataCache.findOneAndUpdate(
          { tmdbId },
          { logoUrl: null, backgroundUrl: null, logoFetchedAt: new Date() },
          { upsert: true, returnDocument: 'after' }
        ).catch(() => null);
    }
    return { logoUrl: null, backgroundUrl: null };
  }
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Nebula Backend Array active on http://localhost:${PORT}`);
  console.log(`Modes: Fanart [${FANART_API_KEY === 'your_fanart_api_key_here' ? 'DISABLED' : 'ACTIVE'}], Scraper [ACTIVE]`);
});
