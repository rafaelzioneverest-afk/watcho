const BRAND = "Watcho";
const DEFAULT_UPSTREAM_TIMEOUT_MS = 12000;
const SOURCE_ID = Symbol("watchoSourceId");

export default {
  async fetch(request, env) {
    return handleRequest(request, env || {});
  }
};

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const pathname = url.pathname;

  if (request.method === "OPTIONS") {
    return textResponse("", 204);
  }

  if (request.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const sources = loadSources(env);

  if (pathname === "/" || pathname === "") {
    return htmlResponse(rootHtml(getBaseUrl(request)));
  }

  if (pathname === "/manifest.json") {
    return jsonResponse(buildManifest(getBaseUrl(request), sources));
  }

  if (pathname === "/logo.png") {
    return serveLogo(request, env);
  }

  if (pathname === "/logo.svg") {
    return textResponse(logoSvg(), 200, "image/svg+xml; charset=utf-8");
  }

  if (pathname === "/background.svg") {
    return textResponse(backgroundSvg(), 200, "image/svg+xml; charset=utf-8");
  }

  const route = parseAddonPath(pathname);
  if (!route) {
    return jsonResponse({ error: "Not found" }, 404);
  }

  if (route.resource === "catalog") {
    return handleCatalog(route, sources, env);
  }

  if (route.resource === "meta") {
    return handleMeta(route, sources, env);
  }

  if (route.resource === "stream") {
    return handleStream(route, sources, env);
  }

  return jsonResponse({ error: "Not found" }, 404);
}

function loadSources(env) {
  const combinedSources = readJsonValue(env.WATCHO_SOURCES_JSON, "WATCHO_SOURCES_JSON");
  if (combinedSources) {
    return normalizeSources(combinedSources, "WATCHO_SOURCES_JSON");
  }

  const catalogUpstreams = readJsonValue(
    env.WATCHO_CATALOG_UPSTREAMS_JSON,
    "WATCHO_CATALOG_UPSTREAMS_JSON"
  );
  const streamUpstreams = readJsonValue(
    env.WATCHO_STREAM_UPSTREAMS_JSON,
    "WATCHO_STREAM_UPSTREAMS_JSON"
  );

  if (catalogUpstreams || streamUpstreams) {
    return normalizeSources(
      {
        catalogUpstreams: catalogUpstreams || [],
        streamUpstreams: streamUpstreams || []
      },
      "split source secrets"
    );
  }

  return normalizeSources({}, "empty sources");
}

function readJsonValue(value, label) {
  if (!value) {
    return null;
  }

  try {
    return typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

function normalizeSources(value, label) {
  const catalogUpstreams = value.catalogUpstreams || value.CATALOG_UPSTREAMS || [];
  const streamUpstreams = value.streamUpstreams || value.STREAM_UPSTREAMS || [];
  const brandPatterns = value.brandPatterns || value.BRAND_PATTERNS || [];

  if (!Array.isArray(catalogUpstreams)) {
    throw new Error(`${label} catalogUpstreams must be an array`);
  }

  if (!Array.isArray(streamUpstreams)) {
    throw new Error(`${label} streamUpstreams must be an array`);
  }

  if (!Array.isArray(brandPatterns)) {
    throw new Error(`${label} brandPatterns must be an array`);
  }

  return {
    catalogUpstreams,
    streamUpstreams,
    brandPatterns: brandPatterns.map((pattern, index) =>
      normalizeBrandPattern(pattern, `${label} brandPatterns[${index}]`)
    )
  };
}

function normalizeBrandPattern(pattern, label) {
  if (pattern instanceof RegExp) {
    return pattern;
  }

  if (typeof pattern === "string") {
    return new RegExp(pattern, "gi");
  }

  if (pattern && typeof pattern.source === "string") {
    return new RegExp(pattern.source, pattern.flags || "gi");
  }

  throw new Error(`${label} must be a regex string or object`);
}

function buildManifest(baseUrl, sources) {
  return {
    id: "com.watcho.addon",
    version: "1.0.0",
    name: BRAND,
    description: "Catálogos e streams reunidos em um só addon.",
    logo: `${baseUrl}/logo.png`,
    background: `${baseUrl}/background.svg`,
    resources: [
      "catalog",
      "meta",
      {
        name: "stream",
        types: ["movie", "series", "anime"],
        idPrefixes: ["tt", "kitsu"]
      }
    ],
    types: ["movie", "series", "anime", "other"],
    catalogs: sources.catalogUpstreams.flatMap((upstream) =>
      upstream.catalogs.map((catalog) => ({
        type: catalog.type,
        id: toPublicCatalogId(upstream.key, catalog.id),
        name: sanitizeText(catalog.name, sources.brandPatterns)
      }))
    ),
    idPrefixes: ["tt", "tmdb:", "kitsu"],
    behaviorHints: {
      configurable: false,
      configurationRequired: false
    }
  };
}

function toPublicCatalogId(key, catalogId) {
  return `${key}-${catalogId}`;
}

function getBaseUrl(request) {
  const url = new URL(request.url);
  const proto = request.headers.get("x-forwarded-proto") || url.protocol.replace(/:$/, "");
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || url.host;
  return `${proto}://${host}`;
}

function corsHeaders(contentType) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS"
  };

  if (contentType) {
    headers["Content-Type"] = contentType;
  }

  return headers;
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: corsHeaders("application/json; charset=utf-8")
  });
}

