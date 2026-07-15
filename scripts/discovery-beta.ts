import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { defaultConfig } from "../src/config/config";
import type { DiscoverySnapshot } from "../src/discovery/adapter";
import { aggregateDiscoverySnapshots } from "../src/discovery/aggregate";
import { createRequestLedger, type RequestLedger } from "../src/discovery/budget";
import { createDiscoveryCacheRepository } from "../src/discovery/cache-repository";
import { discoveryRequestKey } from "../src/discovery/cache";
import { indiaToday } from "../src/discovery/dates";
import { sanitizeDiscoveryText } from "../src/discovery/security";
import { createDiscoveryService, type DiscoveryLoadResult } from "../src/discovery/service";
import type { DiscoverySource } from "../src/discovery/types";
import {
  buildDiscoveryLoadTargets,
  type DiscoveryLoadTarget,
} from "../src/ui/hooks/useDiscovery";
import { writeJsonAtomic } from "../src/util/atomic";

export const BETA_VERSION = 1 as const;
export const BETA_DAYS = 7;
export const BETA_REQUIRED_SAMPLES = 15;
export const BETA_RELEASE_REQUIRED_SAMPLES = 2;
export const BETA_SAMPLE_INTERVAL_MS = 12 * 60 * 60 * 1_000;
export const BETA_MIN_SAMPLE_GAP_MS = 10 * 60 * 60 * 1_000;
export const BETA_LOCK_STALE_MS = 60 * 60 * 1_000;

const SOURCES: DiscoverySource[] = [
  "tmdb",
  "bluray",
  "streaming-availability",
  "trakt",
];

export interface BetaSample {
  sampledAt: string;
  requestAttempts: Partial<Record<DiscoverySource, number>>;
  successfulRefreshes: number;
  cacheHits: number;
  stalePeriods: number;
  sourceErrors: Record<string, number>;
  uniqueTitles: number;
  uniqueEvents: number;
  unknownDateEvents: number;
  ambiguousMerges: number;
  targetStatuses: Array<{ key: string; status: string }>;
}

export interface DiscoveryBetaDocument {
  version: typeof BETA_VERSION;
  startedAt: string;
  minimumEndsAt: string;
  scheduleHours: 12;
  requiredSamples: typeof BETA_REQUIRED_SAMPLES;
  samples: BetaSample[];
  seenTitleHashes: string[];
  seenEventHashes: string[];
  unknownDateEventHashes: string[];
}

export interface DiscoveryBetaSummary {
  startedAt: string;
  minimumEndsAt: string;
  elapsedDays: number;
  sampleCount: number;
  sampledIndiaDays: number;
  nextSampleAt: string;
  releaseReady: boolean;
  windowComplete: boolean;
  requestAttempts: Partial<Record<DiscoverySource, number>>;
  successfulRefreshes: number;
  stalePeriods: number;
  sourceErrors: Record<string, number>;
  uniqueTitles: number;
  uniqueEvents: number;
  unknownDateEvents: number;
  ambiguousMerges: number;
}

function betaDirectory(): string {
  const configured = process.env.MINCH_BETA_DIR?.trim();
  if (!configured) {
    throw new Error("Set MINCH_BETA_DIR to an isolated persistent beta directory");
  }
  return path.resolve(configured);
}

function isAlreadyExists(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "EEXIST";
}

