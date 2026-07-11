import { describe, expect, it } from "vitest";
import {
  initializeRelevanceReview,
  recordRelevanceJudgment,
  relevanceCandidates,
  summarizeRelevanceReview,
  type RelevanceReviewDocument,
} from "../scripts/discovery-relevance-review";
import type { DiscoverySnapshot } from "../src/discovery/adapter";
import type { CatalogTitle, ReleaseEvent } from "../src/discovery/types";

function title(id: string, name: string, mediaType: "movie" | "series"): CatalogTitle {
  return {
    id,
    title: name,
    year: 2026,
    mediaType,
    tmdbId: Number(id.replace(/\D/g, "")) + 1,
    originCountries: [],
    genreIds: [],
  };
}

function ottEvent(index: number, eventId = `ott-event-${index}`): ReleaseEvent {
  return {
    id: eventId,
    titleId: `ott-title-${index}`,
    kind: "streaming_added",
    region: "IN",
    date: `2026-07-${String((index % 9) + 1).padStart(2, "0")}`,
    datePrecision: "day",
    providerId: index % 3 === 0 ? "netflix" : index % 3 === 1 ? "prime" : "hotstar",
    providerLabel: index % 3 === 0 ? "Netflix" : index % 3 === 1 ? "Prime Video" : "JioHotstar",
    status: "past",
    firstObservedAt: 1,
    lastObservedAt: 1,
    evidence: [{
      source: "streaming-availability",
      sourceId: eventId,
      sourceUrl: `https://example.test/ott/${index}`,
      observedAt: 1,
      confidence: "exact",
    }],
  };
}

function physicalEvent(index: number): ReleaseEvent {
  const uhd = index % 2 === 0;
  return {
    id: `physical-event-${index}`,
    titleId: `physical-title-${index}`,
    kind: uhd ? "uhd_bluray" : "bluray",
    region: "ZZ",
    date: `2026-07-${String((index % 9) + 1).padStart(2, "0")}`,
    datePrecision: "day",
    formatLabel: uhd ? "4K UHD Blu-ray" : "Blu-ray",
    status: "past",
    firstObservedAt: 1,
    lastObservedAt: 1,
    evidence: [{
      source: "bluray",
      sourceId: `physical-source-${index}`,
      sourceUrl: `https://www.blu-ray.com/movies/${index}`,
      observedAt: 1,
      confidence: "source_claim",
    }],
  };
}

function snapshots(): DiscoverySnapshot[] {
  const ottTitles = Array.from({ length: 35 }, (_, index) =>
    title(`ott-title-${index}`, `OTT ${index}`, index % 2 === 0 ? "movie" : "series"));
  const ottEvents = Array.from({ length: 35 }, (_, index) => ottEvent(index));
  // A second raw event with the same semantic claim must merge before sampling.
  ottEvents.push({
    ...ottEvent(0, "ott-event-0-duplicate"),
    evidence: [{
      source: "streaming-availability",
      sourceId: "duplicate-source-row",
      observedAt: 2,
      confidence: "exact",
    }],
    firstObservedAt: 2,
    lastObservedAt: 2,
  });
  const physicalTitles = Array.from({ length: 25 }, (_, index) =>
    title(`physical-title-${index}`, `Physical ${index}`, "movie"));
  return [{
    source: "streaming-availability",
    feedKind: "streaming_added",
    titles: ottTitles,
    events: ottEvents,
    fetchedAt: 1,
    warnings: [],
  }, {
    source: "bluray",
    feedKind: "bluray",
    titles: physicalTitles,
    events: Array.from({ length: 25 }, (_, index) => physicalEvent(index)),
    fetchedAt: 1,
    warnings: [],
  }];
}

