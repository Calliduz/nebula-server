import axios from 'axios';
import { type MirrorStream } from './scraper.js';
import generateKissKHToken from './kisskhToken.js';

const KISSKH_BASE = 'https://kisskh.do';
const KISSKH_API = `${KISSKH_BASE}/api`;
const VI_GUID = '62f176f3bb1b5b8e70e39932ad34a0c7';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * KissKH Scraper - High Performance / Low RAM
 * Pure API Scraper (No Puppeteer/Browser needed)
 */
export class KissKHScraper {
    private static async getHeaders(referer: string = KISSKH_BASE) {
        return {
            'User-Agent': USER_AGENT,
            'Accept': 'application/json, text/plain, */*',
            'Referer': referer,
            'Origin': KISSKH_BASE,
        };
    }

    static async search(query: string, isHollywood: boolean = true): Promise<any[]> {
        try {
            const type = isHollywood ? 4 : 0;
            const url = `${KISSKH_API}/DramaList/Search?q=${encodeURIComponent(query)}&type=${type}`;
            const res = await axios.get(url, { 
                headers: await this.getHeaders(),
                validateStatus: (s) => s < 500 // Allow 429 to be handled manually
            });

            if (res.status === 429) {
                console.warn(`[KissKH] Search Rate Limited (429) - Retry in a few minutes.`);
                return [];
            }

            return res.data || [];
        } catch (e: any) {
            console.error(`[KissKH] Search failed:`, e.message);
            return [];
        }
    }

    static async getDramaDetail(id: number): Promise<any> {
        try {
            const url = `${KISSKH_API}/DramaList/Drama/${id}?ispc=false`;
            const res = await axios.get(url, { 
                headers: await this.getHeaders(`${KISSKH_BASE}/Drama/Detail?id=${id}`),
                validateStatus: (s) => s < 500
            });

            if (res.status === 429) {
                console.warn(`[KissKH] Detail Rate Limited (429)`);
                return null;
            }

            return res.data;
        } catch (e: any) {
            console.error(`[KissKH] Detail failed:`, e.message);
            return null;
        }
    }

    /**
     * Pure API Extraction: No Puppeteer needed.
     */
    static async getStream(dramaId: number, epId: number): Promise<MirrorStream[]> {
        try {
            const pageUrl = `${KISSKH_BASE}/Drama/v?id=${dramaId}&ep=${epId}`;
            console.log(`[KissKH] Generating token for epId: ${epId}...`);
            
            // Using the "Golden Handshake" discovered via browser sniffer
            const kkey = (generateKissKHToken as any)(
                epId, 
                null,        // arg2
                "2.8.10",    // arg3
                VI_GUID,     // arg4
                4830201,     // arg5
                "kisskh",    // arg6
                "kisskh",    // arg7
                "kisskh",    // arg8
                "kisskh",    // arg9
                "kisskh",    // arg10
                "kisskh"     // arg11
            );
            const apiUrl = `${KISSKH_API}/DramaList/Episode/${epId}.png?err=false&ts=null&time=null&kkey=${kkey}`;
            
            console.log(`[KissKH] Fetching stream link from API...`);
            const res = await axios.get(apiUrl, { 
                headers: await this.getHeaders(pageUrl),
                timeout: 5000,
                validateStatus: (s) => s < 500
            });

            if (res.status === 429) {
                console.warn(`[KissKH] Stream Rate Limited (429)`);
                return [];
            }

            const data = res.data;
            const mirrors: MirrorStream[] = [];
            const subtitles: SubtitleStream[] = [];

            // Extract subtitles from ThirdParty (e.g. sbplay)
            if (data.ThirdParty) {
                try {
                    const params = new URLSearchParams(data.ThirdParty.split('?')[1]);
                    for (let i = 1; i <= 5; i++) {
                        const subUrl = params.get(`caption_${i}`);
                        const subLabel = params.get(`sub_${i}`) || 'English';
                        if (subUrl && subUrl.startsWith('http')) {
                            subtitles.push({
                                url: subUrl,
                                lang: subLabel.toLowerCase().slice(0, 3), // lowercase short lang
                                languageName: subLabel,
                                source: 'KissKH'
                            });
                        }
                    }
                } catch (e) {
                    console.error(`[KissKH] Subtitle parse failed:`, e);
                }
            }

            if (data.Video) {
                mirrors.push({
                    url: data.Video,
                    quality: 'Auto',
                    source: 'KissKH',
                    type: 'hls',
                    subtitles: subtitles.length > 0 ? subtitles : undefined
                });
            }

            return mirrors;
        } catch (e: any) {
            console.error(`[KissKH] Stream API extraction failed:`, e.message);
            return [];
        }
    }

    static async getExploreList(type: number = 0, country: number = 0, page: number = 1, order: number = 1): Promise<any[]> {
        try {
            // type: 0=All, 1=TVSeries, 2=Movie, 3=Anime, 4=Hollywood
            // country: 0=All, 1=South Korea, 2=China, 7=Thailand, 8=Philippines, etc.
            // order: 1=Last Update, 2=Popular, 3=Release Date
            const url = `${KISSKH_API}/DramaList/List?page=${page}&type=${type}&sub=0&country=${country}&status=0&order=${order}`;
            const res = await axios.get(url, { 
                headers: await this.getHeaders(),
                validateStatus: (s) => s < 500
            });

            if (res.status === 429) return [];
            return res.data?.data || [];
        } catch (e: any) {
            console.error(`[KissKH] Explore failed:`, e.message);
            return [];
        }
    }
}
