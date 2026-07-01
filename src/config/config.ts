import { promises as fs } from "node:fs";
import { configFile } from "./paths";
import { serializeWrites, writeJsonAtomic } from "../util/atomic";
import type { TorznabConfig } from "../sources/torznab";
import { allDescriptors } from "../debrid/descriptor";
import type { DebridId } from "../debrid/types";

export interface SourceHealth {
  /** Last probe outcome. */
  ok: boolean;
  status?: string;
  code?: string;
  latency?: number;
  /** Unix ms of the last test. */
  testedAt?: number;
}

export interface SourceState {
  /** Whether the source participates in searches. */
  enabled: boolean;
  /** Active mirror base URL (one of the source's links). */
  mirror?: string;
  health?: SourceHealth;
}

export interface DebridConfig {
  /** Which provider the `b` hand-off should prefer when several are configured. */
  preferred?: DebridId;
  torbox?: { apiKey?: string };
  /** Reserved; populated by the Real Debrid prompt. */
  realdebrid?: { token?: string };
  /** Reserved; destination dir for the local accelerator prompt. */
  downloadDir?: string;
}

export interface Config {
  /** Per-source enabled/mirror/health state, keyed by source id. */
  sources: Record<string, SourceState>;
  /** User-added Torznab sources. */
  torznab: TorznabConfig[];
  /** Set once the first-run health probe has completed. */
  firstRunDone: boolean;
  /** Cloud debrid providers (TorBox, Real Debrid). */
  debrid?: DebridConfig;
}

export const defaultConfig: Config = {
  sources: {},
  torznab: [],
  firstRunDone: false,
};

function coerceDebrid(raw: unknown): DebridConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  let out: DebridConfig = {};
  if (r.preferred === "torbox" || r.preferred === "realdebrid") {
    out.preferred = r.preferred;
  }
  // Each provider validates its own sub-object; adding a provider means
  // adding one descriptor entry instead of another branch here (see
  // debrid/descriptor.ts, B5).
  for (const descriptor of allDescriptors()) {
    out = { ...out, ...descriptor.coerce(r[descriptor.id]) };
  }
  if (typeof r.downloadDir === "string") out.downloadDir = r.downloadDir;
  return out;
}

function coerce(parsed: Partial<Config> | null): Config {
  if (!parsed || typeof parsed !== "object") return { ...defaultConfig };
  const debrid = coerceDebrid(parsed.debrid);
  return {
    sources:
      parsed.sources && typeof parsed.sources === "object" ? parsed.sources : {},
    torznab: Array.isArray(parsed.torznab) ? parsed.torznab : [],
    firstRunDone: parsed.firstRunDone === true,
    ...(debrid ? { debrid } : {}),
  };
}

export async function loadConfig(): Promise<Config> {
  let raw: string;
  try {
    raw = await fs.readFile(configFile, "utf8");
  } catch {
    return { ...defaultConfig };
  }
  try {
    return coerce(JSON.parse(raw) as Partial<Config>);
  } catch {
    return { ...defaultConfig };
  }
}

const write = serializeWrites();

// config.json can hold debrid API keys, so persist it owner-only (0600).
export function saveConfig(config: Config): Promise<void> {
  return write(() => writeJsonAtomic(configFile, config, { mode: 0o600 }));
}
