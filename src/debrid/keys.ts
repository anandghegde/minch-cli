import type { Config } from "../config/config";
import { DEBRID_DESCRIPTORS } from "./descriptor";
import { DEBRID_IDS, type DebridId } from "./types";

// Environment overrides take precedence over the config file so a user can run
// minch with a one-off key without persisting it. Derived from the descriptor
// table so a new provider only needs an entry there (see descriptor.ts, B5).
export const ENV_VARS: Record<DebridId, string> = Object.fromEntries(
  DEBRID_IDS.map((id) => [id, DEBRID_DESCRIPTORS[id].envVar]),
) as Record<DebridId, string>;

export type KeySource = "env" | "config" | "none";

export interface ResolvedKey {
  key?: string;
  source: KeySource;
}

function clean(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

/** The key set via env var for a provider, if any. */
export function envKey(id: DebridId): string | undefined {
  return clean(process.env[ENV_VARS[id]]);
}

/** The key persisted in config for a provider, if any. */
export function configKey(id: DebridId, config: Config): string | undefined {
  return clean(DEBRID_DESCRIPTORS[id].read(config.debrid));
}

/**
 * Resolve a provider's key with env-var precedence over the config file. The
 * `source` lets the Accounts UI explain where a key came from (and refuse to
 * edit an env-provided one in place).
 */
export function resolveKey(id: DebridId, config: Config): ResolvedKey {
  const fromEnv = envKey(id);
  if (fromEnv) return { key: fromEnv, source: "env" };
  const fromConfig = configKey(id, config);
  if (fromConfig) return { key: fromConfig, source: "config" };
  return { source: "none" };
}

/**
 * Mask a secret to its last 4 characters for display. Never print a full key in
 * any UI/notice/log.
 */
export function maskKey(key: string): string {
  const k = key.trim();
  if (!k) return "";
  if (k.length <= 4) return "*".repeat(k.length);
  return `${"*".repeat(Math.min(8, k.length - 4))}${k.slice(-4)}`;
}

/** Persist (or clear, when `key` is undefined) a provider's key in config. */
export function withDebridKey(
  config: Config,
  id: DebridId,
  key: string | undefined,
): Config {
  const trimmed = clean(key);
  const debrid = DEBRID_DESCRIPTORS[id].write({ ...(config.debrid ?? {}) }, trimmed);
  return { ...config, debrid };
}
