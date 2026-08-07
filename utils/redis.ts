import Redis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";
const KEY_PREFIX = "nebula:proxy:";
const DEFAULT_TTL_SECONDS = 10 * 60; // 10 minutes

let isConnected = false;

export const redis = new Redis(REDIS_URL, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  retryStrategy(times) {
    // Retry connection every 5 seconds, up to 10 attempts
    if (times > 10) return null;
    return Math.min(times * 500, 5000);
  },
});

redis.on("connect", () => {
  isConnected = true;
  console.log(`[REDIS] ✅ Connected to ${REDIS_URL}`);
});

redis.on("error", (err) => {
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
