import { pathToFileURL } from "node:url";
import { defaultConfig } from "../src/config/config";
import type { DiscoverySnapshot } from "../src/discovery/adapter";
import {
  createRequestLedger,
  type BudgetStatus,
} from "../src/discovery/budget";
import { indiaToday, shiftDateOnly } from "../src/discovery/dates";
import { createStreamingAvailabilityAdapter } from "../src/discovery/sources/streaming-availability";

export interface IndiaValidationSummary {
  sampledAt: string;
  window: { start: string; end: string };
  policy: {
    rawPayloadsIncluded: false;
    titlesIncluded: false;
    pageLimit: 1;
    providerScope: string[];
  };
  requestAttempts: number;
  truncated: boolean;
  eventCount: number;
  knownDateCount: number;
  unknownDateCount: number;
  providers: Record<string, number>;
  mediaTypes: Record<string, number>;
  originalLanguages: Record<string, number>;
  warningCodes: Record<string, number>;
}

function increment(target: Record<string, number>, key: string | undefined): void {
  target[key || "unknown"] = (target[key || "unknown"] ?? 0) + 1;
}

export function summarizeIndiaValidation(
  snapshot: DiscoverySnapshot,
  before: BudgetStatus,
  after: BudgetStatus,
  start: string,
  end: string,
): IndiaValidationSummary {
  const titleById = new Map(snapshot.titles.map((title) => [title.id, title]));
  const providers: Record<string, number> = {};
  const mediaTypes: Record<string, number> = {};
  const originalLanguages: Record<string, number> = {};
  const warningCodes: Record<string, number> = {};
  for (const event of snapshot.events) {
    increment(providers, event.providerId);
    const title = titleById.get(event.titleId);
    increment(mediaTypes, title?.mediaType);
    increment(originalLanguages, title?.originalLanguage);
  }
  for (const warning of snapshot.warnings) increment(warningCodes, warning.code);
  return {
    sampledAt: new Date(snapshot.fetchedAt).toISOString(),
    window: { start, end },
    policy: {
      rawPayloadsIncluded: false,
      titlesIncluded: false,
      pageLimit: 1,
      providerScope: ["netflix", "prime", "hotstar"],
    },
    requestAttempts: Math.max(0, after.used - before.used),
    truncated: snapshot.cursor !== undefined,
    eventCount: snapshot.events.length,
    knownDateCount: snapshot.events.filter((event) => event.date !== undefined).length,
    unknownDateCount: snapshot.events.filter((event) => event.date === undefined).length,
    providers,
    mediaTypes,
    originalLanguages,
    warningCodes,
  };
}

async function run(): Promise<IndiaValidationSummary> {
  const ledger = createRequestLedger();
  const today = indiaToday();
  const start = shiftDateOnly(today, -6);
  const before = await ledger.canSpend("streaming-availability", "changes");
  const adapter = createStreamingAvailabilityAdapter({
    config: defaultConfig,
    ledger,
    retries: 0,
  });
  const snapshot = await adapter.fetch({
    region: "IN",
    feedKind: "streaming_added",
    dateRange: { start, end: today, direction: "past" },
    mediaTypes: ["movie", "series"],
    providerIds: ["netflix", "prime", "hotstar"],
    pageLimit: 1,
  }, {
    fetchImpl: fetch,
    signal: AbortSignal.timeout(20_000),
  });
  await ledger.flush();
  const after = await ledger.canSpend("streaming-availability", "changes");
  return summarizeIndiaValidation(snapshot, before, after, start, today);
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  void run().then((summary) => {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`India discovery validation failed: ${message}\n`);
    process.exitCode = 1;
  });
}
