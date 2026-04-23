import { hybridFetch } from './fetcher.js';
import { type MirrorStream } from './scraper.js';
import generateKissKHToken from './kisskhToken.js';

const KISSKH_BASE = 'https://kisskh.do';
const KISSKH_API = `${KISSKH_BASE}/api`;
const VI_GUID = '62f176f3bb1b5b8e70e39932ad34a0c7';

/**
 * KissKH Scraper - Hybrid Browser Edition
 * Uses Puppeteer only when blocked, then falls back to ultra-fast HTTP.
 */
export class KissKHScraper {
    static async search(query: string, isHollywood: boolean = true): Promise<any[]> {
        const type = isHollywood ? 4 : 0;
        const url = `${KISSKH_API}/DramaList/Search?q=${encodeURIComponent(query)}&type=${type}`;
        console.log(`[KissKH] Searching: ${query} (Hollywood: ${isHollywood})`);
        
        try {
            const data = await hybridFetch(url, { json: true, referer: KISSKH_BASE });
            return Array.isArray(data) ? data : [];
        } catch (e: any) {
            console.error(`[KissKH] Search failed:`, e.message);
            return [];
        }
    }

    static async getDramaDetail(id: number): Promise<any> {
        const url = `${KISSKH_API}/DramaList/Drama/${id}?ispc=false`;
        const referer = `${KISSKH_BASE}/Drama/Detail?id=${id}`;
        try {
            return await hybridFetch(url, { json: true, referer });
        } catch (e: any) {
            console.error(`[KissKH] Detail failed:`, e.message);
            return null;
        }
    }

    static async getStream(dramaId: number, epId: number): Promise<MirrorStream[]> {
        try {
            const pageUrl = `${KISSKH_BASE}/Drama/v?id=${dramaId}&ep=${epId}`;
            
            // Using the "Golden Handshake" token logic
            const kkey = (generateKissKHToken as any)(
                epId, 
                null, "2.8.10", VI_GUID, 4830201, "kisskh", "kisskh", "kisskh", "kisskh", "kisskh", "kisskh"
            );
            
            const apiUrl = `${KISSKH_API}/DramaList/Episode/${epId}.png?err=false&ts=null&time=null&kkey=${kkey}`;
            const subApiUrl = `${KISSKH_API}/Sub/${epId}?kkey=${kkey}`;
            
            console.log(`[KissKH] Fetching stream/subs for epId: ${epId}...`);
            const [data, subData] = await Promise.all([
                hybridFetch(apiUrl, { json: true, referer: pageUrl }),
                hybridFetch(subApiUrl, { json: true, referer: pageUrl })
            ]);

            if (!data || !data.Video) return [];

            const mirrors: MirrorStream[] = [];
            const subtitles: any[] = [];

            if (Array.isArray(subData)) {
                subData.forEach((s: any) => {
                    if (s.src) {
                        subtitles.push({
                            url: s.src,
                            lang: s.land || 'en',
                            languageName: s.label || 'English',
                            source: 'KissKH'
                        });
                    }
                });
            }

            mirrors.push({
                url: data.Video,
                quality: 'Auto',
                source: 'KissKH',
                type: 'hls',
                subtitles: subtitles.length > 0 ? subtitles : undefined
            });

            return mirrors;
        } catch (e: any) {
            console.error(`[KissKH] Stream extraction failed:`, e.message);
            return [];
        }
    }

    static async getExploreList(type: number = 0, country: number = 0, page: number = 1, order: number = 1): Promise<any[]> {
        const url = `${KISSKH_API}/DramaList/List?page=${page}&type=${type}&sub=0&country=${country}&status=0&order=${order}`;
        try {
            const data = await hybridFetch(url, { json: true, referer: KISSKH_BASE });
            return data?.data || [];
        } catch (e: any) {
            console.error(`[KissKH] Explore failed:`, e.message);
            return [];
        }
    }
}
