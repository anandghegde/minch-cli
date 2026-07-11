import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { defaultConfig } from "../src/config/config";
import { createRequestLedger } from "../src/discovery/budget";
import { createDiscoveryCacheRepository } from "../src/discovery/cache-repository";
import { indiaToday } from "../src/discovery/dates";
import { sanitizeDiscoveryText } from "../src/discovery/security";
import { createDiscoveryService } from "../src/discovery/service";
import { buildDiscoveryLoadTargets } from "../src/ui/hooks/useDiscovery";
import { withBetaSampleLock } from "./discovery-beta";

/** Last contract-spike RSS poll was 2026-07-10 06:11 UTC; retain its 24h boundary. */
export const PHYSICAL_REFRESH_NOT_BEFORE_MS = Date.parse("2026-07-11T06:11:00.000Z");

export interface PhysicalRefreshSummary {
  refreshedAt: string;
  status: "fresh" | "refreshed";
  requestAttempts: number;
  titles: number;
  events: number;
  datedEvents: number;
  blurayEvents: number;
  uhdBlurayEvents: number;
  unknownRegionEvents: number;
}

export interface PhysicalRefreshOptions {
  directory: string;
  now?: number;
  fetchImpl?: typeof fetch;
}

export function assertPhysicalRefreshDue(now = Date.now()): void {
  if (now < PHYSICAL_REFRESH_NOT_BEFORE_MS) {
    throw new Error(
      `Blu-ray refresh is not permitted before ${new Date(PHYSICAL_REFRESH_NOT_BEFORE_MS).toISOString()}`,
    );
  }
}

/**
 * Refresh only the restricted Blu-ray RSS target in the isolated beta cache.
 * The normal service policy makes repeats inside 24 hours read-only cache hits.
 */
export async function refreshPhysicalCache(
  options: PhysicalRefreshOptions,
): Promise<PhysicalRefreshSummary> {
  const now = options.now ?? Date.now();
  assertPhysicalRefreshDue(now);
  const directory = path.resolve(options.directory);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
  const cache = createDiscoveryCacheRepository({
    file: path.join(directory, "discovery-cache.json"),
  });
  const ledger = createRequestLedger({
    file: path.join(directory, "discovery-usage.json"),
  });
  const target = buildDiscoveryLoadTargets(
    defaultConfig,
    "bluray",
    "30d",
    ledger,
    indiaToday(now),
  ).find((candidate) => candidate.key === "bluray:rss");
  if (!target) throw new Error("Blu-ray RSS target is unavailable");
  const before = (await ledger.canSpend("bluray", "rss", now)).used;
  const service = createDiscoveryService({
    cache,
    fetchImpl: options.fetchImpl ?? fetch,
    now: () => now,
  });
  try {
    const loaded = await service.load(target.adapter, target.request, {
      signal: AbortSignal.timeout(30_000),
    });
    let snapshot = loaded.snapshot;
    let failure = loaded.error;
    let status: PhysicalRefreshSummary["status"] = loaded.cacheState === "fresh"
      ? "fresh"
      : "refreshed";
    if (loaded.refreshing && loaded.refresh) {
      const refreshed = await loaded.refresh;
      snapshot = refreshed.snapshot;
      failure = refreshed.error;
      status = "refreshed";
    }
    if (failure || !snapshot) {
      throw failure ?? new Error("Blu-ray refresh returned no snapshot");
    }
    if (snapshot.source !== "bluray") {
      throw new Error("Blu-ray refresh returned the wrong source");
    }
    await Promise.all([cache.flush(), ledger.flush()]);
    const after = (await ledger.canSpend("bluray", "rss", now)).used;
    return {
      refreshedAt: new Date(now).toISOString(),
      status,
      requestAttempts: Math.max(0, after - before),
      titles: snapshot.titles.length,
      events: snapshot.events.length,
      datedEvents: snapshot.events.filter((event) => !!event.date).length,
      blurayEvents: snapshot.events.filter((event) => event.kind === "bluray").length,
      uhdBlurayEvents: snapshot.events.filter((event) => event.kind === "uhd_bluray").length,
      unknownRegionEvents: snapshot.events.filter((event) => event.region === "ZZ").length,
    };
  } finally {
    await Promise.all([cache.flush(), ledger.flush()]);
  }
}

function betaDirectory(): string {
  const configured = process.env.MINCH_BETA_DIR?.trim();
  if (!configured) {
    throw new Error("Set MINCH_BETA_DIR to the isolated persistent beta directory");
  }
  return path.resolve(configured);
}

async function main(): Promise<void> {
  const directory = betaDirectory();
  const now = Date.now();
  const summary = await withBetaSampleLock(
    directory,
    () => refreshPhysicalCache({ directory, now }),
    now,
  );
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
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
    process.stderr.write(`Discovery physical refresh failed: ${message || "unknown error"}\n`);
    process.exitCode = 1;
  });
}