describe("P11.2 discovery relevance review", () => {
  it("selects a deterministic, canonical 30 OTT and 20 physical sample", () => {
    const inputs = snapshots();
    inputs[0]!.events[0]!.evidence[0]!.sourceId =
      "in:netflix:new:show:0:1783688594";
    const candidates = relevanceCandidates(inputs);
    expect(candidates.ott).toHaveLength(35);
    expect(candidates.physical).toHaveLength(25);
    expect(candidates.ott[0]!.evidenceRefs[0]).toMatchObject({
      source: "streaming-availability",
      confidence: "exact",
    });
    expect(candidates.ott.flatMap((item) => item.evidenceRefs).find(
      (evidence) => evidence.sourceTimestampUnixSeconds === 1_783_688_594,
    )).toMatchObject({ sourceTimestampIndiaDate: "2026-07-10" });
    expect(candidates.ott.find((item) => item.duplicateContext.mergedEvidenceCount === 2))
      .toBeDefined();

    const first = initializeRelevanceReview(inputs, undefined, 1_000);
    const second = initializeRelevanceReview(structuredClone(inputs), undefined, 1_000);
    expect(second).toEqual(first);
    expect(first.available).toEqual({ ott: 35, physical: 25 });
    expect(first.samples.filter((item) => item.category === "ott")).toHaveLength(30);
    expect(first.samples.filter((item) => item.category === "physical")).toHaveLength(20);
    expect(new Set(first.samples.map((item) => item.id)).size).toBe(first.samples.length);
    expect(first.samples.filter((item) => item.category === "ott")
      .every((item) => item.region === "IN" && !!item.providerOrFormat)).toBe(true);
    expect(first.samples.filter((item) => item.category === "physical")
      .every((item) => item.region === "ZZ" && !!item.providerOrFormat)).toBe(true);
  });

  it("retains judgments across refreshes and records field errors by source", () => {
    const document = initializeRelevanceReview(snapshots(), undefined, 1_000);
    const ott = document.samples.filter((item) => item.category === "ott");
    const physical = document.samples.filter((item) => item.category === "physical");
    recordRelevanceJudgment(document, ott[0]!.id, "pass", [], undefined, 2_000);
    recordRelevanceJudgment(
      document,
      ott[1]!.id,
      "error",
      ["date", "duplicate_behavior"],
      "Source page disagreed",
      2_000,
    );
    recordRelevanceJudgment(document, physical[0]!.id, "unverifiable", [], "Link unavailable", 2_000);

    expect(summarizeRelevanceReview(document)).toMatchObject({
      reviewed: { ott: 2, physical: 0 },
      passed: { ott: 1, physical: 0 },
      errors: { ott: 1, physical: 0 },
      unverifiable: { ott: 0, physical: 1 },
      checkedFields: 10,
      correctFields: 8,
      highConfidenceEvents: 2,
      highConfidenceCorrectEvents: 1,
      highConfidenceEventAccuracy: 0.5,
      errorsBySourceAndType: {
        "streaming-availability": { date: 1, duplicate_behavior: 1 },
      },
      complete: false,
    });
    expect(() => recordRelevanceJudgment(document, ott[2]!.id, "error", [], undefined))
      .toThrow("must name at least one error type");
    expect(() => recordRelevanceJudgment(document, ott[2]!.id, "pass", ["title"], undefined))
      .toThrow("cannot contain errors");

    for (const item of document.samples) {
      if (!item.judgment || item.judgment.verdict === "unverifiable") {
        recordRelevanceJudgment(document, item.id, "pass", [], undefined, 3_000);
      }
    }
    const complete = summarizeRelevanceReview(document);
    expect(complete.reviewed).toEqual({ ott: 30, physical: 20 });
    expect(complete.complete).toBe(true);

    const refreshed = initializeRelevanceReview(
      structuredClone(snapshots()),
      document as RelevanceReviewDocument,
      4_000,
    );
    expect(refreshed.samples.find((item) => item.id === ott[1]!.id)?.judgment)
      .toMatchObject({ verdict: "error", errorTypes: ["date", "duplicate_behavior"] });
    expect(refreshed.samples.every((item) => item.evidenceRefs.length > 0)).toBe(true);
  });
});
