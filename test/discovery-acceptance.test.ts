import { describe, expect, it } from "vitest";
import {
  auditDiscoverySnapshots,
  evaluateDiscoveryAcceptance,
  projectStreamingAttempts,
  runDiscoveryInvariantProbes,
} from "../scripts/discovery-acceptance";
import {
  summarizeBeta,
  type BetaSample,
  type DiscoveryBetaDocument,
} from "../scripts/discovery-beta";
import type { RelevanceReviewSummary } from "../scripts/discovery-relevance-review";
import type { BudgetStatus } from "../src/discovery/budget";
import type { DiscoverySnapshot } from "../src/discovery/adapter";

const START = Date.parse("2026-07-10T00:00:00.000Z");

function sample(index: number, streamingAttempts: number): BetaSample {
  return {
    sampledAt: new Date(START + index * 12 * 60 * 60 * 1_000).toISOString(),
    requestAttempts: { "streaming-availability": streamingAttempts },
    successfulRefreshes: 1,
    cacheHits: 0,
    stalePeriods: 0,
    sourceErrors: {},
    uniqueTitles: 1,
    uniqueEvents: 1,
    unknownDateEvents: 0,
    ambiguousMerges: 0,
    targetStatuses: [],
  };
}

function beta(attempts: number[], complete = false): DiscoveryBetaDocument {
  const samples = complete
    ? Array.from({ length: 15 }, (_, index) => sample(index, index === 0 ? 5 : 4))
    : attempts.map((value, index) => sample(index, value));
  return {
    version: 1,
    startedAt: new Date(START).toISOString(),
    minimumEndsAt: new Date(START + 7 * 86_400_000).toISOString(),
    scheduleHours: 12,
    requiredSamples: 15,
    samples,
    seenTitleHashes: ["title"],
    seenEventHashes: ["event"],
    unknownDateEventHashes: [],
  };
}

function relevance(
  complete: boolean,
  accuracy: number | null,
): RelevanceReviewSummary {
  return {
    required: { ott: 30, physical: 20 },
    available: { ott: 30, physical: 20 },
    sampled: { ott: 30, physical: 20 },
    reviewed: complete ? { ott: 30, physical: 20 } : { ott: 0, physical: 0 },
    passed: complete ? { ott: 30, physical: 20 } : { ott: 0, physical: 0 },
    errors: { ott: 0, physical: 0 },
    unverifiable: { ott: 0, physical: 0 },
    checkedFields: complete ? 250 : 0,
    correctFields: complete ? 250 : 0,
    highConfidenceEvents: accuracy === null ? 0 : 50,
    highConfidenceCorrectEvents: accuracy === null ? 0 : Math.round(50 * accuracy),
    highConfidenceEventAccuracy: accuracy,
    errorsBySourceAndType: {},
    complete,
  };
}

function budget(used = 9): BudgetStatus {
  return {
    source: "streaming-availability",
    endpoint: "acceptance",
    month: "2026-07",
    used,
    endpointUsed: 0,
    allowed: used < 450,
    warning: used >= 350,
    softWarning: 350,
    hardCap: 450,
    remaining: Math.max(0, 450 - used),
  };
}

