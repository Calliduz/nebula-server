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
        episode?: number,
        signal?: AbortSignal
    ): Promise<MirrorStream[]> {
        try {
            console.log(`[VidLink] Generating token for ${type} ${tmdbId}${type === 'tv' ? ` S${season}E${episode}` : ''}...`);
            
            const token = await getVidLinkToken(tmdbId);
            const apiUrl = `${VIDLINK_BASE}/api/b/${type}/${token}${type === 'tv' ? `/${season}/${episode}` : ''}?multiLang=1`;

            let referer = `${VIDLINK_BASE}/movie/${tmdbId}`;
            if (type === 'tv') {
                referer = `${VIDLINK_BASE}/tv/${tmdbId}/${season}/${episode}`;
            }

            const response = await gotScraping.get(apiUrl, {
                headers: {
                    'Referer': referer,
                    'User-Agent': UA
                },
                timeout: { request: 10000 },
                signal: signal
            });

            const data = JSON.parse(response.body);
            const cookies = response.headers['set-cookie']?.join('; ') || '';

            if (!data || !data.stream) {
                console.warn(`[VidLink] No stream data found in API response.`);
                return [];
            }

            const mirrors: MirrorStream[] = [];
            
            // 1. Extract subtitles from 'subtitles' field (standard)
            const standardSubtitles = data.subtitles?.map((s: any) => ({
                url: s.url,
                lang: s.lang || 'en',
                languageName: s.label || getLanguageName(s.lang || 'en'),
                source: 'VidLink'
            })) || [];

            // 2. Extract subtitles from 'stream.captions' field (fallback/alternative)
            const captionsSubtitles = data.stream.captions?.map((c: any) => {
                // If language is a full name like "English", we should try to get the ISO code
                let lang = c.language?.toLowerCase();
                if (lang === 'english') lang = 'en';
                else if (lang === 'spanish') lang = 'es';
                else if (lang === 'french') lang = 'fr';
                // Add more common ones if needed, or use getLanguageName in reverse (hard)
                
                return {
                    url: c.url,
                    lang: lang || 'en',
                    languageName: c.language || getLanguageName(lang || 'en'),
                    source: 'VidLink'
                };
            }) || [];

            // Combine and deduplicate by URL
            const allSubsMap = new Map();
            [...standardSubtitles, ...captionsSubtitles].forEach(s => {
                if (s.url && !allSubsMap.has(s.url)) {
                    allSubsMap.set(s.url, s);
                }
            });

            const subtitles = Array.from(allSubsMap.values());
            
            if (subtitles.length > 0) {
              console.log(`[VidLink] Found ${subtitles.length} subtitles for ${tmdbId} (English: ${subtitles.some(s => s.lang === 'en' || s.languageName.toLowerCase().includes('english'))})`);
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
                    subtitles: subtitles.length > 0 ? subtitles : []
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
                            subtitles: subtitles.length > 0 ? subtitles : []
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
