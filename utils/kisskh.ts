import { got } from 'got-scraping';
import { type MirrorStream } from './scraper.js';
import generateKissKHToken from './kisskhToken.js';

const KISSKH_BASE = 'https://kisskh.do';
const KISSKH_API = `${KISSKH_BASE}/api`;
const VI_GUID = '62f176f3bb1b5b8e70e39932ad34a0c7';

/**
 * KissKH Scraper - Hardened Edition
 * Uses got-scraping for JA3 Fingerprinting & HTTP/2 to bypass Cloudflare.
 */
export class KissKHScraper {
    private static async getHeaders(referer: string = KISSKH_BASE) {
        return {
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': referer,
            'Origin': KISSKH_BASE,
            'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
        };
    }

    private static async request(url: string, referer?: string) {
        try {
            const response = await got.get(url, {
                headers: await this.getHeaders(referer),
                http2: true,
                timeout: { request: 10000 },
                retry: { limit: 2 },
                throwHttpErrors: false,
            });

            if (response.statusCode === 403 || response.statusCode === 406) {
                console.error(`[KissKH] ✘ Blocked (Status ${response.statusCode}) - IP might be hard-blocked.`);
                return null;
            }

            if (response.statusCode === 429) {
                console.warn(`[KissKH] ⚠ Rate Limited (429)`);
                return null;
            }

            // Parse body safely
            try {
                return typeof response.body === 'string' ? JSON.parse(response.body) : response.body;
            } catch {
                return response.body;
            }
        } catch (e: any) {
            console.error(`[KissKH] Request Error: ${e.message}`);
            return null;
        }
    }

    static async search(query: string, isHollywood: boolean = true): Promise<any[]> {
        const type = isHollywood ? 4 : 0;
        const url = `${KISSKH_API}/DramaList/Search?q=${encodeURIComponent(query)}&type=${type}`;
        console.log(`[KissKH] Searching: ${query} (Hollywood: ${isHollywood})`);
        
        const data = await this.request(url);
        return Array.isArray(data) ? data : [];
    }

    static async getDramaDetail(id: number): Promise<any> {
        const url = `${KISSKH_API}/DramaList/Drama/${id}?ispc=false`;
        const referer = `${KISSKH_BASE}/Drama/Detail?id=${id}`;
        return await this.request(url, referer);
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
                this.request(apiUrl, pageUrl),
                this.request(subApiUrl, pageUrl)
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
        const data = await this.request(url);
        return data?.data || [];
    }
}

