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

mongoose.connect(MONGODB_URI).then(() => {
  console.log('MongoDB Uplink Established');
}).catch((err) => {
  console.warn('MongoDB Uplink Failed. Running in volatile mode.', err.message);
});

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
        { upsert: true, new: true }
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
     const ids = isBatch.split(',');
     const results = [];
     for (const id of ids) {
       const result = await getFanartMetadata(id);
       if (result) results.push({ id, ...result });
     }
     return res.json({ results });
  }

  if (!tmdbId) return res.status(400).json({ error: 'Missing tmdbId' });

  try {
     const result = await getFanartMetadata(tmdbId);
     return res.json(result || { logoUrl: null });
  } catch (error: any) {
     console.error(`[METADATA ERROR] ${error.message}`);
     return res.status(500).json({ error: 'Failed to extract metadata' });
  }
});

async function getFanartMetadata(tmdbId: string) {
  if (!FANART_API_KEY || FANART_API_KEY === 'your_fanart_api_key_here') {
    return { logoUrl: null }; // Disabled
  }

  // Check Cache
  const cached = await MetadataCache.findOne({ tmdbId }).catch(() => null);
  if (cached && cached.logoFetchedAt) { // Check if we already tried, even if it failed (logoUrl could be null)
     return { logoUrl: cached.logoUrl };
  }

  try {
    const raw = await fetch(`https://webservice.fanart.tv/v3/movies/${tmdbId}?api_key=${FANART_API_KEY}`);
    const data = await raw.json();

    let hdLogo = null;
    if (data.hdmovieclearart && data.hdmovieclearart.length > 0) {
      hdLogo = data.hdmovieclearart[0].url;
    } else if (data.hdmovielogo && data.hdmovielogo.length > 0) {
      hdLogo = data.hdmovielogo[0].url;
    } else if (data.moviebrowser && data.moviebrowser.length > 0) {
       hdLogo = data.moviebrowser[0].url;
    }

    // Save to Cache
    await MetadataCache.findOneAndUpdate(
      { tmdbId },
      { logoUrl: hdLogo, logoFetchedAt: new Date() },
      { upsert: true, new: true }
    ).catch(() => null); // Silent database fail if running volatile

    return { logoUrl: hdLogo };

  } catch (e: any) {
    if (e.message.includes('404')) {
        // Logo doesn't exist on fanart, cache the null so we don't spam 404s
        await MetadataCache.findOneAndUpdate(
          { tmdbId },
          { logoUrl: null, logoFetchedAt: new Date() },
          { upsert: true, new: true }
        ).catch(() => null);
    }
    return { logoUrl: null };
  }
}

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Nebula Backend Array active on http://localhost:${PORT}`);
  console.log(`Modes: Fanart [${FANART_API_KEY === 'your_fanart_api_key_here' ? 'DISABLED' : 'ACTIVE'}], Scraper [ACTIVE]`);
});
