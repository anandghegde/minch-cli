import path from "node:path";
import envPaths from "env-paths";

export const APP_NAME = "minch";

const base = envPaths(APP_NAME, { suffix: "" });

// Optional override that relocates all persisted state under one folder. Tests
// point this at a temp dir so they never touch real user data.
const override = process.env.MINCH_STATE_DIR;
const dataDir = override ? path.join(override, "data") : base.data;
const configDir = override ? path.join(override, "config") : base.config;
const logDir = override ? path.join(override, "log") : base.log;

export const configFile = path.join(configDir, "config.json");
export const cacheFile = path.join(dataDir, "search-cache.json");
export const discoveryCacheFile = path.join(dataDir, "discovery-cache.json");
export const discoveryUsageFile = path.join(dataDir, "discovery-usage.json");
export const discoveryRatingsCacheFile = path.join(dataDir, "discovery-ratings-cache.json");
export const discoveryRatingsUsageFile = path.join(dataDir, "discovery-ratings-usage.json");
export const imdbRatingsDatasetFile = path.join(dataDir, "imdb-title-ratings.tsv.gz");
export const appLogFile = path.join(logDir, "minch.log");
