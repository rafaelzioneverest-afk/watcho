"use strict";

const PRIVATE_SOURCES_FILE = "sources.private.json";

function loadSources(env = getDefaultEnv()) {
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

  return normalizeSources(readPrivateSourcesFile() || {}, PRIVATE_SOURCES_FILE);
}

function getDefaultEnv() {
  return typeof process !== "undefined" && process.env ? process.env : {};
}

function readJsonValue(value, label) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} must be valid JSON`);
  }
}

function readPrivateSourcesFile() {
  let fs;
  let path;

  try {
    fs = require("fs");
    path = require("path");
  } catch {
    return null;
  }

  const filePath = path.join(__dirname, PRIVATE_SOURCES_FILE);
  if (!fs.existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new Error(`${PRIVATE_SOURCES_FILE} must be valid JSON`);
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

const loadedSources = loadSources();

module.exports = {
  CATALOG_UPSTREAMS: loadedSources.catalogUpstreams,
  STREAM_UPSTREAMS: loadedSources.streamUpstreams,
  BRAND_PATTERNS: loadedSources.brandPatterns,
  loadSources
};
