import path from "node:path";
import envPaths from "env-paths";

export const APP_NAME = "minch";

const base = envPaths(APP_NAME, { suffix: "" });

// Optional override that relocates all persisted state under one folder. Tests
// point this at a temp dir so they never touch real user data.
const override = process.env.MINCH_STATE_DIR;
const dataDir = override ? path.join(override, "data") : base.data;
const configDir = override ? path.join(override, "config") : base.config;

export const configFile = path.join(configDir, "config.json");
export const cacheFile = path.join(dataDir, "search-cache.json");
