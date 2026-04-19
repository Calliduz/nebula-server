/**
 * nebula-server/utils/scraper.ts
 *
 * 4-Layer HTTP Scraper Pipeline — vsembed → cloudnestra → m3u8
 *
 * Architecture:
 *   Layer 1 (Router)    vsembed.ru/embed/movie/{tmdbId}   → player_iframe src
 *   Layer 2 (Wrapper)   cloudnestra.com/rcp/{token}        → /prorcp/{path} via jQuery
 *   Layer 3 (PlayerJS)  cloudnestra.com/prorcp/{path}      → file:"..." + ping URL + token
 *   Layer 4 (Cleaning)  split by " or ", patch {vX} placeholders → clean m3u8 array
 *
 * Anti-detection:
 *   - Cookie Jar:    Persists Set-Cookie headers across all layers (session ID spoofing)
 *   - Heartbeat:     Replicates the rt_ping.php 60s interval with exact headers/cookies
 *   - CDN Fallback:  Auto-retries across backup CDN domains if the primary goes down
 *   - Header Parity: Every request matches what Chrome sends from cloudnestra.com
 *
 * Domain config:
 *   VIDSRC_EMBED_HOST in .env — swap if vsembed.ru ever changes domain
 */

import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';

// ── Constants ───────────────────────────────────────────────────────────────

/** Internal CDN that serves the actual HLS streams. */
const CLOUDNESTRA_HOST = 'https://cloudnestra.com';

/**
 * CDN fallback map — maps {v1}..{v5} placeholders to actual CDN domains.
 * Cloudnestra uses these interchangeably; if one goes down swap the domain here.
 * Discovered by probing the live pipeline.
 */
const CDN_DOMAIN_MAP: Record<string, string> = {
    '{v1}': 'neonhorizonworkshops.com',
    '{v2}': 'wanderlynest.com',
    '{v3}': 'orchidpixelgardens.com',
    '{v4}': 'cloudnestra.com',
    '{v5}': 'cloudnestra.com',   // app2.{v5} → app2.cloudnestra.com
};

/** Matches a real Chrome browser on Windows. Must be consistent across all requests. */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Types ───────────────────────────────────────────────────────────────────

export interface ScrapeResult {
    /** Best-quality .m3u8 URL (first in the array). */
    streamUrl: string;
    /** All available fallback .m3u8 URLs. */
    streams: string[];
    /** Human-readable source identifier. */
    source: string;
    /** Heartbeat session — pass to startHeartbeat() to keep the stream alive. */
    session: HeartbeatSession;
}

export interface HeartbeatSession {
    /** Full URL to ping every 60 seconds. */
    pingUrl: string | null;
    /** Any query params extracted from the player (e.g. token, timestamp). */
    pingParams: Record<string, string>;
    /** The referer header to use when pinging. */
    pingReferer: string;
    /** Serialized cookies from the scrape session — attached to every ping. */
    cookieJar: CookieJar;
}

// ── Heartbeat Manager ───────────────────────────────────────────────────────

/** Map of active heartbeat loops keyed by a session ID (tmdbId). */
const activeHeartbeats = new Map<string, NodeJS.Timeout>();

/**
 * startHeartbeat
 *
 * Begins the 60-second rt_ping.php loop for a given stream session.
 * Call immediately after scrapeVsembed() succeeds.
 *
 * @param sessionId  Unique key (use tmdbId) — used to cancel the loop later.
 * @param session    HeartbeatSession returned by scrapeVsembed().
 */
export function startHeartbeat(sessionId: string, session: HeartbeatSession): void {
    if (!session.pingUrl) {
        console.log(`[HEARTBEAT] No ping URL found for session ${sessionId}. Skipping.`);
        return;
    }

    // Cancel any existing heartbeat for this session before starting a new one
    stopHeartbeat(sessionId);

    const ping = async () => {
        try {
            const client = wrapper(axios.create({ jar: session.cookieJar }));
            await client.get(session.pingUrl!, {
                params: session.pingParams,
                headers: {
                    'User-Agent': UA,
                    'Referer': session.pingReferer,
                    'Origin': CLOUDNESTRA_HOST,
                },
                timeout: 8000,
            });
            console.log(`[HEARTBEAT] ♥ Ping sent for session ${sessionId}`);
        } catch {
            // Silent — a failed ping is non-fatal, the loop continues
        }
    };

    // Send the first ping immediately, then every 55 seconds (5s buffer before their 60s kill)
    ping();
    const interval = setInterval(ping, 55_000);
    activeHeartbeats.set(sessionId, interval);
    console.log(`[HEARTBEAT] Started for session ${sessionId}`);
}

