const CDN_REFERER = "https://vidnest.fun/";
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
  let origin: string | null = new URL(CDN_REFERER).origin;
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
        const findKey = (obj: any, key: string) => {
          const lowerKey = key.toLowerCase();
          const foundKey = Object.keys(obj).find(
            (k) => k.toLowerCase() === lowerKey,
          );
          return foundKey ? obj[foundKey] : undefined;
        };
        const refVal = findKey(parsed, "referer");
        const origVal = findKey(parsed, "origin");
        const cookieVal = findKey(parsed, "cookie");
        const uaVal = findKey(parsed, "user-agent");

        if (refVal) referer = refVal;
        if (origVal) origin = origVal;
        if (cookieVal) cookie = cookieVal;
        if (uaVal) headers["user-agent"] = uaVal;
      }

      // If a host param is provided, it might be the target host for the proxy
      if (hostParam) {
        // Use it only if not already set by customHeaders
        if (referer === CDN_REFERER)
          referer = hostParam.endsWith("/") ? hostParam : hostParam + "/";
        if (origin === new URL(CDN_REFERER).origin)
          origin = new URL(hostParam).origin;
      }
    } catch {}

    if (
      lower.includes("eat-peach.sbs") ||
      lower.includes("peachify.pro") ||
      lower.includes("ergfwsarytrgfftsj.workers.dev") ||
      lower.includes("wispy-waterfall")
    ) {
      referer = "https://peachify.pro/";
      origin = "https://peachify.pro";
      delete headers["x-forwarded-for"];
      delete headers["x-real-ip"];
    } else if (
      lower.includes("megaplay.buzz") ||
      lower.includes("nekostream.site") ||
      lower.includes("lostproject.club") ||
      lower.includes("cloudvideo.lat") ||
      lower.includes("cloudbuzz.lol") ||
      lower.includes("livedns.my") ||
      lower.includes("watching.onl") ||
      lower.includes("vidwish.live") ||
      lower.includes("anime2.filmu.in") ||
      lower.includes("hianime.filmu.in") ||
      lower.includes("rive.filmu.in") ||
      lower.includes("streamzone1.site") ||
      lower.includes("mewstream.buzz") ||
      lower.includes("zapora.buzz") ||
      lower.includes("glimmeron.click")
    ) {
      referer = "https://megaplay.buzz/";
      origin = "https://megaplay.buzz";
      delete headers["x-forwarded-for"];
      delete headers["x-real-ip"];
    } else if (
      lower.includes("bingr") ||
      lower.includes("kunt3490.workers.dev")
    ) {
      referer = "https://bingr.one/";
      origin = "https://bingr.one";
      headers["user-agent"] =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36";
      headers["sec-ch-ua"] =
        '"Not;A=Brand";v="8", "Chromium";v="150", "Brave";v="150"';
      headers["sec-ch-ua-mobile"] = "?0";
      headers["sec-ch-ua-platform"] = '"Windows"';
      headers["accept-encoding"] = "identity;q=1, *;q=0";
      headers["sec-gpc"] = "1";
      headers["accept-language"] = "en-US,en;q=0.6";
      delete headers["x-forwarded-for"];
      delete headers["x-real-ip"];
    } else if (
      // Vidnest Prime / Catflix worker proxies
      lower.includes("vidnest-1.workers.dev") ||
      lower.includes("vidnest-2.workers.dev") ||
      lower.includes("vidnest-3.workers.dev") ||
      lower.includes("vidnest-4.workers.dev") ||
      lower.includes("vudnest-4.workers.dev") ||
      lower.includes("vidness-1.workers.dev") ||
      lower.includes("vidnestt.workers.dev") ||
      lower.includes("vidnests22-e71.workers.dev") ||
      lower.includes("vidnees.workers.dev") ||
      lower.includes("patient-flower-33aa")
    ) {
      referer = "https://vidnest.fun/";
      origin = "https://vidnest.fun";
      delete headers["x-forwarded-for"];
      delete headers["x-real-ip"];
    } else if (lower.includes("filmu")) {
      referer = "https://embed.filmu.in/";
      origin = "https://embed.filmu.in";
      delete headers["x-forwarded-for"];
      delete headers["x-real-ip"];
    } else if (
      lower.includes("dzink418hun.com") &&
      lower.includes("/stream2/")
    ) {
      referer = "https://embed.filmu.in/";
      origin = isManifest ? "https://embed.filmu.in" : "null";
    } else if (
      lower.includes("goodstream.cc") ||
      lower.includes("tripplestream.online") ||
      lower.includes("letsgocdn") ||
      lower.includes("technologyknowledge.site")
    ) {
      referer = "https://goodstream.cc/";
      origin = "https://goodstream.cc";
      delete headers["x-forwarded-for"];
      delete headers["x-real-ip"];
    } else if (
      // Vidnest Videasy proxy
      lower.includes("tiktoks.animanga.fun")
    ) {
      referer = "https://tiktoks.animanga.fun/";
      origin = "https://tiktoks.animanga.fun";
    } else if (
      lower.includes("upcloud.animanga.fun") ||
      lower.includes("megacloud.animanga.fun") ||
      lower.includes("animanga.fun")
    ) {
      referer = "https://vidnest.fun/";
      origin = "https://vidnest.fun";
    } else if (
      // Vidnest AllMovies CDN
      lower.includes("laika422mon.com") ||
      lower.includes("kriss424did.com")
    ) {
      referer = "https://vidnest.fun/";
      origin = "https://vidnest.fun";
      delete headers["x-forwarded-for"];
      delete headers["x-real-ip"];
    } else if (
      // Vidnest MoviesAPI / KlikXXI CDN (aurorion family)
      lower.includes("brionix.cyou") ||
      lower.includes("pinepathcreativecollect.space") ||
      lower.includes("halcyoncreative.site") ||
      lower.includes("aurorionmarketing.sbs") ||
      lower.includes("mindspireconsulting.sbs") ||
      lower.includes("aurorionacademy.site") ||
      lower.includes("auroramedialimited.space") ||
      lower.includes("aurorafabrication.space") ||
      lower.includes("digitalfuture.cyou") ||
      lower.includes("lyverra.cyou") ||
      lower.includes("lavonadesign.sbs") ||
      lower.includes("luminairewellbeing.sbs") ||
      lower.includes("silverpathway.sbs") ||
      lower.includes("silverpathacademy.cyou") ||
      lower.includes("cleantechworld.sbs") ||
      lower.includes("bellecrest.store") ||
      lower.includes("mountainviewfinance") ||
      lower.includes("healthproshop") ||
      lower.includes("meadowlaneeducation") ||
      lower.includes("lizer123") ||
      lower.includes("cf-master") ||
      lower.includes("/v4/") ||
      lower.includes("185.237.") ||
      lower.includes("203.188.") ||
      /https?:\/\/\d+\.\d+\.\d+\.\d+/.test(lower) ||
      lower.includes("45.156.158.180") ||
      lower.includes("45.156.")
    ) {
      referer = "https://flixcdn.cyou/";
      origin = "https://flixcdn.cyou";
      delete headers["x-forwarded-for"];
      delete headers["x-real-ip"];
    } else if (
      lower.includes("ironwallnet.net") ||
      lower.includes("digitalsun.app") ||
      lower.includes("itsdeskmate.com") ||
      lower.includes("keymi417exx.com") ||
      lower.includes("goldweather.net") ||
      lower.includes("shadowlemon.site") ||
      lower.includes("realworkers") ||
      lower.includes("cfw557.workers.dev") ||
      lower.includes("cfw69.workers.dev") ||
      lower.includes("louierojubi7526.workers.dev") ||
      lower.includes("p19-webcast.tiktokcdn.com") ||
      lower.includes("nexlunar99.site") ||
      lower.includes("videasy.to") ||
      lower.includes("shegu.org") ||
      lower.includes("ironbubble.site") ||
      lower.includes("randomseg") ||
      lower.includes("stormfire66.com") ||
      lower.includes("vimeos.net") ||
      lower.includes("paperoffer.site") ||
      lower.includes("signtime.site") ||
      lower.includes("checknews") ||
      lower.includes("speedracelight.com") ||
      lower.includes("/vd/") ||
      lower.includes("/r2/") ||
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
      lower.includes("1shows.app") ||
      lower.includes("streamrk.site") ||
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
      lower.includes("vodvidl.site") ||
      lower.includes("vidlink.pro") ||
      lower.includes("nightbreeze") ||
      lower.includes("thunderleaf")
    ) {
      referer = "https://vidlink.pro/";
      origin = "https://vidlink.pro";
    } else if (
      lower.includes("vidrift.in") ||
      lower.includes("vdrk.site") ||
      lower.includes("hostingersite.com") ||
      lower.includes("profitablelaunchsystem.website") ||
      /\.website/i.test(lower)
    ) {
      referer = "https://embed.vidrift.in/";
      origin = null;
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
  if (origin) {
    headers["origin"] = origin;
  } else {
    delete headers["origin"];
  }

  if (cookie) headers["cookie"] = cookie;

  return headers;
}
