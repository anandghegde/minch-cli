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

export type DiscoveryAdapterId = "tmdb" | "bluray" | "streaming-availability";

export interface DiscoveryConfig {
  tmdb?: { readToken?: string };
  streamingAvailability?: { apiKey?: string };
  disabledSources?: DiscoveryAdapterId[];
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
  /** Optional owner-only discovery credentials. Environment values win. */
  discovery?: DiscoveryConfig;
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

let pendingWarnings: string[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function httpsUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "https:" && parsed.hostname ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function coerceTorznab(raw: unknown, warnings: string[]): TorznabConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: TorznabConfig[] = [];
  const ids = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry)) {
      warnings.push("Ignored an invalid Torznab source.");
      continue;
    }
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const name = typeof entry.name === "string" ? entry.name.trim() : "";
    const baseUrl = httpsUrl(entry.baseUrl);
    if (!id || !name || !baseUrl || ids.has(id)) {
      warnings.push("Ignored an invalid Torznab source.");
      continue;
    }
    ids.add(id);
    out.push({
      id,
      name,
      baseUrl,
      ...(typeof entry.apiKey === "string" && entry.apiKey
        ? { apiKey: entry.apiKey }
        : {}),
      ...(typeof entry.categories === "string" && entry.categories.trim()
        ? { categories: entry.categories.trim() }
        : {}),
    });
  }
  return out;
}

function coerceSourceHealth(raw: unknown): SourceHealth | undefined {
  if (!isRecord(raw) || typeof raw.ok !== "boolean") return undefined;
  const out: SourceHealth = { ok: raw.ok };
  if (typeof raw.status === "string") out.status = raw.status;
  if (typeof raw.code === "string") out.code = raw.code;
  if (typeof raw.latency === "number" && Number.isFinite(raw.latency) && raw.latency >= 0) {
    out.latency = raw.latency;
  }
  if (typeof raw.testedAt === "number" && Number.isFinite(raw.testedAt) && raw.testedAt >= 0) {
    out.testedAt = raw.testedAt;
  }
  return out;
}

function coerceSources(raw: unknown, warnings: string[]): Record<string, SourceState> {
  if (!isRecord(raw)) return {};
  const out: Record<string, SourceState> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!isRecord(value) || typeof value.enabled !== "boolean") {
      warnings.push(`Ignored invalid state for source ${id}.`);
      continue;
    }
    const state: SourceState = { enabled: value.enabled };
    if (typeof value.mirror === "string") {
      try {
        const mirror = new URL(value.mirror);
        if (mirror.protocol === "http:" || mirror.protocol === "https:") {
          state.mirror = mirror.href;
        } else {
          warnings.push(`Ignored invalid mirror for source ${id}.`);
        }
      } catch {
        warnings.push(`Ignored invalid mirror for source ${id}.`);
      }
    }
    if (value.health !== undefined) {
      const health = coerceSourceHealth(value.health);
      if (health) state.health = health;
      else warnings.push(`Ignored invalid health state for source ${id}.`);
    }
    out[id] = state;
  }
  return out;
}

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

function coerceDiscovery(raw: unknown): DiscoveryConfig | undefined {
  if (!isRecord(raw)) return undefined;
  const out: DiscoveryConfig = {};
  if (isRecord(raw.tmdb)) {
    const readToken = typeof raw.tmdb.readToken === "string"
      ? raw.tmdb.readToken.trim()
      : "";
    if (readToken) out.tmdb = { readToken };
  }
  if (isRecord(raw.streamingAvailability)) {
    const apiKey = typeof raw.streamingAvailability.apiKey === "string"
      ? raw.streamingAvailability.apiKey.trim()
      : "";
    if (apiKey) out.streamingAvailability = { apiKey };
  }
  if (Array.isArray(raw.disabledSources)) {
    const disabledSources = [...new Set(raw.disabledSources.filter(
      (source): source is DiscoveryAdapterId =>
        source === "tmdb" || source === "bluray" || source === "streaming-availability",
    ))];
    if (disabledSources.length > 0) out.disabledSources = disabledSources;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function coerce(parsed: Partial<Config> | null, warnings: string[]): Config {
  if (!parsed || typeof parsed !== "object") return { ...defaultConfig };
  const debrid = coerceDebrid(parsed.debrid);
  const relevance = coerceRelevance(
    (parsed as Partial<Config> & { relevance?: unknown }).relevance,
  );
  const discovery = coerceDiscovery(
    (parsed as Partial<Config> & { discovery?: unknown }).discovery,
  );
  return {
    sources:
      coerceSources((parsed as Partial<Config> & { sources?: unknown }).sources, warnings),
    torznab: coerceTorznab((parsed as Partial<Config> & { torznab?: unknown }).torznab, warnings),
    firstRunDone: parsed.firstRunDone === true,
    ...(debrid ? { debrid } : {}),
    ...(relevance ? { relevance } : {}),
    ...(discovery ? { discovery } : {}),
  };
}

export async function loadConfig(): Promise<Config> {
  const warnings: string[] = [];
  let raw: string;
  try {
    raw = await fs.readFile(configFile, "utf8");
  } catch {
    pendingWarnings = warnings;
    return { ...defaultConfig };
  }
  try {
    const config = coerce(JSON.parse(raw) as Partial<Config>, warnings);
    pendingWarnings = warnings;
    return config;
  } catch {
    pendingWarnings = ["Config file is invalid; using defaults."];
    return { ...defaultConfig };
  }
}

/** Consume diagnostics generated while normalizing the persisted config. */
export function takeConfigWarnings(): string[] {
  const warnings = pendingWarnings;
  pendingWarnings = [];
  return warnings;
}

const writes = serializeWrites();
let lastSaveError: Error | null = null;

// config.json can hold debrid API keys, so persist it owner-only (0600).
export async function saveConfig(config: Config): Promise<void> {
  try {
    await writes(() => writeJsonAtomic(configFile, config, { mode: 0o600 }));
    lastSaveError = null;
  } catch (error) {
    lastSaveError = error instanceof Error ? error : new Error(String(error));
    throw error;
  }
}

/** Wait for all config writes enqueued so far (used by graceful shutdown). */
export function flushConfigWrites(): Promise<void> {
  return writes.flush();
}

/** Most recent failed config save, if it has not been superseded by success. */
export function getLastConfigSaveError(): Error | null {
  return lastSaveError;
}
