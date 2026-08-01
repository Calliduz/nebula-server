import fetch from "node-fetch";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import vm from "vm";
import { type MirrorStream, UA } from "./scraper.js";
import { extractDonutHString } from "../scratch/test_donut_polyfill.js";

const powCache = new Map<string, string>();

async function solvePoW(inputStr: string): Promise<string> {
  const wasmPath = path.join(process.cwd(), "scratch", "cinesrc_assets", "pow-v3.wasm");
  const wasmBuffer = fs.readFileSync(wasmPath);
  const wasmModule = await WebAssembly.instantiate(wasmBuffer, {});
  const instance = wasmModule.instance;
  const exports = instance.exports as any;

  const inputBytes = Buffer.from(inputStr, "utf-8");
  const ptr = exports.a(inputBytes.length);
  const memory = new Uint8Array(exports.memory.buffer);
  memory.set(inputBytes, ptr);

  const resPtr = exports.b(ptr, inputBytes.length);
  const memoryBuf = new Uint8Array(exports.memory.buffer);
  let end = resPtr;
  while (end < memoryBuf.length && memoryBuf[end] !== 0) {
    end++;
  }
  return Buffer.from(memoryBuf.subarray(resPtr, end)).toString("utf-8");
}

function solveWorkerPoW(
  publicSalt: string,
  target: string,
  difficulty: number,
  start: number,
  end: number
): string | null {
  const cacheKey = `${publicSalt}:${target}`;
  if (powCache.has(cacheKey)) {
    return powCache.get(cacheKey)!;
  }

  const maxVal = Math.pow(16, difficulty);
  const width = Math.ceil(difficulty / 4);

  for (let j = 0; j < maxVal; j++) {
    const s = j.toString(16).padStart(width, "0");
    const hash = crypto.hash("sha256", publicSalt + s);
    if (hash === target) {
      powCache.set(cacheKey, s);
      return s;
    }
  }

  for (let j = start; j <= end; j++) {
    const s = j.toString(16).padStart(width, "0");
    const hash = crypto.hash("sha256", publicSalt + s);
    if (hash === target) {
      powCache.set(cacheKey, s);
      return s;
    }
  }
  return null;
}

class SafeTextEncoder {
  native = new TextEncoder();
  encode(input?: string): Uint8Array {
    if (typeof input === "string") return this.native.encode(input);
    return this.native.encode("");
  }
}

