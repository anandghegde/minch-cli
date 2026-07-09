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

/**
 * Ranking / match preferences for keyword search (Phase C).
 * All flags default false when omitted — keeps zero-config behavior.
 */
export interface RelevanceConfig {
  /**
   * When true, insert qualityBand into the default relevance cascade after
   * seeder buckets (text still outranks popularity and quality).
   */
  preferQuality?: boolean;
  /** When true, hide rows with trash markers (CAM/TS/SAMPLE/…). */
  hideTrash?: boolean;
  /** When true, hide rows that fail full text AND (tier &lt; 2). */
  strictAnd?: boolean;
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
  /** Optional search-ranking preferences. */
  relevance?: RelevanceConfig;
}

export const defaultConfig: Config = {
  sources: {},
  torznab: [],
  firstRunDone: false,
};

export const defaultRelevanceConfig: RelevanceConfig = {
  preferQuality: false,
  hideTrash: false,
  strictAnd: false,
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

function coerceRelevance(raw: unknown): RelevanceConfig | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const out: RelevanceConfig = {};
  if (r.preferQuality === true) out.preferQuality = true;
  if (r.hideTrash === true) out.hideTrash = true;
  if (r.strictAnd === true) out.strictAnd = true;
  // Only persist a block when at least one flag is explicitly true; false/noise
  // fields are dropped so the file stays minimal for zero-config users.
  return Object.keys(out).length > 0 ? out : undefined;
}

function coerce(parsed: Partial<Config> | null): Config {
  if (!parsed || typeof parsed !== "object") return { ...defaultConfig };
  const debrid = coerceDebrid(parsed.debrid);
  const relevance = coerceRelevance(
    (parsed as Partial<Config> & { relevance?: unknown }).relevance,
  );
  return {
    sources:
      parsed.sources && typeof parsed.sources === "object" ? parsed.sources : {},
    torznab: Array.isArray(parsed.torznab) ? parsed.torznab : [],
    firstRunDone: parsed.firstRunDone === true,
    ...(debrid ? { debrid } : {}),
    ...(relevance ? { relevance } : {}),
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