describe("P11.4 discovery acceptance gate", () => {
  it("directly proves the date, availability, and partial-failure invariants", () => {
    expect(runDiscoveryInvariantProbes()).toEqual({
      undatedTorrentsVisible: 0,
      firstObservedDatedRows: 0,
      availabilityOnlyRecentRows: 0,
      retainedRowsAfterPeerFailure: 1,
      usableSourcesAfterPeerFailure: 1,
      cachedEventsAudited: 0,
      cachedDatedEventsAudited: 0,
      cachedDatedRowsWithoutSourceEvidence: 0,
      cachedAvailabilityRowsWithoutChangeEvidence: 0,
    });
  });

  it("audits retained dates and recent-add rows for source-specific evidence", () => {
    const snapshot: DiscoverySnapshot = {
      source: "streaming-availability",
      feedKind: "streaming_added",
      titles: [],
      events: [{
        id: "valid",
        titleId: "title-valid",
        kind: "streaming_added",
        region: "IN",
        date: "2026-07-10",
        datePrecision: "day",
        status: "past",
        firstObservedAt: START,
        lastObservedAt: START,
        evidence: [{
          source: "streaming-availability",
          sourceId: "in:netflix:new:show:1:1783688594",
          observedAt: START,
          confidence: "exact",
        }],
      }, {
        id: "invalid",
        titleId: "title-invalid",
        kind: "streaming_added",
        region: "IN",
        date: "2026-07-10",
        datePrecision: "day",
        status: "past",
        firstObservedAt: START,
        lastObservedAt: START,
        evidence: [{
          source: "streaming-availability",
          sourceId: "current-provider-presence",
          observedAt: START,
          confidence: "inferred",
        }],
      }],
      fetchedAt: START,
      warnings: [],
    };
    expect(auditDiscoverySnapshots([snapshot])).toEqual({
      cachedEventsAudited: 2,
      cachedDatedEventsAudited: 2,
      cachedDatedRowsWithoutSourceEvidence: 1,
      cachedAvailabilityRowsWithoutChangeEvidence: 1,
    });
  });

  it("projects bootstrap plus the maximum observed recurring work over 31 days", () => {
    expect(projectStreamingAttempts(beta([5]))).toMatchObject({
      observedSamples: 1,
      scheduledSamples: 62,
      bootstrapAttempts: 5,
      maximumRecurringAttempts: null,
      projectedAttempts: null,
    });
    expect(projectStreamingAttempts(beta([5, 4]))).toMatchObject({
      observedSamples: 2,
      scheduledSamples: 62,
      maximumRecurringAttempts: 4,
      projectedAttempts: 249,
    });
  });

  it("ships after two samples while keeping soak and human review visible", () => {
    const document = beta([5, 4]);
    const report = evaluateDiscoveryAcceptance({
      betaDocument: document,
      betaSummary: summarizeBeta(document, START + 86_400_000),
      relevanceSummary: relevance(false, null),
      budgetStatus: budget(),
      invariants: runDiscoveryInvariantProbes(),
      now: START + 86_400_000,
    });
    expect(report).toMatchObject({
      status: "pass",
      complete: true,
      releaseSamples: { status: "pass", sampleCount: 2, requiredSamples: 2 },
      postReleaseSoak: { status: "pending", sampleCount: 2, requiredSamples: 15 },
      metrics: {
        torrentDateWindow: { status: "pass" },
        firstObservedDate: { status: "pass" },
        currentAvailability: { status: "pass" },
        highConfidenceAccuracy: { status: "pending", releaseBlocking: false },
        streamingBudget: {
          status: "pass",
          evidence: { projectedAttempts: 249, hardCap: 450 },
        },
        partialFailure: { status: "pass" },
      },
    });
  });

  it("keeps one sample pending and exposes failures in blocking metrics", () => {
    const oneSample = beta([5]);
    const pending = evaluateDiscoveryAcceptance({
      betaDocument: oneSample,
      betaSummary: summarizeBeta(oneSample, START + 12 * 60 * 60 * 1_000),
      relevanceSummary: relevance(false, null),
      budgetStatus: budget(5),
      invariants: runDiscoveryInvariantProbes(),
      now: START + 12 * 60 * 60 * 1_000,
    });
    expect(pending).toMatchObject({
      status: "pending",
      complete: false,
      releaseSamples: { status: "pending" },
    });

    const completed = beta([], true);
    const pass = evaluateDiscoveryAcceptance({
      betaDocument: completed,
      betaSummary: summarizeBeta(completed, START + 7 * 86_400_000),
      relevanceSummary: relevance(true, 0.96),
      budgetStatus: budget(249),
      invariants: runDiscoveryInvariantProbes(),
      now: START + 7 * 86_400_000,
    });
    expect(pass).toMatchObject({
      status: "pass",
      complete: true,
      postReleaseSoak: { status: "pass" },
    });

    const expensive = beta([5, 5]);
    const fail = evaluateDiscoveryAcceptance({
      betaDocument: expensive,
      betaSummary: summarizeBeta(expensive, START + 86_400_000),
      relevanceSummary: relevance(true, 0.94),
      budgetStatus: budget(451),
      invariants: {
        ...runDiscoveryInvariantProbes(),
        firstObservedDatedRows: 1,
        cachedAvailabilityRowsWithoutChangeEvidence: 1,
      },
      now: START + 86_400_000,
    });
    expect(fail).toMatchObject({
      status: "fail",
      complete: false,
      metrics: {
        firstObservedDate: { status: "fail" },
        currentAvailability: { status: "fail" },
        highConfidenceAccuracy: { status: "fail" },
        streamingBudget: {
          status: "fail",
          evidence: { projectedAttempts: 310, currentLedgerAttempts: 451 },
        },
      },
    });
  });
});
