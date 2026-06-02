import test from "node:test";
import assert from "node:assert/strict";

const BASE_URL = "http://localhost:4000";

test("Health Check Endpoints", async (t) => {
  await t.test("GET /health returns 200 OK and status: ok", async () => {
    const res = await fetch(`${BASE_URL}/health`);
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.equal(data.status, "ok");
    assert.ok(data.timestamp);
  });

  await t.test("GET /api/health returns 200 OK and status: ok", async () => {
    const res = await fetch(`${BASE_URL}/api/health`);
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    assert.equal(data.status, "ok");
    assert.ok(data.timestamp);
  });
});

test("Download APIs", async (t) => {
  await t.test("GET /api/download for movie (Fight Club - 550)", async () => {
    const res = await fetch(`${BASE_URL}/api/download?tmdbId=550&type=movie`);
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    
    assert.ok(data.imdbId, "Payload should contain imdbId");
    assert.equal(data.imdbId, "tt0137523", "IMDB ID of Fight Club should match");
    assert.ok(Array.isArray(data.torrents), "Torrents should be an array");
    assert.ok(data.torrents.length > 0, "Should find at least one torrent for Fight Club");
    
    // Check fields on first torrent
    const torrent = data.torrents[0];
    assert.ok(torrent.quality, "Torrent should have quality");
    assert.ok(torrent.size, "Torrent should have size");
    assert.ok(torrent.magnet, "Torrent should have magnet link");
    assert.ok(torrent.source, "Torrent should have source provider label");
    
    console.log(`Found ${data.torrents.length} torrents for Fight Club. First source: ${torrent.source}`);
  });

  await t.test("GET /api/download/episode for TV show (Game of Thrones - 1399, S1E1)", async () => {
    const res = await fetch(`${BASE_URL}/api/download/episode?tmdbId=1399&season=1&episode=1`);
    assert.equal(res.status, 200);
    const data = await res.json() as any;
    
    assert.ok(Array.isArray(data.torrents), "Torrents should be an array");
    assert.ok(data.torrents.length > 0, "Should find backup episode torrents for GoT S1E1");
    
    const torrent = data.torrents[0];
    assert.ok(torrent.title, "Episode torrent should have title");
    assert.ok(torrent.size, "Episode torrent should have size");
    assert.ok(torrent.magnet, "Episode torrent should have magnet link");
    assert.ok(torrent.source, "Episode torrent should have source provider label");
    
    console.log(`Found ${data.torrents.length} backup streams for Game of Thrones S1E1. First source: ${torrent.source}`);
  });
});
