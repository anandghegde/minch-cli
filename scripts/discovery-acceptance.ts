import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  BETA_DAYS,
  BETA_RELEASE_REQUIRED_SAMPLES,
  BETA_REQUIRED_SAMPLES,
  summarizeBeta,
  type DiscoveryBetaDocument,
  type DiscoveryBetaSummary,
} from "./discovery-beta";
import {
  RELEVANCE_REQUIRED_OTT,
  RELEVANCE_REQUIRED_PHYSICAL,
  RELEVANCE_REVIEW_VERSION,
  summarizeRelevanceReview,
  type RelevanceReviewDocument,
  type RelevanceReviewSummary,
} from "./discovery-relevance-review";
import { aggregateDiscoverySnapshots, selectDiscoveryEntries } from "../src/discovery/aggregate";
import type { DiscoverySnapshot } from "../src/discovery/adapter";
import { parseDiscoveryCache } from "../src/discovery/cache";
import { indiaToday } from "../src/discovery/dates";
import {
  createRequestLedger,
  SOURCE_BUDGETS,
  type BudgetStatus,
} from "../src/discovery/budget";
import { aggregateDiscoveryStates, type DiscoverySourceState } from "../src/discovery/state";
import type { CatalogTitle, ReleaseEvent } from "../src/discovery/types";
import { applyFilters, emptyFilters, TIME_PRESETS } from "../src/sources/filters";
import type { TorrentResult } from "../src/sources/types";
import { sanitizeDiscoveryText } from "../src/discovery/security";

export const ACCEPTANCE_PROJECTION_DAYS = 31;
export const ACCEPTANCE_STREAMING_PROJECTION_LIMIT = 300;
export const ACCEPTANCE_RELEVANCE_THRESHOLD = 0.95;

export type AcceptanceStatus = "pass" | "fail" | "pending";

export interface AcceptanceMetric {
  status: AcceptanceStatus;
  releaseBlocking: boolean;
  requirement: string;
  evidence: Record<string, string | number | boolean | null>;
}

export interface DiscoveryInvariantEvidence {
  undatedTorrentsVisible: number;
  firstObservedDatedRows: number;
  availabilityOnlyRecentRows: number;
  retainedRowsAfterPeerFailure: number;
  usableSourcesAfterPeerFailure: number;
  cachedEventsAudited: number;
  cachedDatedEventsAudited: number;
  cachedDatedRowsWithoutSourceEvidence: number;
  cachedAvailabilityRowsWithoutChangeEvidence: number;
}

export interface StreamingProjection {
  observedSamples: number;
  scheduledSamples: number;
  bootstrapAttempts: number;
  maximumRecurringAttempts: number | null;
  projectedAttempts: number | null;
}

export interface DiscoveryAcceptanceReport {
  generatedAt: string;
  status: AcceptanceStatus;
  complete: boolean;
  releaseSamples: {
    status: AcceptanceStatus;
    sampleCount: number;
    requiredSamples: number;
  };
  postReleaseSoak: {
    status: AcceptanceStatus;
    sampleCount: number;
    requiredSamples: number;
    sampledIndiaDays: number;
    requiredIndiaDays: number;
    windowComplete: boolean;
    minimumEndsAt: string;
  };
  metrics: {
    torrentDateWindow: AcceptanceMetric;
    firstObservedDate: AcceptanceMetric;
    currentAvailability: AcceptanceMetric;
    highConfidenceAccuracy: AcceptanceMetric;
    streamingBudget: AcceptanceMetric;
    partialFailure: AcceptanceMetric;
  };
}

function betaDirectory(): string {
  const configured = process.env.MINCH_BETA_DIR?.trim();
  if (!configured) {
    throw new Error("Set MINCH_BETA_DIR to the isolated persistent beta directory");
  }
  return path.resolve(configured);
}

