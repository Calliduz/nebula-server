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
const TMDB_API_KEY = process.env.TMDB_API_KEY || '';

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
// Clear Cache (Admin/Dev)
app.post('/api/cache/clear', async (req, res) => {
  try {
    await MetadataCache.deleteMany({});
    console.log('Metadata Cache Flushed Successfully');
    res.json({ success: true, message: 'Registry cache cleared successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Cache flush failure' });
  }
});

app.get('/api/metadata', async (req, res) => {
  const tmdbId = req.query.tmdbId as string;
  const isBatch = req.query.batch as string; 
  const type = (req.query.type as any) || 'movie';

  console.log(`[METADATA REQUEST] Type: ${type}, ID: ${tmdbId || 'Batch: ' + isBatch}`);

  if (isBatch) {
     const combos = isBatch.split(',').filter(id => id.trim());
     const results = await Promise.all(combos.map(async (combo) => {
       const [id, type] = combo.split(':');
       const meta = await getFanartMetadata(id, (type as any) || 'movie');
       return { id, ...meta };
     }));
     return res.json({ results });
  }

  if (!tmdbId) return res.status(400).json({ error: 'Missing tmdbId' });

  try {
     const result = await getFanartMetadata(tmdbId, type);
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

async function getIMDBId(tmdbId: string) {
  try {
    const res = await fetch(`https://api.themoviedb.org/3/movie/${tmdbId}`, {
      headers: { 'Authorization': `Bearer ${TMDB_API_KEY}` }
    });
    const data = await res.json();
    return data.imdb_id;
  } catch (e) {
    return null;
  }
}

async function getTVDBId(tmdbId: string) {
  try {
    const res = await fetch(`https://api.themoviedb.org/3/tv/${tmdbId}/external_ids`, {
      headers: { 'Authorization': `Bearer ${TMDB_API_KEY}` }
    });
    const data = await res.json();
    return data.tvdb_id;
  } catch (e) {
    console.error(`[TVDB TRACE] Failed translation for ${tmdbId}`);
    return null;
  }
}

async function getFanartMetadata(tmdbId: string, type: 'movie' | 'tv' = 'movie') {
  if (!FANART_API_KEY || FANART_API_KEY === 'your_fanart_api_key_here') {
    return { logoUrl: null, backgroundUrl: null };
  }

  // Check Cache (Type-aware)
  const cached = await MetadataCache.findOne({ tmdbId, type }).catch(() => null);
  if (cached && cached.logoFetchedAt) { 
     console.log(`[CACHE HIT] ${type}:${tmdbId} -> ${cached.logoUrl ? 'Logo Found' : 'No Logo'}`);
     return { logoUrl: cached.logoUrl, backgroundUrl: cached.backgroundUrl };
  }

  try {
    let finalId = tmdbId;
    if (type === 'tv') {
      const tvdbId = await getTVDBId(tmdbId);
      if (!tvdbId) return { logoUrl: null, backgroundUrl: null };
      finalId = tvdbId.toString();
    }

    const endpoint = type === 'tv' ? 'tv' : 'movies';
    const fanartUrl = `https://webservice.fanart.tv/v3/${endpoint}/${finalId}?api_key=${FANART_API_KEY}`;
    console.log(`[FANART] Requesting: ${fanartUrl}`);
    
    let raw = await fetch(fanartUrl);
    console.log(`[FANART] Status: ${raw.status} for ${type}:${tmdbId}`);
    
    let data = await raw.json();

    // Secondary Fallback for Movies: IMDB ID
    if (type === 'movie' && !data.hdmovielogo && !data.movielogo) {
       const imdbId = await getIMDBId(tmdbId);
       if (imdbId) {
          const imdbUrl = `https://webservice.fanart.tv/v3/movies/${imdbId}?api_key=${FANART_API_KEY}`;
          console.log(`[FANART] Fallback IMDB Request: ${imdbUrl}`);
          const imdbRaw = await fetch(imdbUrl);
          console.log(`[FANART] IMDB Status: ${imdbRaw.status}`);
          const imdbData = await imdbRaw.json();
          if (imdbData.hdmovielogo || imdbData.movielogo) {
             data = imdbData;
          }
       }
    }

    let hdLogo = null;
    let backgroundUrl = null;

    if (type === 'tv') {
      const logoChoices = [...(data.hdtvlogo || []), ...(data.clearlogo || [])];
      if (logoChoices.length > 0) {
        // Priority: English -> Neutral -> First available
        const preferred = logoChoices.find((l: any) => l.lang === 'en') || 
                          logoChoices.find((l: any) => !l.lang || l.lang === '00' || l.lang === '') ||
                          logoChoices[0];
        hdLogo = preferred.url;
      }
      
      const backgroundChoices = [...(data.tvbackground || []), ...(data.hdclearart || [])];
      if (backgroundChoices.length > 0) backgroundUrl = backgroundChoices[0].url;

    } else {
      const logoChoices = [
        ...(data.hdmovielogo || []), 
        ...(data.movielogo || []),
        ...(data.hdmovieclearlogo || []), 
        ...(data.movieclearlogo || [])
      ];
      if (logoChoices.length > 0) {
        // Priority: English -> Neutral -> First available
        const preferred = logoChoices.find((l: any) => l.lang === 'en') || 
                          logoChoices.find((l: any) => !l.lang || l.lang === '00' || l.lang === '') ||
                          logoChoices[0];
        hdLogo = preferred.url;
      }

      const backgroundChoices = [
        ...(data.moviebackground || []), 
        ...(data.hdmovieclearart || []), 
        ...(data.moviebanner || [])
      ];
      if (backgroundChoices.length > 0) backgroundUrl = backgroundChoices[0].url;
    }

    // Save to Cache with Type
    await MetadataCache.findOneAndUpdate(
      { tmdbId, type },
      { logoUrl: hdLogo, backgroundUrl, logoFetchedAt: new Date(), type },
      { upsert: true }
    ).catch(() => null); 

    return { logoUrl: hdLogo, backgroundUrl };

  } catch (e: any) {
    console.error(`[FANART ERROR] ${type}:${tmdbId} -> ${e.message}`);
    return { logoUrl: null, backgroundUrl: null };
  }
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Nebula Backend Array active on http://localhost:${PORT}`);
  console.log(`Modes: Fanart [${FANART_API_KEY === 'your_fanart_api_key_here' ? 'DISABLED' : 'ACTIVE'}], Scraper [ACTIVE]`);
});