/** Prevent two scheduled processes from duplicating a full refresh. */
export async function withBetaSampleLock<T>(
  directory: string,
  task: () => Promise<T>,
  now = Date.now(),
): Promise<T> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const lockFile = path.join(directory, ".sample.lock");
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await fs.open(lockFile, "wx", 0o600);
      await handle.chmod(0o600);
      break;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const stat = await fs.stat(lockFile).catch(() => undefined);
      if (attempt === 0 && stat && now - stat.mtimeMs >= BETA_LOCK_STALE_MS) {
        await fs.rm(lockFile, { force: true });
        continue;
      }
      throw new Error("Another discovery beta sample is already running");
    }
  }
  if (!handle) throw new Error("Unable to acquire discovery beta sample lock");
  try {
    return await task();
  } finally {
    await handle.close().catch(() => {});
    await fs.rm(lockFile, { force: true }).catch(() => {});
  }
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function newDocument(now: number): DiscoveryBetaDocument {
  return {
    version: BETA_VERSION,
    startedAt: new Date(now).toISOString(),
    minimumEndsAt: new Date(now + BETA_DAYS * 24 * 60 * 60 * 1_000).toISOString(),
    scheduleHours: 12,
    requiredSamples: BETA_REQUIRED_SAMPLES,
    samples: [],
    seenTitleHashes: [],
    seenEventHashes: [],
    unknownDateEventHashes: [],
  };
}

function validDocument(value: unknown): value is DiscoveryBetaDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const document = value as Partial<DiscoveryBetaDocument>;
  const requiredSamples = (value as { requiredSamples?: unknown }).requiredSamples;
  return document.version === BETA_VERSION &&
    typeof document.startedAt === "string" &&
    Number.isFinite(Date.parse(document.startedAt)) &&
    typeof document.minimumEndsAt === "string" &&
    Number.isFinite(Date.parse(document.minimumEndsAt)) &&
    document.scheduleHours === 12 &&
    (requiredSamples === 14 || requiredSamples === BETA_REQUIRED_SAMPLES) &&
    Array.isArray(document.samples) &&
    Array.isArray(document.seenTitleHashes) &&
    Array.isArray(document.seenEventHashes) &&
    Array.isArray(document.unknownDateEventHashes);
}

async function readDocument(file: string, now: number): Promise<DiscoveryBetaDocument> {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    if (!validDocument(value)) throw new Error("beta report has an unsupported shape");
    value.requiredSamples = BETA_REQUIRED_SAMPLES;
    return value;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return newDocument(now);
    }
    throw error;
  }
}

function mergeCounts(
  target: Record<string, number>,
  additions: Readonly<Record<string, number>>,
): void {
  for (const [key, count] of Object.entries(additions)) {
    target[key] = (target[key] ?? 0) + count;
  }
}

export function summarizeBeta(
  document: DiscoveryBetaDocument,
  now = Date.now(),
): DiscoveryBetaSummary {
  const requestAttempts: Partial<Record<DiscoverySource, number>> = {};
  const sourceErrors: Record<string, number> = {};
  for (const sample of document.samples) {
    for (const source of SOURCES) {
      requestAttempts[source] = (requestAttempts[source] ?? 0) +
        (sample.requestAttempts[source] ?? 0);
    }
    mergeCounts(sourceErrors, sample.sourceErrors);
  }
  const lastSample = document.samples.at(-1)?.sampledAt ?? document.startedAt;
  const sampledIndiaDays = new Set(document.samples.map((sample) =>
    indiaToday(Date.parse(sample.sampledAt)))).size;
  return {
    startedAt: document.startedAt,
    minimumEndsAt: document.minimumEndsAt,
    elapsedDays: Math.max(0, (now - Date.parse(document.startedAt)) / 86_400_000),
    sampleCount: document.samples.length,
    sampledIndiaDays,
    nextSampleAt: new Date(Date.parse(lastSample) + BETA_SAMPLE_INTERVAL_MS).toISOString(),
    releaseReady: document.samples.length >= BETA_RELEASE_REQUIRED_SAMPLES,
    windowComplete: now >= Date.parse(document.minimumEndsAt) &&
      document.samples.length >= document.requiredSamples &&
      sampledIndiaDays >= BETA_DAYS,
    requestAttempts,
    successfulRefreshes: document.samples.reduce(
      (total, sample) => total + sample.successfulRefreshes,
      0,
    ),
    stalePeriods: document.samples.reduce((total, sample) => total + sample.stalePeriods, 0),
    sourceErrors,
    uniqueTitles: document.seenTitleHashes.length,
    uniqueEvents: document.seenEventHashes.length,
    unknownDateEvents: document.unknownDateEventHashes.length,
    ambiguousMerges: document.samples.reduce(
      (total, sample) => total + sample.ambiguousMerges,
      0,
    ),
  };
}

