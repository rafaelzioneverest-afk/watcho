"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");
const { BRAND_PATTERNS, CATALOG_UPSTREAMS, STREAM_UPSTREAMS } = require("./sources");

const BRAND = "Watcho";
const PORT = Number(process.env.PORT || 7000);
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 12000);
const LOGO_PATH = path.join(__dirname, "watcho-logo.png");
const SOURCE_ID = Symbol("watchoSourceId");

const catalogMap = new Map();
for (const upstream of CATALOG_UPSTREAMS) {
  for (const catalog of upstream.catalogs) {
    catalogMap.set(toPublicCatalogId(upstream.key, catalog.id), {
      upstream,
      catalog
    });
  }
}

function buildManifest(baseUrl) {
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
    catalogs: CATALOG_UPSTREAMS.flatMap((upstream) =>
      upstream.catalogs.map((catalog) => ({
        type: catalog.type,
        id: toPublicCatalogId(upstream.key, catalog.id),
        name: sanitizeText(catalog.name)
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

function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "http";
  const host = req.headers["x-forwarded-host"] || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS"
  });
  res.end(body);
}

function sendText(res, statusCode, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS"
  });
  res.end(body);
}

function sendBuffer(res, statusCode, body, contentType) {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Content-Length": body.length,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS"
  });
  res.end(body);
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

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

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

async function handleCatalog(req, res, route) {
  const mapping = catalogMap.get(route.id);

  if (!mapping) {
    sendJson(res, 404, { metas: [] });
    return;
  }

  const { upstream, catalog } = mapping;
  const url = buildUpstreamUrl(upstream.baseUrl, "catalog", route.type, catalog.id, route.extra);

  try {
    const payload = await fetchJson(url);
    sendJson(res, 200, sanitizeCatalogPayload(payload));
  } catch (error) {
    sendJson(res, 200, { metas: [], error: `Falha ao carregar catalogo ${route.id}` });
  }
}

async function handleMeta(req, res, route) {
  const metaUpstreams = CATALOG_UPSTREAMS.filter((upstream) => upstream.hasMeta);

  for (const upstream of metaUpstreams) {
    const url = buildUpstreamUrl(upstream.baseUrl, "meta", route.type, route.id, route.extra);

    try {
      const payload = await fetchJson(url);
      if (payload && payload.meta) {
        sendJson(res, 200, sanitizeMetaPayload(payload));
        return;
      }
    } catch {
      // Try the next metadata source.
    }
  }

  sendJson(res, 404, { meta: null });
}

async function handleStream(req, res, route) {
  const tasks = STREAM_UPSTREAMS
    .filter((upstream) => upstream.types.includes(route.type))
    .map(async (upstream, index) => {
      const url = buildUpstreamUrl(upstream.baseUrl, "stream", route.type, route.id, route.extra);
      try {
        const payload = await fetchJson(url);
        const streams = Array.isArray(payload.streams) ? payload.streams : [];
        return streams.map((stream) => sanitizeStream(stream, getPrivateSourceId(index)));
      } catch {
        return [];
      }
    });

  const results = await Promise.all(tasks);
  const streams = sortStreamsByQuality(results.flat());
  sendJson(res, 200, { streams });
}

function sanitizeCatalogPayload(payload) {
  if (!payload || !Array.isArray(payload.metas)) {
    return { metas: [] };
  }

  return {
    ...payload,
    metas: payload.metas.map(sanitizeMeta)
  };
}

function sanitizeMetaPayload(payload) {
  if (!payload || !payload.meta) {
    return { meta: null };
  }

  return {
    ...payload,
    meta: sanitizeMeta(payload.meta)
  };
}

function sanitizeMeta(meta) {
  const next = { ...meta };

  for (const field of ["name", "description"]) {
    if (typeof next[field] === "string") {
      next[field] = sanitizeText(next[field]);
    }
  }

  if (Array.isArray(next.videos)) {
    next.videos = next.videos.map((video) => ({
      ...video,
      title: typeof video.title === "string" ? sanitizeText(video.title) : video.title
    }));
  }

  return next;
}

function getPrivateSourceId(index) {
  return `source-${index + 1}`;
}

function sanitizeStream(stream, privateSourceId = "") {
  const next = { ...stream };
  const peerCount = extractPeerCount(stream);

  Object.defineProperty(next, SOURCE_ID, {
    value: privateSourceId,
    enumerable: false
  });

  delete next.name;

  next.title = sanitizeText(stream.title || "", "");
  next.title = appendPeerInfo(next.title, peerCount);

  if (next.title === BRAND) {
    next.title = "";
  }

  if (typeof stream.description === "string") {
    next.description = sanitizeText(stream.description, "");
  }

  if (stream.behaviorHints && typeof stream.behaviorHints === "object") {
    next.behaviorHints = { ...stream.behaviorHints };
    for (const [key, value] of Object.entries(next.behaviorHints)) {
      if (shouldBrandBehaviorHintKey(key)) {
        delete next.behaviorHints[key];
      } else if (typeof value === "string") {
        next.behaviorHints[key] = sanitizeText(value, "");
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

function sanitizeText(value, replacement = BRAND) {
  if (typeof value !== "string") {
    return value;
  }

  let next = value;
  for (const pattern of BRAND_PATTERNS) {
    next = next.replace(pattern, replacement);
  }

  return next
    .replace(/(\u2699\uFE0F?\s*)[^\n]+/gu, replacement ? `$1${replacement}` : "")
    .replace(/(\u{1F4E1}\s*)[^\n]+/gu, replacement ? `$1${replacement}` : "")
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

function handleRoot(req, res) {
  const baseUrl = getBaseUrl(req);
  const body = `<!doctype html>
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

  sendText(res, 200, body, "text/html; charset=utf-8");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if (req.method === "OPTIONS") {
    sendText(res, 204, "");
    return;
  }

  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  if (pathname === "/" || pathname === "") {
    handleRoot(req, res);
    return;
  }

  if (pathname === "/manifest.json") {
    sendJson(res, 200, buildManifest(getBaseUrl(req)));
    return;
  }

  if (pathname === "/logo.png") {
    fs.readFile(LOGO_PATH, (error, data) => {
      if (error) {
        sendText(res, 200, logoSvg(), "image/svg+xml; charset=utf-8");
        return;
      }

      sendBuffer(res, 200, data, "image/png");
    });
    return;
  }

  if (pathname === "/logo.svg") {
    sendText(res, 200, logoSvg(), "image/svg+xml; charset=utf-8");
    return;
  }

  if (pathname === "/background.svg") {
    sendText(res, 200, backgroundSvg(), "image/svg+xml; charset=utf-8");
    return;
  }

  const route = parseAddonPath(pathname);
  if (!route) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  if (route.resource === "catalog") {
    await handleCatalog(req, res, route);
    return;
  }

  if (route.resource === "meta") {
    await handleMeta(req, res, route);
    return;
  }

  if (route.resource === "stream") {
    await handleStream(req, res, route);
    return;
  }
});

server.listen(PORT, () => {
  console.log(`${BRAND} Stremio addon running at http://localhost:${PORT}/manifest.json`);
});