function torrent(name: string, added?: number): TorrentResult {
  return {
    infoHash: name.padEnd(40, "0").slice(0, 40),
    name,
    sizeBytes: 1,
    seeders: 1,
    leechers: 0,
    source: "acceptance",
    magnet: "magnet:?xt=urn:btih:0000000000000000000000000000000000000000",
    ...(added !== undefined ? { added } : {}),
  };
}

function catalogTitle(id: string, title: string): CatalogTitle {
  return {
    id,
    title,
    year: 2026,
    mediaType: "movie",
    originCountries: [],
    genreIds: [],
  };
}

function streamingChangeDate(event: ReleaseEvent): string | undefined {
  for (const evidence of event.evidence) {
    if (evidence.source !== "streaming-availability") continue;
    const match = /:(\d{10})$/.exec(evidence.sourceId ?? "");
    if (!match) continue;
    const timestamp = Number(match[1]);
    if (Number.isSafeInteger(timestamp) && timestamp > 0) {
      return indiaToday(timestamp * 1_000);
    }
  }
  return undefined;
}

function hasExplicitDateEvidence(event: ReleaseEvent): boolean {
  if (!event.date) return true;
  if (streamingChangeDate(event) === event.date) return true;
  return event.evidence.some((evidence) =>
    (evidence.source === "bluray" || evidence.source === "tmdb") &&
    evidence.confidence !== "inferred");
}

export function auditDiscoverySnapshots(
  snapshots: readonly DiscoverySnapshot[],
): Pick<DiscoveryInvariantEvidence,
  | "cachedEventsAudited"
  | "cachedDatedEventsAudited"
  | "cachedDatedRowsWithoutSourceEvidence"
  | "cachedAvailabilityRowsWithoutChangeEvidence"> {
  const events = snapshots.flatMap((snapshot) => snapshot.events);
  const dated = events.filter((event) => !!event.date);
  return {
    cachedEventsAudited: events.length,
    cachedDatedEventsAudited: dated.length,
    cachedDatedRowsWithoutSourceEvidence: dated.filter((event) =>
      !hasExplicitDateEvidence(event)).length,
    cachedAvailabilityRowsWithoutChangeEvidence: events.filter((event) =>
      event.kind === "streaming_added" && streamingChangeDate(event) !== event.date).length,
  };
}

/** Exercise production boundaries and audit every retained cache event. */
export function runDiscoveryInvariantProbes(
  cachedSnapshots: readonly DiscoverySnapshot[] = [],
): DiscoveryInvariantEvidence {
  const now = 2_000_000_000;
  const week = TIME_PRESETS.findIndex((preset) => preset.label === "week");
  if (week < 0) throw new Error("Week filter preset is unavailable");
  const filtered = applyFilters(
    [torrent("dated", now - 1), torrent("undated"), torrent("invalid", Number.NaN)],
    { ...emptyFilters, time: week },
    now,
  );

  const undatedTitle = catalogTitle("undated-title", "Observed but undated");
  const observedAt = Date.parse("2026-07-10T12:00:00.000Z");
  const undatedEvent: ReleaseEvent = {
    id: "undated-event",
    titleId: undatedTitle.id,
    kind: "streaming_added",
    region: "IN",
    datePrecision: "unknown",
    providerId: "netflix",
    providerLabel: "Netflix",
    status: "unknown",
    firstObservedAt: observedAt,
    lastObservedAt: observedAt,
    evidence: [{
      source: "streaming-availability",
      observedAt,
      confidence: "source_claim",
    }],
  };
  const availabilityTitle = catalogTitle("availability-title", "Availability only");
  const snapshot: DiscoverySnapshot = {
    source: "streaming-availability",
    feedKind: "streaming_added",
    titles: [undatedTitle, availabilityTitle],
    events: [undatedEvent],
    fetchedAt: observedAt,
    warnings: [],
  };
  const aggregation = aggregateDiscoverySnapshots([snapshot]);
  const recentRows = selectDiscoveryEntries(
    aggregation.feeds.ott,
    {
      date: {
        direction: "past",
        range: { start: "2026-07-04", end: "2026-07-10" },
      },
    },
    { direction: "past" },
  );

  const retained = catalogTitle("retained-title", "Retained peer row");
  const states: DiscoverySourceState[] = [{
    source: "tmdb",
    label: "TMDB",
    status: "ready",
    snapshot: {
      source: "tmdb",
      feedKind: "trending",
      titles: [retained],
      events: [],
      fetchedAt: observedAt,
      warnings: [],
    },
    warnings: [],
  }, {
    source: "bluray",
    label: "Blu-ray.com",
    status: "failed",
    warnings: [{
      source: "bluray",
      sourceLabel: "Blu-ray.com",
      code: "refresh-failed",
      message: "fixture failure",
    }],
    error: new Error("fixture failure"),
  }];
  const partial = aggregateDiscoveryStates(states);
  const cached = auditDiscoverySnapshots(cachedSnapshots);

  return {
    undatedTorrentsVisible: filtered.filter((result) => !Number.isFinite(result.added)).length,
    firstObservedDatedRows: recentRows.filter((entry) =>
      entry.event?.id === undatedEvent.id).length,
    availabilityOnlyRecentRows: aggregation.feeds.ott.filter((entry) =>
      entry.title?.id === availabilityTitle.id).length,
    retainedRowsAfterPeerFailure: partial.titles.filter((title) => title.id === retained.id).length,
    usableSourcesAfterPeerFailure: partial.usableSources,
    ...cached,
  };
}