function uniqueTargets(
  requestLedger: Pick<RequestLedger, "recordAttempt" | "canSpend">,
  skipBluray: boolean,
): DiscoveryLoadTarget[] {
  const today = indiaToday();
  const config = skipBluray
    ? { ...defaultConfig, discovery: { disabledSources: ["bluray" as const] } }
    : defaultConfig;
  const targets = (["trending", "ott", "bluray"] as const)
    .flatMap((feed) => buildDiscoveryLoadTargets(
      config,
      feed,
      "30d",
      requestLedger,
      today,
    ));
  const unique = new Map<string, DiscoveryLoadTarget>();
  for (const target of targets) {
    unique.set(discoveryRequestKey(target.adapter.id, target.request), target);
  }
  return [...unique.values()];
}

function errorCode(error: Error | undefined): string {
  if (!error) return "unknown";
  if ("status" in error && typeof error.status === "number") {
    return `http-${error.status}`;
  }
  return sanitizeDiscoveryText(error.name).toLowerCase() || "error";
}

async function settleLoad(
  target: DiscoveryLoadTarget,
  service: ReturnType<typeof createDiscoveryService>,
): Promise<{
  snapshot?: DiscoverySnapshot;
  status: string;
  successfulRefresh: boolean;
  cacheHit: boolean;
  stale: boolean;
  error?: Error;
}> {
  if (target.adapter.isEnabled?.() === false) return { status: "disabled", successfulRefresh: false, cacheHit: false, stale: false };
  if (!target.adapter.isConfigured()) return { status: "unconfigured", successfulRefresh: false, cacheHit: false, stale: false };
  const loaded: DiscoveryLoadResult = await service.load(target.adapter, target.request, {
    signal: AbortSignal.timeout(30_000),
  });
  const stale = loaded.cacheState === "stale" || loaded.cacheState === "expired";
  if (loaded.refreshing && loaded.refresh) {
    const refreshed = await loaded.refresh;
    return {
      ...(refreshed.snapshot ? { snapshot: refreshed.snapshot } : {}),
      status: refreshed.status,
      successfulRefresh: refreshed.status === "ready",
      cacheHit: true,
      stale,
      ...(refreshed.error ? { error: refreshed.error } : {}),
    };
  }
  return {
    ...(loaded.snapshot ? { snapshot: loaded.snapshot } : {}),
    status: loaded.error ? "failed" : loaded.cacheState,
    successfulRefresh: loaded.cacheState === "refreshed" && !loaded.error,
    cacheHit: loaded.cacheState === "fresh" || loaded.cacheState === "stale",
    stale,
    ...(loaded.error ? { error: loaded.error } : {}),
  };
}

async function usage(
  ledger: RequestLedger,
): Promise<Partial<Record<DiscoverySource, number>>> {
  const statuses = await Promise.all(SOURCES.map(async (source) => ({
    source,
    used: (await ledger.canSpend(source, "diagnostic")).used,
  })));
  return Object.fromEntries(statuses.map(({ source, used }) => [source, used]));
}

