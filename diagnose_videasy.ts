import { gotScraping } from "got-scraping";
import dotenv from "dotenv";
import { fetchWithCycleTLS, shutdownCycleTLS } from "./utils/bypass.js";

dotenv.config();

const url = "https://api.videasy.to/cdn/sources-with-title?title=The%2520Boys&mediaType=tv&year=2019&episodeId=2&seasonId=1&tmdbId=76479&imdbId=tt1190634";

async function runDiagnostics() {
  console.log("=== DIAGNOSTIC START ===");

  // Test 1: Native Fetch with basic headers
  try {
    console.log("\n[Test 1] Native Fetch (Current Implementation headers)...");
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
        Referer: "https://player.videasy.to/",
        Origin: "https://player.videasy.to",
      }
    });
    console.log(`Response Status: ${res.status} ${res.statusText}`);
    const text = await res.text();
    console.log(`Body Length: ${text.length}`);
    console.log(`Snippet: ${text.substring(0, 100)}`);
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
  }

  // Test 2: Native Fetch with exact browser headers
  try {
    console.log("\n[Test 2] Native Fetch (Exact Browser Headers)...");
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.5",
        "origin": "https://player.videasy.to",
        "referer": "https://player.videasy.to/",
        "sec-ch-ua": '"Brave";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-site",
        "sec-gpc": "1",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
      }
    });
    console.log(`Response Status: ${res.status} ${res.statusText}`);
    const text = await res.text();
    console.log(`Body Length: ${text.length}`);
    console.log(`Snippet: ${text.substring(0, 100)}`);
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
  }

  // Test 3: got-scraping with exact browser headers
  try {
    console.log("\n[Test 3] got-scraping (Spoofed TLS Fingerprint + Browser Headers)...");
    const res = await gotScraping.get(url, {
      headers: {
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.5",
        "origin": "https://player.videasy.to",
        "referer": "https://player.videasy.to/",
        "sec-ch-ua": '"Brave";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-site",
        "sec-gpc": "1",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
      }
    });
    console.log(`Response Status: ${res.statusCode}`);
    console.log(`Body Length: ${res.body.length}`);
    console.log(`Snippet: ${res.body.substring(0, 100)}`);
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
  }

  // Test 4: Native Fetch via Cloudflare Worker Proxy
  try {
    const proxyBase = process.env.VIDEASY_PROXY_URL || "https://dreadnought.47qzoobg8k.workers.dev";
    console.log(`\n[Test 4] Native Fetch via Cloudflare Worker Proxy (${proxyBase})...`);
    const proxyUrl = `${proxyBase.replace(/\/$/, "")}/?url=${encodeURIComponent(url)}`;
    const res = await fetch(proxyUrl, {
      method: "GET",
      headers: {
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.5",
        "origin": "https://player.videasy.to",
        "referer": "https://player.videasy.to/",
        "sec-ch-ua": '"Brave";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-site",
        "sec-gpc": "1",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
      }
    });
    console.log(`Response Status: ${res.status} ${res.statusText}`);
    const text = await res.text();
    console.log(`Body Length: ${text.length}`);
    console.log(`Snippet: ${text.substring(0, 100)}`);
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
  }

  // Test 5: CycleTLS (JA3 Fingerprint + Spoofed IPs)
  try {
    console.log("\n[Test 5] CycleTLS (JA3 Fingerprint + Spoofed IPs)...");
    const res = await fetchWithCycleTLS(url, {
      "accept": "*/*",
      "accept-language": "en-US,en;q=0.5",
      "origin": "https://player.videasy.to",
      "referer": "https://player.videasy.to/",
      "sec-ch-ua": '"Brave";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-site",
      "sec-gpc": "1",
    });
    console.log(`Response Status: ${res.statusCode}`);
    const text = res.body.toString("utf-8");
    console.log(`Body Length: ${text.length}`);
    console.log(`Snippet: ${text.substring(0, 100)}`);
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
  } finally {
    await shutdownCycleTLS();
  }
}

runDiagnostics();