function textResponse(body, status = 200, contentType = "text/plain; charset=utf-8") {
  return new Response(body, {
    status,
    headers: corsHeaders(contentType)
  });
}

function htmlResponse(body, status = 200) {
  return textResponse(body, status, "text/html; charset=utf-8");
}

function withCors(response, contentType) {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Access-Control-Allow-Headers", "*");
  headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (contentType) {
    headers.set("Content-Type", contentType);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function serveLogo(request, env) {
  if (env.ASSETS) {
    const assetUrl = new URL(request.url);
    assetUrl.pathname = "/logo.png";
    const response = await env.ASSETS.fetch(new Request(assetUrl, request));
    if (response.ok) {
      return withCors(response, "image/png");
    }
  }

  return textResponse(logoSvg(), 200, "image/svg+xml; charset=utf-8");
}

function stripJsonSuffix(value) {
  return value.endsWith(".json") ? value.slice(0, -5) : value;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseAddonPath(pathname) {
  const parts = pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  const resource = parts[0];

  if (!["catalog", "meta", "stream"].includes(resource) || parts.length < 3) {
    return null;
  }

  if (resource === "catalog" && parts.length >= 4) {
    return {
      resource,
      type: safeDecode(parts[1]),
      id: safeDecode(parts[2]),
      extra: stripJsonSuffix(parts.slice(3).join("/"))
    };
  }

  return {
    resource,
    type: safeDecode(parts[1]),
    id: safeDecode(stripJsonSuffix(parts[2])),
    extra: null
  };
}

function buildUpstreamUrl(baseUrl, resource, type, id, extra) {
  const pathParts = [resource, encodeURIComponent(type), encodeURIComponent(id)];
  if (extra) {
    pathParts.push(extra);
  } else {
    pathParts[pathParts.length - 1] += ".json";
  }

  if (extra) {
    pathParts[pathParts.length - 1] += ".json";
  }

  return `${baseUrl.replace(/\/+$/, "")}/${pathParts.join("/")}`;
}

async function fetchJson(url, env) {
  const timeoutMs = Number(env.UPSTREAM_TIMEOUT_MS || DEFAULT_UPSTREAM_TIMEOUT_MS);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": `${BRAND}/1.0 StremioAddon`
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function getCatalogMap(sources) {
  const catalogMap = new Map();
  for (const upstream of sources.catalogUpstreams) {
    for (const catalog of upstream.catalogs || []) {
      catalogMap.set(toPublicCatalogId(upstream.key, catalog.id), {
        upstream,
        catalog
      });
    }
  }

  return catalogMap;
}

async function handleCatalog(route, sources, env) {
  const mapping = getCatalogMap(sources).get(route.id);

  if (!mapping) {
    return jsonResponse({ metas: [] }, 404);
  }

  const { upstream, catalog } = mapping;
  const url = buildUpstreamUrl(upstream.baseUrl, "catalog", route.type, catalog.id, route.extra);

  try {
    const payload = await fetchJson(url, env);
    return jsonResponse(sanitizeCatalogPayload(payload, sources.brandPatterns));
  } catch {
    return jsonResponse({ metas: [], error: `Falha ao carregar catalogo ${route.id}` });
  }
}

async function handleMeta(route, sources, env) {
  const metaUpstreams = sources.catalogUpstreams.filter((upstream) => upstream.hasMeta);

  for (const upstream of metaUpstreams) {
    const url = buildUpstreamUrl(upstream.baseUrl, "meta", route.type, route.id, route.extra);

    try {
      const payload = await fetchJson(url, env);
      if (payload && payload.meta) {
        return jsonResponse(sanitizeMetaPayload(payload, sources.brandPatterns));
      }
    } catch {
      // Try the next metadata source.
    }
  }

  return jsonResponse({ meta: null }, 404);
}

async function handleStream(route, sources, env) {
  const tasks = sources.streamUpstreams
    .filter((upstream) => Array.isArray(upstream.types) && upstream.types.includes(route.type))
    .map(async (upstream, index) => {
      const url = buildUpstreamUrl(upstream.baseUrl, "stream", route.type, route.id, route.extra);
      try {
        const payload = await fetchJson(url, env);
        const streams = Array.isArray(payload.streams) ? payload.streams : [];
        return streams.map((stream) =>
          sanitizeStream(stream, sources.brandPatterns, getPublicSourceName(index))
        );
      } catch {
        return [];
      }
    });

  const results = await Promise.all(tasks);
  const streams = sortStreamsByQuality(dedupeStreams(results.flat()));
  return jsonResponse({ streams });
}

function sanitizeCatalogPayload(payload, brandPatterns) {
  if (!payload || !Array.isArray(payload.metas)) {
    return { metas: [] };
  }

  return {
    ...payload,
    metas: payload.metas.map((meta) => sanitizeMeta(meta, brandPatterns))
  };
}

function sanitizeMetaPayload(payload, brandPatterns) {
  if (!payload || !payload.meta) {
    return { meta: null };
  }

  return {
    ...payload,
    meta: sanitizeMeta(payload.meta, brandPatterns)
  };
}

function sanitizeMeta(meta, brandPatterns) {
  const next = { ...meta };

  for (const field of ["name", "description"]) {
    if (typeof next[field] === "string") {
      next[field] = sanitizeText(next[field], brandPatterns);
    }
  }

  if (Array.isArray(next.videos)) {
    next.videos = next.videos.map((video) => ({
      ...video,
      title: typeof video.title === "string" ? sanitizeText(video.title, brandPatterns) : video.title
    }));
  }

  return next;
}

function getPublicSourceName(index) {
  return `${BRAND} ${index + 1}`;
}

function sanitizeStream(stream, brandPatterns, publicSourceName = BRAND) {
  const next = { ...stream };
  const fallbackTitle = [stream.name, stream.title].filter(Boolean).join("\n");
  const peerCount = extractPeerCount(stream);

  Object.defineProperty(next, SOURCE_ID, {
    value: publicSourceName,
    enumerable: false
  });

  next.name = publicSourceName;
  next.title = sanitizeText(stream.title || fallbackTitle || BRAND, brandPatterns);
  next.title = appendPeerInfo(next.title, peerCount);

  if (!next.title || next.title === BRAND) {
    next.title = BRAND;
    next.title = appendPeerInfo(next.title, peerCount);
  }

  if (typeof stream.description === "string") {
    next.description = sanitizeText(stream.description, brandPatterns);
  }

  if (stream.behaviorHints && typeof stream.behaviorHints === "object") {
    next.behaviorHints = { ...stream.behaviorHints };
    for (const [key, value] of Object.entries(next.behaviorHints)) {
      if (shouldBrandBehaviorHintKey(key)) {
        next.behaviorHints[key] = publicSourceName;
      } else if (typeof value === "string") {
        next.behaviorHints[key] = sanitizeText(value, brandPatterns);
      }
    }
  }

  return next;
}

function shouldBrandBehaviorHintKey(key) {
  return /^(addonName|indexerName|providerName|sourceName|trackerName)$/i.test(key);
}

function extractPeerCount(stream) {
  const directFields = [
    "peers",
    "peerCount",
    "seeders",
    "seeds",
    "seedCount",
    "seederCount",
    "seedersCount"
  ];

  for (const field of directFields) {
    const count = parsePeerNumber(stream[field]);
    if (count !== null) {
      return count;
    }
  }

  const nestedValues = [
    stream.behaviorHints && stream.behaviorHints.peers,
    stream.behaviorHints && stream.behaviorHints.seeders,
    stream.torrent && stream.torrent.peers,
    stream.torrent && stream.torrent.seeders,
    stream.stats && stream.stats.peers,
    stream.stats && stream.stats.seeders
  ];

  for (const value of nestedValues) {
    const count = parsePeerNumber(value);
    if (count !== null) {
      return count;
    }
  }

  const textValues = [
    stream.name,
    stream.title,
    stream.description,
    stream.behaviorHints && stream.behaviorHints.bingeGroup,
    stream.behaviorHints && stream.behaviorHints.filename
  ].filter((value) => typeof value === "string");

  const patterns = [
    /(?:peers?|seeders?|seeds?|semeadores?)\s*[:=\-]?\s*([0-9][0-9.,]*\s*[kKmM]?)/i,
    /[\u{1F464}\u{1F465}]\s*([0-9][0-9.,]*\s*[kKmM]?)/iu,
    /([0-9][0-9.,]*\s*[kKmM]?)\s*(?:peers?|seeders?|seeds?|semeadores?)/i
  ];

  for (const text of textValues) {
    for (const pattern of patterns) {
      const match = text.match(pattern);
      const count = match && parsePeerNumber(match[1]);
      if (count !== null) {
        return count;
      }
    }
  }

  return null;
}

function parsePeerNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.round(value));
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().replace(/\s+/g, "");
  const match = normalized.match(/^([0-9][0-9.,]*)([kKmM]?)$/);
  if (!match) {
    return null;
  }

  const suffix = match[2].toLowerCase();
  let numeric = match[1];

  if (numeric.includes(",") && numeric.includes(".")) {
    numeric = numeric.replace(/,/g, "");
  } else if (numeric.includes(",") && !numeric.includes(".")) {
    numeric = numeric.replace(/,/g, "");
  }

  const parsed = Number(numeric);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  const multiplier = suffix === "m" ? 1000000 : suffix === "k" ? 1000 : 1;
  return Math.max(0, Math.round(parsed * multiplier));
}

function appendPeerInfo(title, peerCount) {
  if (peerCount === null || titleHasPeerLabel(title)) {
    return title;
  }

  return `${title}\nPeers: ${peerCount}`;
}

function titleHasPeerLabel(title) {
  return /(?:^|\n)\s*Peers:\s*[0-9]/i.test(title);
}

function sanitizeText(value, brandPatterns) {
  if (typeof value !== "string") {
    return value;
  }

  let next = value;
  for (const pattern of brandPatterns) {
    next = next.replace(pattern, BRAND);
  }

  return next
    .replace(/(\u2699\uFE0F?\s*)[^\n]+/gu, `$1${BRAND}`)
    .replace(/(\u{1F4E1}\s*)[^\n]+/gu, `$1${BRAND}`)
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function dedupeStreams(streams) {
  const seen = new Set();
  const output = [];

  for (const stream of streams) {
    const key = [
      stream.infoHash || "",
      stream.fileIdx ?? "",
      stream.url || "",
      stream.externalUrl || "",
      stream.title || "",
      stream[SOURCE_ID] || ""
    ].join("|");

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    output.push(stream);
  }

  return output;
}

function sortStreamsByQuality(streams) {
  return streams
    .map((stream, index) => ({
      stream,
      index,
      quality: extractQualityScore(stream),
      peers: extractPeerCount(stream) ?? -1
    }))
    .sort((left, right) => {
      if (right.quality !== left.quality) {
        return right.quality - left.quality;
      }

      if (right.peers !== left.peers) {
        return right.peers - left.peers;
      }

      return left.index - right.index;
    })
    .map((item) => item.stream);
}

function extractQualityScore(stream) {
  const textValues = [
    stream.name,
    stream.title,
    stream.description,
    stream.url,
    stream.externalUrl,
    stream.behaviorHints && stream.behaviorHints.bingeGroup,
    stream.behaviorHints && stream.behaviorHints.filename,
    stream.behaviorHints && stream.behaviorHints.videoHash,
    stream.torrent && stream.torrent.name,
    stream.torrent && stream.torrent.filename
  ].filter((value) => typeof value === "string");

  let best = 0;
  for (const text of textValues) {
    best = Math.max(best, extractQualityScoreFromText(text));
  }

  return best;
}

function extractQualityScoreFromText(text) {
  let best = 0;

  const resolutionPatterns = [
    /\b(4320|2160|1440|1080|720|576|540|480|360|240)p\b/gi,
    /\b[0-9]{3,5}\s*x\s*(4320|2160|1440|1080|720|576|540|480|360|240)\b/gi
  ];

  for (const pattern of resolutionPatterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      best = Math.max(best, Number(match[1]));
    }
  }

  const labelScores = [
    { pattern: /\b(?:8k|uhd\s*8k)\b/i, score: 4320 },
    { pattern: /\b(?:4k|uhd|ultra\s*hd)\b/i, score: 2160 },
    { pattern: /\b(?:2k|qhd)\b/i, score: 1440 },
    { pattern: /\b(?:fhd|full\s*hd)\b/i, score: 1080 },
    { pattern: /\bhd\b/i, score: 720 },
    { pattern: /\bsd\b/i, score: 480 }
  ];

  for (const { pattern, score } of labelScores) {
    if (pattern.test(text)) {
      best = Math.max(best, score);
    }
  }

  return best;
}

function logoSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="96" fill="#111827"/>
  <circle cx="256" cy="256" r="142" fill="#f97316"/>
  <text x="256" y="289" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="96" font-weight="800" fill="#fff7ed">W</text>
</svg>`;
}

function backgroundSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1920 1080">
  <rect width="1920" height="1080" fill="#111827"/>
  <path d="M0 830C310 650 560 650 910 760s640 120 1010-90v410H0Z" fill="#0f766e"/>
  <path d="M0 0h1920v1080H0z" fill="none"/>
  <text x="960" y="548" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="132" font-weight="800" fill="#fff7ed">${BRAND}</text>
</svg>`;
}

function rootHtml(baseUrl) {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${BRAND}</title>
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;background:#111827;color:#fff7ed;font-family:Arial,Helvetica,sans-serif}
    main{width:min(680px,calc(100% - 40px));text-align:center}
    img{width:132px;height:132px;object-fit:contain;margin-bottom:24px}
    h1{font-size:clamp(44px,9vw,92px);margin:0 0 12px;letter-spacing:0}
    p{font-size:18px;line-height:1.5;color:#d1d5db}
    a{display:inline-flex;margin-top:20px;padding:12px 18px;border-radius:8px;background:#f97316;color:#111827;text-decoration:none;font-weight:700}
  </style>
</head>
<body>
  <main>
    <img src="/logo.png" alt="${BRAND}">
    <h1>${BRAND}</h1>
    <p>Addon Stremio pronto para instalar.</p>
    <a href="stremio://${baseUrl.replace(/^https?:\/\//, "")}/manifest.json">Instalar no Stremio</a>
  </main>
</body>
</html>`;
}
