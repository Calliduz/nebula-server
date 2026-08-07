import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const KEY_PREFIX = "nebula:proxy:";
const DEFAULT_TTL_SECONDS = 10 * 60; // 10 minutes

let isConnected = false;

export const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  retryStrategy(times: number) {
    // Retry connection every 5 seconds, up to 10 attempts
    if (times > 10) return null;
    return Math.min(times * 500, 5000);
  },
});

redis.on("connect", () => {
  isConnected = true;
  console.log(`[REDIS] ✅ Connected to ${REDIS_URL}`);
});

redis.on("error", (err: any) => {
  if (isConnected) {
    console.warn("[REDIS] ⚠️ Connection error:", err.message);
  }
  isConnected = false;
});

redis.on("close", () => {
  isConnected = false;
});

/**
 * Retrieves a cached manifest response from Redis.
 * Gracefully returns null if Redis is offline or key missing.
 */
export async function getRedisCache(
  key: string,
): Promise<{ body: Buffer; headers: any } | null> {
  if (!isConnected) return null;
  try {
    const raw = await redis.get(`${KEY_PREFIX}${key}`);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.body || !parsed.headers) return null;

    return {
      body: Buffer.from(parsed.body, "base64"),
      headers: parsed.headers,
    };
  } catch (err: any) {
    console.warn(`[REDIS] Read error for key "${key}":`, err.message);
    return null;
  }
}

/**
 * Stores a manifest response in Redis with expiration (TTL).
 * Gracefully ignores errors if Redis is offline.
 */