async function takeSample(directory: string, now: number): Promise<DiscoveryBetaSummary> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const reportFile = path.join(directory, "beta-report.json");
  const document = await readDocument(reportFile, now);
  const lastSampleAt = document.samples.at(-1)?.sampledAt;
  if (lastSampleAt && now - Date.parse(lastSampleAt) < BETA_MIN_SAMPLE_GAP_MS) {
    return summarizeBeta(document, now);
  }

  const cache = createDiscoveryCacheRepository({
    file: path.join(directory, "discovery-cache.json"),
  });
  const ledger = createRequestLedger({
    file: path.join(directory, "discovery-usage.json"),
  });
  const service = createDiscoveryService({ cache, fetchImpl: fetch, now: () => now });
  const before = await usage(ledger);
  const skipBluray = process.env.MINCH_BETA_SKIP_BLURAY === "1";
  const outcomes = await Promise.all(uniqueTargets(ledger, skipBluray).map(async (target) => {
    try {
      return { target, ...(await settleLoad(target, service)) };
    } catch (error) {
      return {
        target,
        status: "failed",
        successfulRefresh: false,
        cacheHit: false,
        stale: false,
        error: error instanceof Error ? error : new Error(String(error)),
      };
    }
  }));
  await Promise.all([cache.flush(), ledger.flush()]);
  const after = await usage(ledger);
  const snapshots = outcomes.flatMap((outcome) => outcome.snapshot ? [outcome.snapshot] : []);
  const aggregation = aggregateDiscoverySnapshots(snapshots, { includeGenericPhysical: true });
  const sourceErrors: Record<string, number> = {};
  for (const outcome of outcomes) {
    if (outcome.error) {
      const key = `${outcome.target.adapter.id}:${errorCode(outcome.error)}`;
      sourceErrors[key] = (sourceErrors[key] ?? 0) + 1;
    }
  }
  const requestAttempts = Object.fromEntries(SOURCES.map((source) => [
    source,
    Math.max(0, (after[source] ?? 0) - (before[source] ?? 0)),
  ]));
  const sample: BetaSample = {
    sampledAt: new Date(now).toISOString(),
    requestAttempts,
    successfulRefreshes: outcomes.filter((outcome) => outcome.successfulRefresh).length,
    cacheHits: outcomes.filter((outcome) => outcome.cacheHit).length,
    stalePeriods: outcomes.filter((outcome) => outcome.stale).length,
    sourceErrors,
    uniqueTitles: aggregation.titles.length,
    uniqueEvents: aggregation.events.length,
    unknownDateEvents: aggregation.diagnostics.unknownDate,
    ambiguousMerges: aggregation.diagnostics.ambiguousIdentity,
    targetStatuses: outcomes.map((outcome) => ({
      key: outcome.target.key,
      status: outcome.status,
    })),
  };
  document.samples.push(sample);
  document.seenTitleHashes = [...new Set([
    ...document.seenTitleHashes,
    ...aggregation.titles.map((title) => hash(title.id)),
  ])];
  document.seenEventHashes = [...new Set([
    ...document.seenEventHashes,
    ...aggregation.events.map((event) => hash(event.id)),
  ])];
  document.unknownDateEventHashes = [...new Set([
    ...document.unknownDateEventHashes,
    ...aggregation.events.filter((event) => !event.date).map((event) => hash(event.id)),
  ])];
  await writeJsonAtomic(reportFile, document, { mode: 0o600 });
  return summarizeBeta(document, now);
}

async function status(directory: string, now: number): Promise<DiscoveryBetaSummary> {
  return summarizeBeta(await readDocument(path.join(directory, "beta-report.json"), now), now);
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "status";
  const directory = betaDirectory();
  const now = Date.now();
  if (command === "sample") {
    const summary = await withBetaSampleLock(
      directory,
      () => takeSample(directory, now),
      now,
    );
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  if (command === "status") {
    process.stdout.write(`${JSON.stringify(await status(directory, now), null, 2)}\n`);
    return;
  }
  if (command === "finalize") {
    const summary = await status(directory, now);
    if (!summary.windowComplete) {
      throw new Error(
        `Post-release soak incomplete: ${summary.sampleCount}/${BETA_REQUIRED_SAMPLES} samples across ${summary.sampledIndiaDays}/${BETA_DAYS} India days; minimum end ${summary.minimumEndsAt}`,
      );
    }
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  throw new Error("Usage: npm run beta:discovery -- [sample|status|finalize]");
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  void main().catch((error: unknown) => {
    const message = sanitizeDiscoveryText(
      error instanceof Error ? error.message : String(error),
      [
        process.env.TMDB_READ_TOKEN ?? "",
        process.env.STREAMING_AVAILABILITY_API_KEY ?? "",
      ],
    );
    process.stderr.write(`Discovery beta failed: ${message || "unknown error"}\n`);
    process.exitCode = 1;
  });
}