/**
 * stopHeartbeat
 *
 * Cancels the ping loop for a given session.
 * Call when the user stops watching or the player is closed.
 */
export function stopHeartbeat(sessionId: string): void {
    const interval = activeHeartbeats.get(sessionId);
    if (interval) {
        clearInterval(interval);
        activeHeartbeats.delete(sessionId);
        console.log(`[HEARTBEAT] Stopped for session ${sessionId}`);
    }
}

// ── Internal Axios factory ──────────────────────────────────────────────────

/**
 * Creates a new axios instance with a shared CookieJar.
 * All requests through this instance share cookies automatically
 * (session ID, any tracking tokens, etc).
 */
function createSession(): { client: ReturnType<typeof wrapper>, jar: CookieJar } {
    const jar = new CookieJar();
    const client = wrapper(axios.create({
        jar,
        withCredentials: true,
        timeout: 12000,
        responseType: 'text',
        maxRedirects: 5,
    }));
    return { client, jar };
}

function buildHeaders(referer: string, extra: Record<string, string> = {}): Record<string, string> {
    return {
        'User-Agent': UA,
        'Referer': referer,
        'Origin': new URL(referer).origin,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Sec-Fetch-Dest': 'iframe',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'cross-site',
        ...extra,
    };
}

// ── Main Pipeline ───────────────────────────────────────────────────────────

/**
 * scrapeVsembed
 *
 * Runs the full 4-layer HTTP pipeline and returns a ScrapeResult.
 * Throws with a descriptive message on any unrecoverable failure.
 */