export function projectStreamingAttempts(
  document: DiscoveryBetaDocument,
): StreamingProjection {
  const scheduledSamples = Math.ceil(
    ACCEPTANCE_PROJECTION_DAYS * 24 / document.scheduleHours,
  );
  const attempts = document.samples.map((sample) =>
    sample.requestAttempts["streaming-availability"] ?? 0);
  const recurring = attempts.slice(1);
  const maximumRecurringAttempts = recurring.length > 0 ? Math.max(...recurring) : null;
  return {
    observedSamples: attempts.length,
    scheduledSamples,
    bootstrapAttempts: attempts[0] ?? 0,
    maximumRecurringAttempts,
    projectedAttempts: maximumRecurringAttempts === null
      ? null
      : (attempts[0] ?? 0) + maximumRecurringAttempts * (scheduledSamples - 1),
  };
}

function metric(
  status: AcceptanceStatus,
  requirement: string,
  evidence: AcceptanceMetric["evidence"],
  releaseBlocking = true,
): AcceptanceMetric {
  return { status, releaseBlocking, requirement, evidence };
}

export function evaluateDiscoveryAcceptance(input: {
  betaDocument: DiscoveryBetaDocument;
  betaSummary: DiscoveryBetaSummary;
  relevanceSummary: RelevanceReviewSummary;
  budgetStatus: BudgetStatus;
  invariants: DiscoveryInvariantEvidence;
  now?: number;
}): DiscoveryAcceptanceReport {
  const projection = projectStreamingAttempts(input.betaDocument);
  const hardCap = SOURCE_BUDGETS["streaming-availability"]?.hardCap ?? null;
  const relevanceReady = input.relevanceSummary.complete &&
    input.relevanceSummary.highConfidenceEventAccuracy !== null;
  const relevanceStatus: AcceptanceStatus = !relevanceReady
    ? "pending"
    : input.relevanceSummary.highConfidenceEventAccuracy! >= ACCEPTANCE_RELEVANCE_THRESHOLD
      ? "pass"
      : "fail";
  const projectionReady = projection.projectedAttempts !== null;
  const streamingStatus: AcceptanceStatus = !projectionReady
    ? "pending"
    : projection.projectedAttempts! < ACCEPTANCE_STREAMING_PROJECTION_LIMIT &&
        hardCap === 450 && input.budgetStatus.used <= 450
      ? "pass"
      : "fail";
  const releaseSampleStatus: AcceptanceStatus = input.betaSummary.releaseReady
    ? "pass"
    : "pending";
  const soakStatus: AcceptanceStatus = input.betaSummary.windowComplete ? "pass" : "pending";

  const metrics: DiscoveryAcceptanceReport["metrics"] = {
    torrentDateWindow: metric(
      input.invariants.undatedTorrentsVisible === 0 ? "pass" : "fail",
      "0 undated torrents visible under an active date window",
      { undatedVisible: input.invariants.undatedTorrentsVisible },
    ),
    firstObservedDate: metric(
      input.invariants.firstObservedDatedRows === 0 &&
          input.invariants.cachedDatedRowsWithoutSourceEvidence === 0
        ? "pass"
        : "fail",
      "0 discovery rows falsely dated from firstObservedAt",
      {
        boundaryViolations: input.invariants.firstObservedDatedRows,
        cachedEventsAudited: input.invariants.cachedEventsAudited,
        cachedDatedEventsAudited: input.invariants.cachedDatedEventsAudited,
        cachedRowsWithoutSourceDateEvidence:
          input.invariants.cachedDatedRowsWithoutSourceEvidence,
      },
    ),
    currentAvailability: metric(
      input.invariants.availabilityOnlyRecentRows === 0 &&
          input.invariants.cachedAvailabilityRowsWithoutChangeEvidence === 0
        ? "pass"
        : "fail",
      "0 current-availability records mislabeled as recently added",
      {
        boundaryViolations: input.invariants.availabilityOnlyRecentRows,
        cachedRowsWithoutChangeEvidence:
          input.invariants.cachedAvailabilityRowsWithoutChangeEvidence,
      },
    ),
    highConfidenceAccuracy: metric(
      relevanceStatus,
      "At least 95% of sampled high-confidence events have correct title/date/provider-or-format",
      {
        accuracy: input.relevanceSummary.highConfidenceEventAccuracy,
        threshold: ACCEPTANCE_RELEVANCE_THRESHOLD,
        highConfidenceEvents: input.relevanceSummary.highConfidenceEvents,
        correctEvents: input.relevanceSummary.highConfidenceCorrectEvents,
        reviewedOtt: input.relevanceSummary.reviewed.ott,
        requiredOtt: input.relevanceSummary.required.ott,
        reviewedPhysical: input.relevanceSummary.reviewed.physical,
        requiredPhysical: input.relevanceSummary.required.physical,
      },
      false,
    ),
    streamingBudget: metric(
      streamingStatus,
      "Automatic Streaming Availability use projects below 300 calls/31 days and never exceeds 450",
      {
        observedSamples: projection.observedSamples,
        scheduledSamples: projection.scheduledSamples,
        bootstrapAttempts: projection.bootstrapAttempts,
        maximumRecurringAttempts: projection.maximumRecurringAttempts,
        projectedAttempts: projection.projectedAttempts,
        projectionLimit: ACCEPTANCE_STREAMING_PROJECTION_LIMIT,
        currentLedgerAttempts: input.budgetStatus.used,
        hardCap,
      },
    ),
    partialFailure: metric(
      input.invariants.retainedRowsAfterPeerFailure > 0 &&
          input.invariants.usableSourcesAfterPeerFailure > 0
        ? "pass"
        : "fail",
      "One upstream failure still leaves other or cached feeds usable",
      {
        retainedRows: input.invariants.retainedRowsAfterPeerFailure,
        usableSources: input.invariants.usableSourcesAfterPeerFailure,
      },
    ),
  };
  const releaseMetrics = Object.values(metrics).filter((item) => item.releaseBlocking);
  const hasFailure = releaseMetrics.some((item) => item.status === "fail");
  const complete = releaseSampleStatus === "pass" &&
    releaseMetrics.every((item) => item.status === "pass");
  return {
    generatedAt: new Date(input.now ?? Date.now()).toISOString(),
    status: hasFailure ? "fail" : complete ? "pass" : "pending",
    complete,
    releaseSamples: {
      status: releaseSampleStatus,
      sampleCount: input.betaSummary.sampleCount,
      requiredSamples: BETA_RELEASE_REQUIRED_SAMPLES,
    },
    postReleaseSoak: {
      status: soakStatus,
      sampleCount: input.betaSummary.sampleCount,
      requiredSamples: BETA_REQUIRED_SAMPLES,
      sampledIndiaDays: input.betaSummary.sampledIndiaDays,
      requiredIndiaDays: BETA_DAYS,
      windowComplete: input.betaSummary.windowComplete,
      minimumEndsAt: input.betaSummary.minimumEndsAt,
    },
    metrics,
  };
}

