import { gotScraping } from 'got-scraping';
import { getVidLinkToken } from './vidlinkToken.js';
import { type MirrorStream, UA } from './scraper.js';
import { getLanguageName } from './subtitles.js';

const VIDLINK_BASE = 'https://vidlink.pro';

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
            
            const token = await getVidLinkToken(tmdbId);
            const apiUrl = `${VIDLINK_BASE}/api/b/${type}/${token}${type === 'tv' ? `/${season}/${episode}` : ''}?multiLang=0`;

            let referer = `${VIDLINK_BASE}/movie/${tmdbId}`;
            if (type === 'tv') {
                referer = `${VIDLINK_BASE}/tv/${tmdbId}/${season}/${episode}`;
            }

            const response = await gotScraping.get(apiUrl, {
                headers: {
                    'Referer': referer,
                    'User-Agent': UA
                },
                timeout: { request: 10000 }
            });

            const data = JSON.parse(response.body);
            const cookies = response.headers['set-cookie']?.join('; ') || '';

            if (!data || !data.stream) {
                console.warn(`[VidLink] No stream data found in API response.`);
                return [];
            }

            const mirrors: MirrorStream[] = [];
            const subtitles = data.subtitles?.map((s: any) => ({
                url: s.url,
                lang: s.lang,
                languageName: s.label || getLanguageName(s.lang),
                source: 'VidLink'
            })) || [];
            
            if (subtitles.length > 0) {
              console.log(`[VidLink] Found ${subtitles.length} subtitles for ${tmdbId}`);
            } else {
              console.warn(`[VidLink] No subtitles found in API response for ${tmdbId}`);
            }

            const streamHeaders = cookies ? { cookie: cookies } : undefined;

            // Add the main HLS playlist if available
            if (data.stream.playlist) {
                mirrors.push({
                    url: data.stream.playlist,
                    quality: 'Auto',
                    source: 'VidLink',
                    type: 'hls',
                    headers: streamHeaders,
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
                            headers: streamHeaders,
                            subtitles: subtitles.length > 0 ? subtitles : undefined
                        });
                    }
                });
            }

            console.log(`[VidLink] Successfully extracted ${mirrors.length} mirrors (cookies: ${cookies ? 'YES' : 'NONE'}).`);
            return mirrors;
        } catch (e: any) {
            console.error(`[VidLink] Extraction failed:`, e.message);
            return [];
        }
    }
}