export class CineSrcScraper {
  /**
   * Extracts stream mirrors from CineSrc (cinesrc.st) in Pure Node.js.
   * @param tmdbId TMDB ID of the content.
   * @param kind 'movie' or 'tv'.
   * @param season Season number (for TV).
   * @param episode Episode number (for TV).
   * @param signal Optional AbortSignal.
   */
  static async getStream(
    tmdbId: string,
    kind: "movie" | "tv" = "movie",
    season?: number,
    episode?: number,
    signal?: AbortSignal
  ): Promise<MirrorStream[]> {
    const mirrors: MirrorStream[] = [];
    const targetServer = "nebula";

    try {
      console.log(
        `[CineSrc] Resolving ${kind} ${tmdbId}${kind === "tv" ? ` S${season}E${episode}` : ""} (Pure Node.js)...`
      );

      const embedUrl =
        kind === "tv"
          ? `https://cinesrc.st/embed/tv/${tmdbId}?s=${season || 1}&e=${episode || 1}`
          : `https://cinesrc.st/embed/movie/${tmdbId}`;

      const queryArray =
        kind === "tv"
          ? [kind, tmdbId, season ? Number(season) : 1, episode ? Number(episode) : 1]
          : [kind, tmdbId, null, null];

      const xCsQ = Buffer.from(JSON.stringify(queryArray)).toString("base64").replace(/=+$/, "");

      const baseHeaders: Record<string, string> = {
        "User-Agent": UA,
        Origin: "https://cinesrc.st",
        Referer: "https://cinesrc.st/",
      };

      const cookies: string[] = [];
      const getCookieHeader = () => cookies.join("; ");

      const updateCookies = (res: any) => {
        const rawCookies = res.headers.raw()["set-cookie"];
        if (rawCookies && Array.isArray(rawCookies)) {
          rawCookies.forEach((c: string) => {
            const cookiePair = c.split(";")[0];
            if (cookiePair && !cookies.includes(cookiePair)) {
              cookies.push(cookiePair);
            }
          });
        }
      };

      // Step 1: GET initial page
      const initRes = await fetch(embedUrl, { headers: baseHeaders, signal: signal });
      updateCookies(initRes);

      const routerStateTree =
        kind === "tv"
          ? `%5B%22%22%2C%7B%22children%22%3A%5B%22embed%22%2C%7B%22children%22%3A%5B%5B%22type%22%2C%22tv%22%2C%22d%22%5D%2C%7B%22children%22%3A%5B%5B%22id%22%2C%22${tmdbId}%22%2C%22d%22%5D%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%2C%22%3Fs%3D${season || 1}%26e%3D${episode || 1}%22%2C%22refresh%22%5D%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%2Ctrue%5D`
          : `%5B%22%22%2C%7B%22children%22%3A%5B%22embed%22%2C%7B%22children%22%3A%5B%5B%22type%22%2C%22movie%22%2C%22d%22%5D%2C%7B%22children%22%3A%5B%5B%22id%22%2C%22${tmdbId}%22%2C%22d%22%5D%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%2Ctrue%5D`;

      // Step 1b: Action 1 POST
      const action1Res = await fetch(embedUrl, {
        method: "POST",
        headers: {
          ...baseHeaders,
          Cookie: getCookieHeader(),
          Accept: "text/x-component",
          "content-type": "text/plain;charset=UTF-8",
          "next-action": "009ae233b6f5dd27b41a46896cad785bff36e42f4d",
          "next-router-state-tree": routerStateTree,
        },
        body: JSON.stringify([]),
        signal: signal,
      });
      updateCookies(action1Res);

      // Step 2: Bootstrap fetch
      const bootRes = await fetch("https://cinesrc.st/api/c/bootstrap", {
        method: "POST",
        headers: {
          ...baseHeaders,
          Cookie: getCookieHeader(),
          Accept: "*/*",
          "x-cs-q": xCsQ,
        },
        signal: signal,
      });
      updateCookies(bootRes);

      const bootData: any = await bootRes.json();
      if (!bootData || !bootData.r) throw new Error("CineSrc bootstrap failed");

      // Load Assets
      const assetsDir = path.join(process.cwd(), "scratch", "cinesrc_assets");
      const burgerJsCode = fs.readFileSync(path.join(assetsDir, "burger.js"), "utf-8");
      const prod130626Code = fs.readFileSync(path.join(assetsDir, "130626-prod.js"), "utf-8");
      const donutJsCode = fs.readFileSync(path.join(assetsDir, "donut.js"), "utf-8");
      const stringH = extractDonutHString(donutJsCode);

      const contextObject: any = {
        console: console,
        atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
        btoa: (s: string) => Buffer.from(s, "binary").toString("base64"),
        TextDecoder: TextDecoder,
        TextEncoder: SafeTextEncoder,
        NativeURL: URL,
        URLSearchParams: URLSearchParams,
        Buffer: Buffer,
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
        setImmediate: setImmediate,
        clearImmediate: clearImmediate,
        crypto: crypto.webcrypto,
        WebAssembly: WebAssembly,
        performance: performance,
        __nativeSolveWorkerPoW: solveWorkerPoW,
        __nativeSolveWasmPoW: solvePoW,
        __bootData: bootData,
        __xCsQ: xCsQ,
        __baseHeaders: baseHeaders,
        __nativeNodeFetch: fetch,
        __getCookieHeader: getCookieHeader,
      };

      const ctx = vm.createContext(contextObject);

      vm.runInContext(
        `
        let d6KeyName = "";

        function CustomEvent(type, params) {
          this.type = type;
          this.detail = params ? params.detail : undefined;
        }

        function MockBlob(parts, options) { this.parts = parts; }

        function MockWorker(url) {
          this.onmessage = null;
          var selfWorker = this;
          this.postMessage = function(data) {
            if (typeof data === "string" && data.includes("|")) {
              __nativeSolveWasmPoW(data).then(function(solution) {
                if (typeof selfWorker.onmessage === "function") {
                  selfWorker.onmessage({ data: solution });
                }
              });
            } else if (Array.isArray(data) && data.length >= 5) {
              const solution = __nativeSolveWorkerPoW(data[0], data[1], data[2], data[3], data[4]);
              if (typeof selfWorker.onmessage === "function") {
                setImmediate(function() {
                  selfWorker.onmessage({ data: { solution: solution } });
                });
              }
            } else if (data && typeof data === "object") {
              if (data.work) {
                __nativeSolveWasmPoW(data.work).then(function(solution) {
                  if (typeof selfWorker.onmessage === "function") {
                    selfWorker.onmessage({ data: { id: data.id, solution: solution, result: solution } });
                  }
                });
              } else {
                const salt = data.publicSalt || data.salt || data.s || data[0];
                const target = data.target || data.t || data[1];
                const diff = data.difficulty || data.d || data[2] || 4;
                const start = data.start || data.st || data[3] || 0;
                const end = data.end || data.e || data[4] || 16777215;

                if (salt && target) {
                  const solution = __nativeSolveWorkerPoW(salt, target, diff, start, end);
                  if (typeof selfWorker.onmessage === "function") {
                    setImmediate(function() {
                      selfWorker.onmessage({ data: { id: data.id, solution: solution, result: solution } });
                    });
                  }
                }
              }
            }
          };
          this.terminate = function() {};
          this.addEventListener = function(event, fn) { if (event === "message") selfWorker.onmessage = fn; };
        }

        function createDummyContext() {
          const baseCtx = {
            canvas: mockElement,
            getImageData: function(x, y, w, h) {
              const data = new Uint8ClampedArray(w * h * 4);
              for (let i = 0; i < data.length; i += 4) {
                data[i] = 255; data[i + 1] = 0; data[i + 2] = 128; data[i + 3] = 255;
              }
              return { data: data, width: w, height: h };
            },
            createImageData: function(w, h) { return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }; },
            measureText: function(text) { return { width: text ? text.length * 10 : 100, actualBoundingBoxAscent: 10, actualBoundingBoxDescent: 2 }; },
            createLinearGradient: function() { return { addColorStop: function() {} }; },
            createRadialGradient: function() { return { addColorStop: function() {} }; },
            getParameter: function(p) {
              if (p === 37445) return "Google Inc. (NVIDIA)";
              if (p === 37446) return "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)";
              if (p === 7936) return "WebKit";
              if (p === 7937) return "WebKit WebGL";
              if (p === 35661) return 32;
              if (p === 34076) return 16384;
              if (p === 34930) return 16384;
              return "WebGL 1.0";
            },
            getExtension: function(ext) {
              if (ext === "WEBGL_debug_renderer_info") {
                return { UNMASKED_VENDOR_WEBGL: 37445, UNMASKED_RENDERER_WEBGL: 37446 };
              }
              return null;
            },
            getShaderPrecisionFormat: function() { return { precision: 23, rangeMin: 127, rangeMax: 127 }; },
            getSupportedExtensions: function() {
              return [
                "ANGLE_instanced_arrays", "EXT_blend_minmax", "EXT_color_buffer_half_float",
                "EXT_float_blend", "EXT_frag_depth", "EXT_shader_texture_lod",
                "EXT_texture_compression_bptc", "EXT_texture_compression_rgtc",
                "EXT_texture_filter_anisotropic", "WEBGL_color_buffer_float",
                "WEBGL_compressed_texture_s3tc", "WEBGL_debug_renderer_info",
                "WEBGL_debug_shaders", "WEBGL_depth_texture", "WEBGL_draw_buffers",
                "WEBGL_lose_context", "WEBGL_multi_draw"
              ];
            }
          };
          return new Proxy(baseCtx, {
            get: function(target, prop) {
              if (prop in target) return target[prop];
              if (typeof prop === "symbol") return undefined;
              return function() { return 0; };
            }
          });
        }

        const mockElement = {
          getContext: function() { return createDummyContext(); },
          toDataURL: function() { return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="; },
          getBoundingClientRect: function() { return { top: 0, left: 0, width: 1920, height: 1080, x: 0, y: 0 }; },
          style: {}
        };

        const origDefineProperty = Object.defineProperty;
        Object.defineProperty = function(obj, prop, desc) {
          if (obj === globalThis.window || obj === globalThis) {
            if (typeof prop === "string" && prop.startsWith("_")) {
              if (desc && desc.value && typeof desc.value.dr === "function") {
                globalThis.__d6Object = desc.value;
              }
            }
          }
          return origDefineProperty.call(this, obj, prop, desc);
        };

        const baseGlobal = globalThis;
        const globalProxy = new Proxy(baseGlobal, {
          get: function(target, prop) {
            if (prop in target) return target[prop];
            if (typeof prop === "symbol") return undefined;
            return function() { return null; };
          }
        });

        globalThis.window = globalProxy;
        globalThis.self = globalProxy;
        globalThis.global = globalProxy;

        globalThis.outerWidth = 1920;
        globalThis.outerHeight = 1040;
        globalThis.innerWidth = 1920;
        globalThis.innerHeight = 969;
        globalThis.devicePixelRatio = 1;
        globalThis.screenX = 0;
        globalThis.screenY = 0;

        globalThis.crypto = crypto;
        globalThis.performance = performance;
        globalThis.Worker = MockWorker;
        globalThis.Blob = MockBlob;
        globalThis.CustomEvent = CustomEvent;

        function MockNode() {}
        function MockElement() {}
        MockElement.prototype = Object.create(MockNode.prototype);
        function MockHTMLElement() {}
        MockHTMLElement.prototype = Object.create(MockElement.prototype);
        function MockHTMLCanvasElement() {}
        MockHTMLCanvasElement.prototype = Object.create(MockHTMLElement.prototype);
        function MockHTMLDivElement() {}
        MockHTMLDivElement.prototype = Object.create(MockHTMLElement.prototype);
        function MockHTMLSpanElement() {}
        MockHTMLSpanElement.prototype = Object.create(MockHTMLElement.prototype);
        function MockHTMLImageElement() {}
        MockHTMLImageElement.prototype = Object.create(MockHTMLElement.prototype);

        globalThis.Node = MockNode;
        globalThis.Element = MockElement;
        globalThis.HTMLElement = MockHTMLElement;
        globalThis.HTMLCanvasElement = MockHTMLCanvasElement;
        globalThis.HTMLDivElement = MockHTMLDivElement;
        globalThis.HTMLSpanElement = MockHTMLSpanElement;
        globalThis.HTMLImageElement = MockHTMLImageElement;
        globalThis.Image = MockHTMLImageElement;

        function MockAudioContext() {
          this.state = "running";
          this.sampleRate = 44100;
          this.baseLatency = 0.005333333333333333;
          this.outputLatency = 0;
          this.createOscillator = function() {
            return { connect: function() {}, start: function() {}, stop: function() {}, frequency: { value: 440 } };
          };
          this.createDynamicsCompressor = function() {
            return {
              threshold: { value: -24 }, knee: { value: 30 }, ratio: { value: 12 },
              reduction: { value: 0 }, attack: { value: 0.003 }, release: { value: 0.25 },
              connect: function() {}
            };
          };
          this.destination = { channelCount: 2, channelCountMode: "explicit", channelInterpretation: "speakers", maxChannelCount: 2 };
          this.startRendering = function() {
            const buffer = {
              numberOfChannels: 1, length: 44100, sampleRate: 44100,
              getChannelData: function() {
                const data = new Float32Array(44100);
                for (let i = 0; i < data.length; i++) data[i] = Math.sin(i * 0.1);
                return data;
              }
            };
            return Promise.resolve(buffer);
          };
        }
        globalThis.AudioContext = MockAudioContext;
        globalThis.webkitAudioContext = MockAudioContext;
        globalThis.OfflineAudioContext = MockAudioContext;

        function MockURL(url, base) { return new NativeURL(url, base); }
        MockURL.createObjectURL = function() { return "blob:fast-worker"; };
        MockURL.revokeObjectURL = function() {};
        globalThis.URL = MockURL;
        globalThis.getComputedStyle = function() {
          return { getPropertyValue: function() { return ""; } };
        };
        globalThis.requestAnimationFrame = function(cb) { return setTimeout(cb, 16); };
        globalThis.cancelAnimationFrame = function(id) { clearTimeout(id); };

        var cookieStore = {};
        const baseDocument = {
          createElement: function(tag) { return mockElement; },
          querySelector: function() { return null; },
          querySelectorAll: function() { return []; },
          getElementsByTagName: function() { return [mockElement]; },
          getElementsByClassName: function() { return []; },
          getElementById: function() { return mockElement; },
          head: { appendChild: function() {}, insertBefore: function() {} },
          body: { appendChild: function() {}, insertBefore: function() {} },
          addEventListener: function() {},
          removeEventListener: function() {},
          hasFocus: function() { return true; },
          createEvent: function() { return new CustomEvent(""); },
          location: globalThis.location,
          referrer: "https://cinesrc.st/",
          domain: "cinesrc.st",
        };

        Object.defineProperty(baseDocument, "cookie", {
          get: function() {
            return Object.entries(cookieStore).map(([k, v]) => k + "=" + v).join("; ");
          },
          set: function(val) {
            if (!val || typeof val !== "string") return;
            const pair = val.split(";")[0].trim();
            const eqIdx = pair.indexOf("=");
            if (eqIdx > 0) {
              const k = pair.slice(0, eqIdx).trim();
              const v = pair.slice(eqIdx + 1).trim();
              cookieStore[k] = v;
            }
          }
        });

        globalThis.document = new Proxy(baseDocument, {
          get: function(target, prop) {
            if (prop in target) return target[prop];
            if (typeof prop === "symbol") return undefined;
            return function() { return null; };
          }
        });

        globalThis.screen = { width: 1920, height: 1080, colorDepth: 24 };
        const baseNavigator = {
          userAgent: ${JSON.stringify(UA)},
          language: "en-US",
          languages: ["en-US", "en"],
          platform: "Win32",
          cookieEnabled: true,
          hardwareConcurrency: 8,
          deviceMemory: 8,
          maxTouchPoints: 0,
          vendor: "Google Inc.",
          onLine: true,
        };

        globalThis.navigator = new Proxy(baseNavigator, {
          get: function(target, prop) {
            if (prop in target) return target[prop];
            if (typeof prop === "symbol") return undefined;
            return function() { return null; };
          }
        });

        globalThis.localStorage = { getItem: function() { return null; }, setItem: function() {}, removeItem: function() {} };
        globalThis.sessionStorage = { getItem: function() { return null; }, setItem: function() {}, removeItem: function() {} };
        
        const parsedLoc = new URL(${JSON.stringify(embedUrl)});
        globalThis.location = {
          href: ${JSON.stringify(embedUrl)},
          origin: "https://cinesrc.st",
          pathname: parsedLoc.pathname,
          search: parsedLoc.search,
          hash: "",
          host: "cinesrc.st",
          hostname: "cinesrc.st",
          port: "",
          protocol: "https:",
          toString: function() { return embedUrl; }
        };

        globalThis.addEventListener = function(type, listener, opts) {};
        globalThis.removeEventListener = function() {};
        globalThis.dispatchEvent = function(evt) {
          if (evt && evt.type === "_cs") {
            globalThis.d6KeyName = evt.detail;
          }
          return true;
        };

        globalThis.fetch = function(url, init) {
          let fullUrl = typeof url === "string" ? url : (url.url || String(url));
          if (fullUrl.startsWith("/")) fullUrl = "https://cinesrc.st" + fullUrl;

          let headers = Object.assign({}, __baseHeaders);
          const cookieStr = __getCookieHeader();
          if (cookieStr) headers["Cookie"] = cookieStr;

          if (init && init.headers) {
            if (typeof init.headers.forEach === "function") {
              init.headers.forEach((v, k) => { headers[k] = v; });
            } else {
              Object.assign(headers, init.headers);
            }
          }

          return new Promise(function(resolve, reject) {
            var options = {
              method: (init && init.method) || "GET",
              headers: headers,
            };
            if (init && init.body) options.body = init.body;

            __nativeNodeFetch(fullUrl, options).then(function(res) {
              resolve({
                ok: res.ok,
                status: res.status,
                headers: { get: function(h) { return res.headers.get(h); } },
                json: function() { return res.json(); },
                text: function() { return res.text(); },
                arrayBuffer: function() {
                  return res.arrayBuffer().then(function(ab) {
                    const u8 = new Uint8Array(ab);
                    const buf = new ArrayBuffer(u8.length);
                    new Uint8Array(buf).set(u8);
                    return buf;
                  });
                },
                blob: function() { return res.blob(); }
              });
            }).catch(reject);
          });
        };
      `,
        ctx
      );

      // Evaluate telemetry scripts
      vm.runInContext(burgerJsCode, ctx);
      vm.runInContext(prod130626Code, ctx);

      vm.runInContext(
        `
        var i = {
          h: ${JSON.stringify(stringH)},
          i: function(a, b) { return i.h.slice(a, a + b); }
        };
      `,
        ctx
      );

      vm.runInContext(donutJsCode, ctx);

      // Hook fetch headers
      vm.runInContext(
        `
        var d = __bootData.r;
        var h = __bootData.p;
        var l = __xCsQ;

        var c = window.fetch;
        var f = c.bind(window);

        var g = function(e, t) {
          var i = typeof e === "string" || e instanceof URL ? String(e) : e.url;
          var r = new URL(i, "https://cinesrc.st");
          if (r.origin === "https://cinesrc.st" && (r.pathname === "/api/c/issue" || r.pathname === "/api/c/stage2/issue")) {
            var headers = {};
            if (t && t.headers) {
              if (typeof t.headers.forEach === "function") {
                t.headers.forEach((v, k) => { headers[k] = v; });
              } else {
                Object.assign(headers, t.headers);
              }
            }
            headers["x-cs-r"] = d;
            headers["x-cs-q"] = l;
            if (r.pathname === "/api/c/issue") {
              headers["x-cs-p"] = h;
            }
            return f(e, Object.assign({}, t, { headers: headers }));
          }
          return f(e, t);
        };

        window.fetch = g;
      `,
        ctx
      );

      const d6Key = ctx.d6KeyName;
      const sec1Token = await vm.runInContext(`window[${JSON.stringify(d6Key)}].gc()`, ctx);
      const sec2Token = await vm.runInContext(`window.__ss2_challenge.gc()`, ctx);

      const fullToken = `${sec1Token}::c2::${sec2Token}::c3::${bootData.r}`;

      const postBody =
        kind === "tv"
          ? [tmdbId, kind, season ? Number(season) : 1, episode ? Number(episode) : 1, fullToken, targetServer]
          : [tmdbId, kind, "$undefined", "$undefined", fullToken, targetServer];

      const actionHeaders: Record<string, string> = {
        "User-Agent": UA,
        Origin: "https://cinesrc.st",
        Referer: embedUrl,
        Cookie: getCookieHeader(),
        Accept: "text/x-component",
        "content-type": "text/plain;charset=UTF-8",
        "next-action": "7ee2ce6e276d24a29d32ee843aa18f1560caba9034",
        "next-router-state-tree": routerStateTree,
      };

      const streamRes = await fetch(embedUrl, {
        method: "POST",
        headers: actionHeaders,
        body: JSON.stringify(postBody),
        signal: signal,
      });

      const resultText = await streamRes.text();
      console.log("[CineSrc Debug] Action 2 status:", streamRes.status, "Length:", resultText.length, "Snippet:", resultText.slice(0, 200));
      const lines = resultText.split("\n");
      const r2Line = lines.find((l) => l.includes("r2."));

      if (r2Line) {
        const colonIdx = r2Line.indexOf(":");
        let encPayload = "";
        if (colonIdx >= 0) {
          try {
            encPayload = JSON.parse(r2Line.slice(colonIdx + 1));
          } catch (e) {
            encPayload = r2Line.slice(r2Line.indexOf("r2.")).replace(/"$/, "");
          }
        } else {
          encPayload = r2Line.slice(r2Line.indexOf("r2.")).replace(/"$/, "");
        }

        const decrypted = await vm.runInContext(
          `
          (async function() {
            if (globalThis.__d6Object && typeof globalThis.__d6Object.dr === "function") {
              return await globalThis.__d6Object.dr(${JSON.stringify(encPayload)});
            }
            return null;
          })()
        `,
          ctx
        );

        if (decrypted && decrypted.url) {
          const rawUrls = decrypted.url;
          const urls = Array.isArray(rawUrls) ? rawUrls : rawUrls ? [rawUrls] : [];

          for (const item of urls) {
            if (item && item.url) {
              const serverName = item.hash || item.name || item.id || "CineSrc";
              mirrors.push({
                url: item.url,
                source: `cinesrc-${serverName.toLowerCase()}`,
                quality: "1080p",
                type: "hls",
                headers: {
                  Referer: "https://cinesrc.st/",
                  "User-Agent": UA,
                },
              });
            }
          }
        }
      }
    } catch (err: any) {
      console.error("[CineSrc] Pure Node.js scraper error:", err.stack || err.message);
    }

    return mirrors;
  }
}