function validBetaDocument(value: unknown): value is DiscoveryBetaDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const document = value as Partial<DiscoveryBetaDocument>;
  return document.version === 1 &&
    document.scheduleHours === 12 &&
    Array.isArray(document.samples) &&
    Array.isArray(document.seenTitleHashes) &&
    Array.isArray(document.seenEventHashes) &&
    Array.isArray(document.unknownDateEventHashes) &&
    typeof document.startedAt === "string" &&
    typeof document.minimumEndsAt === "string";
}

function validRelevanceDocument(value: unknown): value is RelevanceReviewDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const document = value as Partial<RelevanceReviewDocument>;
  return document.version === RELEVANCE_REVIEW_VERSION &&
    document.requirements?.ott === RELEVANCE_REQUIRED_OTT &&
    document.requirements.physical === RELEVANCE_REQUIRED_PHYSICAL &&
    Array.isArray(document.samples);
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
}

async function currentReport(directory: string, now: number): Promise<DiscoveryAcceptanceReport> {
  const betaValue = await readJson(path.join(directory, "beta-report.json"));
  if (!validBetaDocument(betaValue)) throw new Error("beta report has an unsupported shape");
  const relevanceValue = await readJson(path.join(directory, "relevance-review.json"));
  if (!validRelevanceDocument(relevanceValue)) {
    throw new Error("relevance review has an unsupported shape");
  }
  const cacheValue = await readJson(path.join(directory, "discovery-cache.json"));
  const cache = parseDiscoveryCache(cacheValue);
  if (cache.documentError || cache.rejectedEntries.length > 0) {
    throw new Error(
      `discovery cache audit unavailable: ${cache.documentError ?? `${cache.rejectedEntries.length} rejected entries`}`,
    );
  }
  const snapshots = Object.values(cache.document.entries).map((entry) => entry.snapshot);
  const ledger = createRequestLedger({ file: path.join(directory, "discovery-usage.json") });
  const budgetStatus = await ledger.canSpend("streaming-availability", "acceptance", now);
  await ledger.flush();
  return evaluateDiscoveryAcceptance({
    betaDocument: betaValue,
    betaSummary: summarizeBeta(betaValue, now),
    relevanceSummary: summarizeRelevanceReview(relevanceValue),
    budgetStatus,
    invariants: runDiscoveryInvariantProbes(snapshots),
    now,
  });
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "status";
  if (command !== "status" && command !== "finalize") {
    throw new Error("Usage: discovery acceptance [status|finalize]");
  }
  const report = await currentReport(betaDirectory(), Date.now());
  if (command === "finalize" && !report.complete) {
    const pending = [
      ...(report.releaseSamples.status === "pass" ? [] : ["releaseSamples"]),
      ...Object.entries(report.metrics)
        .filter(([, value]) => value.releaseBlocking && value.status !== "pass")
        .map(([key, value]) => `${key}:${value.status}`),
    ];
    throw new Error(`Discovery acceptance incomplete: ${pending.join(", ")}`);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
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
    process.stderr.write(`Discovery acceptance failed: ${message || "unknown error"}\n`);
    process.exitCode = 1;
  });
}
