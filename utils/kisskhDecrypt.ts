/**
 * KissKH Subtitle Decryptor
 * ─────────────────────────
 * Decrypts AES-128-CBC encrypted subtitle cues from KissKH drama files.
 * Keys are loaded from data/kisskh-keys.json for easy rotation.
 *
 * See docs/KISSKH_KEYS.md for the key rotation guide.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ── Types ────────────────────────────────────────────────────────────────────

interface KeyEntry {
  key: string;
  iv: string;
  ivFormat: 'utf8' | 'wordarray';
}

interface KeyConfig {
  a1: KeyEntry;
  a2: KeyEntry;
  a3: KeyEntry;
  extensionMap: Record<string, string>;
}

// ── Key Loading ──────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY_FILE = path.resolve(__dirname, '..', 'data', 'kisskh-keys.json');

let keyConfig: KeyConfig | null = null;

function loadKeys(): KeyConfig {
  try {
    const raw = fs.readFileSync(KEY_FILE, 'utf-8');
    keyConfig = JSON.parse(raw) as KeyConfig;
    console.log('[KISSKH/DECRYPT] ✔ Loaded decryption keys from', KEY_FILE);
    return keyConfig;
  } catch (e: any) {
    console.error('[KISSKH/DECRYPT] ✘ Failed to load keys:', e.message);
    throw new Error('KissKH decryption keys not found. See docs/KISSKH_KEYS.md');
  }
}

function getKeys(): KeyConfig {
  if (!keyConfig) return loadKeys();
  return keyConfig;
}

// Reload keys on file change (hot-reload without restart)
try {
  fs.watchFile(KEY_FILE, { interval: 30000 }, () => {
    console.log('[KISSKH/DECRYPT] 🔄 Key file changed, reloading...');
    try {
      loadKeys();
    } catch {}
  });
} catch {}

// ── IV Resolution ────────────────────────────────────────────────────────────

function resolveIV(entry: KeyEntry): Buffer {
  if (entry.ivFormat === 'utf8') {
    return Buffer.from(entry.iv, 'utf-8');
  }

  // WordArray format: Base64 → JSON → {iv: {words: number[], sigBytes: number}}
  const json = JSON.parse(Buffer.from(entry.iv, 'base64').toString('utf-8'));
  const words: number[] = json.iv.words;
  const sigBytes: number = json.iv.sigBytes;

  const buf = Buffer.alloc(sigBytes);
  for (let i = 0; i < words.length && i * 4 < sigBytes; i++) {
    buf.writeInt32BE(words[i] as number, i * 4);
  }
  return buf;
}

// ── Single Line Decryption ───────────────────────────────────────────────────

function decryptLine(base64Text: string, keyEntry: KeyEntry): string {
  const key = Buffer.from(keyEntry.key, 'utf-8');
  const iv = resolveIV(keyEntry);
  const ciphertext = Buffer.from(base64Text, 'base64');

  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  let decrypted = decipher.update(ciphertext);
  decrypted = Buffer.concat([decrypted, decipher.final()]);

  return decrypted.toString('utf-8');
}

// ── Method Selection ─────────────────────────────────────────────────────────

function pickMethod(fileUrl: string): string {
  const config = getKeys();
  let ext = 'default';

  try {
    const urlObj = new URL(fileUrl);
    const pathname = urlObj.pathname;
    const lastDot = pathname.lastIndexOf('.');
    if (lastDot >= 0) {
      ext = pathname.substring(lastDot).toLowerCase();
    }
  } catch (e) {
    // Fallback if URL parsing fails
    const cleanUrl = fileUrl.split('?')[0].split('#')[0];
    const lastDot = cleanUrl.lastIndexOf('.');
    if (lastDot >= 0) {
      ext = cleanUrl.substring(lastDot).toLowerCase();
    }
  }

  console.log(`[KISSKH/DECRYPT] Extracted extension: ${ext} for decryption`);
  return config.extensionMap[ext] || config.extensionMap['default'] || 'a3';
}

// ── Full Subtitle Decryption ─────────────────────────────────────────────────

/**
 * Decrypts an encrypted KissKH subtitle file.
 * Input: raw SRT-format text with encrypted cue bodies.
 * Output: clean SRT text with decrypted cue bodies.
 */
export function decryptKissKHSubtitle(rawSrt: string, fileUrl: string): string {
  const config = getKeys();
  const methodName = pickMethod(fileUrl);
  const keyEntry = (config as any)[methodName] as KeyEntry;

  if (!keyEntry) {
    console.error(`[KISSKH/DECRYPT] Unknown method: ${methodName}`);
    return rawSrt;
  }

  const lines = rawSrt.replace(/\r\n/g, '\n').split('\n');
  const output: string[] = [];
  let decryptedCount = 0;
  let failedCount = 0;

  console.log(`[KISSKH/DECRYPT] Processing ${lines.length} lines with method ${methodName}...`);

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === '') {
      output.push(line);
      continue;
    }

    // Pass through SRT markers
    if (/^\d+$/.test(trimmed) || /^\d{2}:\d{2}:\d{2}/.test(trimmed)) {
      output.push(line);
      continue;
    }

    // Attempt decryption
    try {
      // Basic check: if it's not base64-like, skip
      if (!/^[a-zA-Z0-9+/=]+$/.test(trimmed) || trimmed.length < 8) {
        output.push(line);
        continue;
      }

      const plaintext = decryptLine(trimmed, keyEntry);
      if (plaintext && plaintext.length > 0) {
        const cleaned = plaintext.replace(/\{\\an\d+\}/g, '').trim();
        output.push(cleaned);
        decryptedCount++;
      } else {
        output.push(line);
        failedCount++;
      }
    } catch (e: any) {
      // console.log(`[KISSKH/DECRYPT] Line decryption failed: ${e.message} for line: ${trimmed.substring(0, 20)}...`);
      output.push(line);
      failedCount++;
    }
  }

  console.log(`[KISSKH/DECRYPT] ✔ Decrypted ${decryptedCount} cues, ${failedCount} skipped/failed`);
  return output.join('\n');
}

/**
 * Checks if a URL points to a KissKH subtitle file.
 */
export function isKissKHSubtitleUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return lower.includes('kisskh') || 
         lower.includes('k-i-s-s-k-h') || 
         lower.includes('sub.kisskh') || 
         lower.includes('cdnvideo') || 
         lower.includes('streamcdn');
}

// Initialize keys on module load
try {
  loadKeys();
} catch {}
