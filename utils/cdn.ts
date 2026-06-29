const CDN_REFERER = "https://cloudnestra.com/";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36";

// Random residential IP generator for spoofing
export const randomIP = () => {
  const p = () => Math.floor(Math.random() * 255);
  let first = p();
  while ([0, 10, 127, 169, 172, 192].includes(first)) first = p();
  return `${first}.${p()}.${p()}.${p()}`;
};

export function cdnHeaders(targetUrl?: string, isManifest: boolean = false) {
  let referer = CDN_REFERER;
  let origin = new URL(CDN_REFERER).origin;
  let cookie: string | null = null;

  // Default browser headers for fetch/CORS
  const headers: any = {
    accept: "*/*",
    "accept-language": "en-US,en;q=0.7",
    "cache-control": "no-cache",
    pragma: "no-cache",
    priority: "u=1, i",
    "sec-ch-ua":
      '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": isManifest ? "empty" : "video",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "cross-site",
    "user-agent": UA,
    "x-forwarded-for": randomIP(),
    "x-real-ip": randomIP(),
  };

  if (targetUrl) {
    const lower = targetUrl.toLowerCase();

    // Extract embedded headers if present (VidLink/Storm CDNs use this for inner requests)
    try {
      const urlObj = new URL(targetUrl);
      const customHeaders = urlObj.searchParams.get("headers");
      const hostParam = urlObj.searchParams.get("host");

      if (customHeaders) {
        const parsed = JSON.parse(customHeaders);
        if (parsed.referer) referer = parsed.referer;
        if (parsed.origin) origin = parsed.origin;
        if (parsed.cookie) cookie = parsed.cookie;
      }

      // If a host param is provided, it might be the target host for the proxy
      if (hostParam) {
        // Use it only if not already set by customHeaders
        if (referer === CDN_REFERER)
          referer = hostParam.endsWith("/") ? hostParam : hostParam + "/";
        if (origin === "https://cloudnestra.com")
          origin = new URL(hostParam).origin;
      }
    } catch {}

    // Final overrides for specific providers that are extremely sensitive to outer Referer
    if (
      lower.includes("megaplay.buzz") ||
      lower.includes("anime2.filmu.in") ||
      lower.includes("hianime.filmu.in") ||
      lower.includes("rive.filmu.in") ||
      lower.includes("streamzone1.site") ||
      lower.includes("mewstream.buzz")
    ) {
      referer = "https://megaplay.buzz/";
      origin = "https://megaplay.buzz";
    } else if (lower.includes("1shows.app")) {
      referer = "https://embed.filmu.in/";
      origin = "https://embed.filmu.in";
    } else if (
      lower.includes("dzink418hun.com") &&
      lower.includes("/stream2/")
    ) {
      referer = "https://embed.filmu.in/";
      origin = isManifest ? "https://embed.filmu.in" : "null";
    } else if (
      lower.includes("ironwallnet.net") ||
      lower.includes("digitalsun.app") ||
      lower.includes("itsdeskmate.com") ||
      lower.includes("keymi417exx.com") ||
      lower.includes("goldweather.net") ||
      lower.includes("cfw557.workers.dev") ||
      lower.includes("cfw69.workers.dev") ||
      lower.includes("videasy.to") ||
      lower.includes("shegu.org") ||
      /i-cdn-\d+/.test(lower) ||
      /[a-z]{5}\d{3}[a-z]{3}\./.test(lower)
    ) {
      referer = "https://player.videasy.to/";
      origin = isManifest ? "https://player.videasy.to" : "null";
      headers["sec-fetch-dest"] = "empty";
      delete headers["x-forwarded-for"];
      delete headers["x-real-ip"];
    } else if (
      /stor+m\.site/.test(lower) ||
      lower.includes("vdrk.site") ||
      lower.includes("vidrock.ru") ||
      lower.includes("vidrock.net") ||
      lower.includes("hydrostorm") ||
      lower.includes("hellstorm.lol") ||
      lower.includes("hellstorm") ||
      lower.includes("1x2.space") ||
      lower.includes("hakunaymatata.com") ||
      lower.includes("hakunaymatata") ||
      lower.includes("workers.dev") ||
      lower.includes("tiktokcdn") ||
      lower.includes("byteoversea") ||
      lower.includes("ibyteimg")
    ) {
      referer = "https://vidrock.ru/";
      origin = "https://vidrock.ru";
    } else if (
      lower.includes("storm.vodvidl.site") ||
      lower.includes("vidlink.pro") ||
      lower.includes("nightbreeze") ||
      lower.includes("thunderleaf")
    ) {
      referer = "https://vidlink.pro/";
      origin = "https://vidlink.pro";
    } else if (
      lower.includes("onlinecoursecreator.site") ||
      lower.includes("startupfundinglab.site") ||
      lower.includes("digitalassetlaunchpad.site") ||
      lower.includes("dataanalyticsacademy.site") ||
      /\.site\/[a-z0-9]{9}\/(pl|playlist|content)/i.test(lower)
    ) {
      referer = "https://nextgencloudfabric.com/";
      origin = "https://nextgencloudfabric.com";
    }
  }

  headers["referer"] = referer;
  headers["origin"] = origin;

  if (cookie) headers["cookie"] = cookie;

  return headers;
}