export async function scrapeVsembed(
    tmdbId: string,
    kind: 'movie' | 'tv',
    embedHost: string,
    season = 1,
    episode = 1,
): Promise<ScrapeResult> {

    const { client, jar } = createSession();
    const cleanEmbedHost = embedHost.replace(/\/$/, '');

    // ── Layer 1: The Router ────────────────────────────────────────────────
    // Fetches the vsembed page and extracts the cloudnestra iframe src.

    const routerUrl = kind === 'tv'
        ? `${cleanEmbedHost}/embed/tv/${tmdbId}/${season}/${episode}`
        : `${cleanEmbedHost}/embed/movie/${tmdbId}`;

    console.log(`[SCRAPER] L1 Router  → ${routerUrl}`);
    const routerRes = await client.get(routerUrl, {
        headers: buildHeaders(cleanEmbedHost + '/'),
    });
    const routerHtml: string = routerRes.data;

    // Match src="//cloudnestra.com/rcp/..." directly - the page may not have id="player_iframe"
    const iframeMatch =
        routerHtml.match(/["'](\/\/cloudnestra\.com\/rcp\/[^"']+)["']/i) ||
        routerHtml.match(/id=["']player_iframe["'][^>]+src=["']([^"']+)["']/i) ||
        routerHtml.match(/src=["']([^"']+)["'][^>]+id=["']player_iframe["']/i);

    if (!iframeMatch?.[1]) {
        throw new Error('L1: cloudnestra iframe src not found — vsembed page structure may have changed');
    }

    let wrapperUrl = iframeMatch[1];
    if (wrapperUrl.startsWith('//')) wrapperUrl = 'https:' + wrapperUrl;
    if (wrapperUrl.startsWith('/'))  wrapperUrl = CLOUDNESTRA_HOST + wrapperUrl;

    console.log(`[SCRAPER] L1     ✔  iframe → ${wrapperUrl}`);

    // ── Layer 2: The Wrapper ───────────────────────────────────────────────
    // Fetches the cloudnestra /rcp/ page with the vsembed referer.
    // CRITICAL: Without the correct Referer, cloudnestra returns 404.

    console.log(`[SCRAPER] L2 Wrapper → ${wrapperUrl}`);
    const wrapperRes = await client.get(wrapperUrl, {
        headers: buildHeaders(cleanEmbedHost + '/'),
    });
    const wrapperHtml: string = wrapperRes.data;

    // Match the jQuery-loaded iframe: src: '/prorcp/XXXXX'
    const prorpcMatch = wrapperHtml.match(/src:\s*['"](\/?prorcp\/[^'"]+)['"]/i);
    if (!prorpcMatch?.[1]) {
        throw new Error('L2: /prorcp/ path not found — cloudnestra wrapper structure may have changed');
    }

    const prorpcPath = prorpcMatch[1].startsWith('/') ? prorpcMatch[1] : '/' + prorpcMatch[1];
    const playerUrl = CLOUDNESTRA_HOST + prorpcPath;

    console.log(`[SCRAPER] L2     ✔  prorcp → ${playerUrl}`);

    // ── Layer 3: The PlayerJS Config ──────────────────────────────────────
    // Fetches the actual PlayerJS configuration page.
    // CRITICAL: Referer must be cloudnestra.com — not vsembed.

    console.log(`[SCRAPER] L3 PlayerJS → ${playerUrl}`);
    const playerRes = await client.get(playerUrl, {
        headers: buildHeaders(CLOUDNESTRA_HOST + '/'),
    });
    const playerHtml: string = playerRes.data;

    // Extract: file: "https://cdn.../master.m3u8 or https://cdn2.../..."
    const fileMatch = playerHtml.match(/file:\s*["']([^"']+)["']/i);
    if (!fileMatch?.[1]) {
        throw new Error('L3: `file:` property not found in PlayerJS config');
    }
    const rawFileString = fileMatch[1];
    console.log(`[SCRAPER] L3     ✔  file string (${rawFileString.length} chars)`);

    // Extract ping URL — e.g. var ping_url = "//tmstr4.cloudnestra.com/rt_ping.php"
    let pingUrl: string | null = null;
    const pingMatch = playerHtml.match(/(?:ping_url|rt_ping)\s*[=:]\s*["']([^"']+)["']/i) ||
                      playerHtml.match(/["'](\/\/[^"']+rt_ping\.php[^"']*)["']/i);
    if (pingMatch?.[1]) {
        pingUrl = pingMatch[1].startsWith('//') ? 'https:' + pingMatch[1] : pingMatch[1];
        console.log(`[SCRAPER] L3     ✔  ping → ${pingUrl}`);
    } else {
        // Common static fallback — still send pings even without explicit URL
        pingUrl = 'https://tmstr4.cloudnestra.com/rt_ping.php';
        console.log(`[SCRAPER] L3     ⚑  ping URL not found, using static fallback`);
    }

    // Extract dynamic token if present — e.g. var csrf = "A8f9..."
    const pingParams: Record<string, string> = {};
    const tokenMatch = playerHtml.match(/(?:csrf|_token|ping_token)\s*[=:]\s*["']([^"']{8,})["']/i);
    if (tokenMatch?.[1]) {
        pingParams['t'] = tokenMatch[1];
        console.log(`[SCRAPER] L3     ✔  token extracted`);
    }

    // ── Layer 4: Data Cleaning ─────────────────────────────────────────────
    // Split " or " fallbacks, replace {vX} CDN placeholders, filter valid m3u8.

    const rawStreams = rawFileString.split(' or ').map(s => s.trim());
    const streams: string[] = [];

    for (const raw of rawStreams) {
        // Replace {vX} placeholder with the corresponding CDN domain
        let resolved = raw;
        for (const [placeholder, domain] of Object.entries(CDN_DOMAIN_MAP)) {
            resolved = resolved.replace(placeholder, domain);
        }
        if (resolved.includes('.m3u8') || resolved.match(/\/pl\//)) {
            streams.push(resolved);
        }
    }

    const validStreams = streams.filter(s => s.includes('.m3u8'));

    if (validStreams.length === 0) {
        throw new Error('L4: No valid .m3u8 URLs found after cleaning');
    }

    console.log(`[SCRAPER] L4     ✔  ${validStreams.length} stream(s) resolved`);
    validStreams.forEach((s, i) =>
        console.log(`         [${i + 1}] ${s.substring(0, 90)}`)
    );

    return {
        streamUrl: validStreams[0],
        streams: validStreams,
        source: 'vsembed-cloudnestra',
        session: {
            pingUrl,
            pingParams,
            pingReferer: CLOUDNESTRA_HOST + '/',
            cookieJar: jar,
        },
    };
}