export async function setRedisCache(
  key: string,
  body: Buffer,
  headers: any,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<void> {
  if (!isConnected) return;
  try {
    const payload = JSON.stringify({
      headers,
      body: body.toString("base64"),
    });

    await redis.set(`${KEY_PREFIX}${key}`, payload, "EX", ttlSeconds);
  } catch (err: any) {
    console.warn(`[REDIS] Write error for key "${key}":`, err.message);
  }
}

/**
 * Clears all cached proxy entries matching the key prefix.
 */
export async function delRedisCache(pattern = "*"): Promise<number> {
  if (!isConnected) return 0;
  try {
    const keys = await redis.keys(`${KEY_PREFIX}${pattern}`);
    if (keys.length > 0) {
      return await redis.del(...keys);
    }
    return 0;
  } catch (err: any) {
    console.warn("[REDIS] Flush error:", err.message);
    return 0;
  }
}

/**
 * Returns current Redis status and cached key count.
 */
export async function getRedisStats(): Promise<{
  status: string;
  size: number;
}> {
  if (!isConnected) return { status: "OFFLINE", size: 0 };
  try {
    const keys = await redis.keys(`${KEY_PREFIX}*`);
    return { status: "ONLINE", size: keys.length };
  } catch {
    return { status: "ERROR", size: 0 };
  }
}

/**
 * Cleanly disconnects from Redis during server shutdown.
 */
export async function shutdownRedis(): Promise<void> {
  if (!isConnected) return;
  console.log("[REDIS] Disconnecting Redis client...");
  try {
    await redis.quit();
    console.log("[REDIS] Client disconnected.");
  } catch (err: any) {
    console.error("[REDIS] Error closing connection:", err.message);
  }
}

const VIEWER_PREFIX = "nebula:viewer:";
const VIEWER_TTL = 45; // 45 seconds TTL (client pings every 25s)

// In-memory fallback map for local development when Redis is offline
const memoryViewerMap = new Map<string, ActiveViewerSession>();

export interface ActiveViewerSession {
  sessionId: string;
  title: string;
  tmdbId?: string;
  type?: string;
  ts: number;
}

/**
 * Registers or renews a live viewer heartbeat in Redis (or in memory if Redis is offline).
 */
export async function registerViewerHeartbeat(
  sessionId: string,
  title: string,
  tmdbId?: string,
  type?: string,
): Promise<void> {
  if (!sessionId) return;

  const sessionObj: ActiveViewerSession = {
    sessionId,
    title: title || "Unknown Title",
    tmdbId: tmdbId || "",
    type: type || "movie",
    ts: Date.now(),
  };

  // Always update local dev memory map
  memoryViewerMap.set(sessionId, sessionObj);

  if (isConnected) {
    try {
      const key = `${VIEWER_PREFIX}${sessionId}`;
      await redis.set(key, JSON.stringify(sessionObj), "EX", VIEWER_TTL);
    } catch (err: any) {
      console.warn("[REDIS] Heartbeat error:", err.message);
    }
  }
}

/**
 * Aggregates all active viewers from Redis (or in-memory map if Redis is offline).
 */
export async function getActiveViewersStats(): Promise<{
  totalViewers: number;
  activeStreams: Array<{
    title: string;
    count: number;
    type: string;
    tmdbId?: string;
  }>;
}> {
  const now = Date.now();
  const cutoff = now - VIEWER_TTL * 1000;

  // Prune expired sessions from in-memory fallback map
  for (const [sId, sess] of memoryViewerMap.entries()) {
    if (sess.ts < cutoff) {
      memoryViewerMap.delete(sId);
    }
  }

  // If Redis is online, aggregate from Redis
  if (isConnected) {
    try {
      const keys = await redis.keys(`${VIEWER_PREFIX}*`);
      if (keys.length > 0) {
        const mgetRes = await redis.mget(...keys);
        const streamCounts = new Map<
          string,
          { count: number; type: string; tmdbId?: string }
        >();

        let totalViewers = 0;

        for (const raw of mgetRes) {
          if (!raw) continue;
          try {
            const item = JSON.parse(raw) as ActiveViewerSession;
            totalViewers++;
            const existing = streamCounts.get(item.title);
            if (existing) {
              existing.count++;
            } else {
              const newItem: { count: number; type: string; tmdbId?: string } = {
                count: 1,
                type: item.type || "movie",
              };
              if (item.tmdbId) newItem.tmdbId = item.tmdbId;
              streamCounts.set(item.title, newItem);
            }
          } catch {}
        }

        const activeStreams: Array<{
          title: string;
          count: number;
          type: string;
          tmdbId?: string;
        }> = Array.from(streamCounts.entries())
          .map(([title, val]) => {
            const entry: {
              title: string;
              count: number;
              type: string;
              tmdbId?: string;
            } = {
              title,
              count: val.count,
              type: val.type,
            };
            if (val.tmdbId) entry.tmdbId = val.tmdbId;
            return entry;
          })
          .sort((a, b) => b.count - a.count);

        return { totalViewers, activeStreams };
      }
    } catch (err: any) {
      console.warn("[REDIS] Error getting viewer stats:", err.message);
    }
  }

  // Fallback: Aggregate from memory map (for local dev or if Redis is down)
  const streamCounts = new Map<
    string,
    { count: number; type: string; tmdbId?: string }
  >();
  let totalViewers = 0;

  for (const item of memoryViewerMap.values()) {
    totalViewers++;
    const existing = streamCounts.get(item.title);
    if (existing) {
      existing.count++;
    } else {
      const newItem: { count: number; type: string; tmdbId?: string } = {
        count: 1,
        type: item.type || "movie",
      };
      if (item.tmdbId) newItem.tmdbId = item.tmdbId;
      streamCounts.set(item.title, newItem);
    }
  }

  const activeStreams: Array<{
    title: string;
    count: number;
    type: string;
    tmdbId?: string;
  }> = Array.from(streamCounts.entries())
    .map(([title, val]) => {
      const entry: {
        title: string;
        count: number;
        type: string;
        tmdbId?: string;
      } = {
        title,
        count: val.count,
        type: val.type,
      };
      if (val.tmdbId) entry.tmdbId = val.tmdbId;
      return entry;
    })
    .sort((a, b) => b.count - a.count);

  return { totalViewers, activeStreams };
}
