import axios from 'axios';
import { getVidLinkToken } from './vidlinkToken.js';
import { type MirrorStream, UA } from './scraper.js';

const VIDLINK_BASE = 'https://vidlink.pro';
const VIDLINK_API = `${VIDLINK_BASE}/api/b`;

export class VidLinkScraper {
    /**
     * Extracts stream mirrors from VidLink.pro.
     * @param tmdbId The TMDB ID of the content.
     * @param type 'movie' or 'tv'.
     * @param season Season number (for TV).
     * @param episode Episode number (for TV).
     */
    static async getStream(
        tmdbId: string, 
        type: 'movie' | 'tv' = 'movie', 
        season?: number, 
        episode?: number
    ): Promise<MirrorStream[]> {
        try {
            console.log(`[VidLink] Generating token for ${type} ${tmdbId}${type === 'tv' ? ` S${season}E${episode}` : ''}...`);
            
            // For VidLink, the "id" passed to getAdv is just the TMDB ID for movies,
            // but for TV it might be different. Let's start with Movie support.
            if (type === 'tv' && (!season || !episode)) {
                throw new Error('Season and Episode are required for TV shows');
            }

            const token = await getVidLinkToken(tmdbId);
            
            let apiUrl = `${VIDLINK_API}/movie/${token}?multiLang=0`;
            let referer = `${VIDLINK_BASE}/movie/${tmdbId}`;

            if (type === 'tv') {
                // TV API pattern: /api/b/tv/{token}/{s}/{e}
                apiUrl = `${VIDLINK_API}/tv/${token}/${season}/${episode}?multiLang=0`;
                referer = `${VIDLINK_BASE}/tv/${tmdbId}/${season}/${episode}`;
            }

            const { data } = await axios.get(apiUrl, {
                headers: {
                    'Referer': referer,
                    'User-Agent': UA
                },
                timeout: 10000
            });

            if (!data || !data.stream) {
                console.warn(`[VidLink] No stream data found in API response.`);
                return [];
            }

            const mirrors: MirrorStream[] = [];
            const subtitles = data.subtitles?.map((s: any) => ({
                url: s.url,
                lang: s.lang,
                languageName: s.label || s.lang,
                source: 'VidLink'
            })) || [];

            // Add the main HLS playlist if available
            if (data.stream.playlist) {
                mirrors.push({
                    url: data.stream.playlist,
                    quality: 'Auto',
                    source: 'VidLink',
                    type: 'hls',
                    subtitles: subtitles.length > 0 ? subtitles : undefined
                });
            }

            // Add other qualities/formats if available
            if (Array.isArray(data.stream.qualities)) {
                data.stream.qualities.forEach((q: any) => {
                    if (q.url) {
                        mirrors.push({
                            url: q.url,
                            quality: q.label || 'Unknown',
                            source: 'VidLink',
                            type: q.url.includes('.m3u8') ? 'hls' : 'mp4',
                            subtitles: subtitles.length > 0 ? subtitles : undefined
                        });
                    }
                });
            }

            console.log(`[VidLink] Successfully extracted ${mirrors.length} mirrors.`);
            return mirrors;
        } catch (e: any) {
            console.error(`[VidLink] Extraction failed:`, e.message);
            return [];
        }
    }
}
