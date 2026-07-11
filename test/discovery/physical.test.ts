import { describe, expect, it } from "vitest";
import {
  filterPhysicalEventsByDate,
  reconcilePhysicalEvents,
} from "../../src/discovery/physical";
import type {
  CatalogTitle,
  EvidenceConfidence,
  ReleaseEvent,
  ReleaseKind,
} from "../../src/discovery/types";

const titles: CatalogTitle[] = [
  {
    id: "tmdb-title",
    title: "Shared Film",
    year: 2026,
    mediaType: "movie",
    tmdbId: 42,
    originCountries: [],
    genreIds: [],
  },
  {
    id: "bluray-title",
    title: "Shared Film",
    year: 2026,
    mediaType: "movie",
    tmdbId: 42,
    originCountries: [],
    genreIds: [],
  },
];

function event(
  id: string,
  titleId: string,
  kind: ReleaseKind,
  date: string,
  source: "tmdb" | "bluray",
  confidence: EvidenceConfidence,
  region = "IN",
): ReleaseEvent {
  return {
    id,
    titleId,
    kind,
    region,
    date,
    datePrecision: "day",
    formatLabel: kind === "physical" ? "Physical" : kind === "bluray" ? "Blu-ray" : "4K UHD Blu-ray",
    status: "past",
    firstObservedAt: 1,
    lastObservedAt: 2,
    evidence: [{ source, sourceId: id, observedAt: 1, confidence }],
  };
}

describe("physical source precedence", () => {
  it("shows Blu-ray specificity over generic physical when the date agrees", () => {
    const result = reconcilePhysicalEvents(titles, [
      event("generic", "tmdb-title", "physical", "2026-07-10", "tmdb", "inferred"),
      event("specific", "bluray-title", "bluray", "2026-07-10", "bluray", "source_claim", "ZZ"),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      formatGroup: "disc",
      displayEvent: { id: "specific", kind: "bluray" },
      sourcesDisagree: false,
    });
    expect(result[0]!.claims).toHaveLength(2);
  });

  it("merges evidence for identical claims", () => {
    const result = reconcilePhysicalEvents(titles, [
      event("a", "tmdb-title", "physical", "2026-07-10", "tmdb", "exact"),
      event("b", "bluray-title", "physical", "2026-07-10", "bluray", "source_claim"),
    ]);

    expect(result[0]!.displayEvent.evidence.map((item) => item.source).sort())
      .toEqual(["bluray", "tmdb"]);
    expect(result[0]!.claims.map((claim) => claim.id)).toEqual(["a", "b"]);
  });

  it("preserves conflicting dates and displays the higher-confidence claim", () => {
    const result = reconcilePhysicalEvents(titles, [
      event("exact-generic", "tmdb-title", "physical", "2026-07-09", "tmdb", "exact"),
      event("claimed-bluray", "bluray-title", "bluray", "2026-07-10", "bluray", "source_claim", "ZZ"),
    ]);

    expect(result[0]).toMatchObject({
      sourcesDisagree: true,
      displayEvent: { id: "exact-generic", date: "2026-07-09", kind: "physical" },
    });
    expect(result[0]!.claims.map((claim) => claim.date).sort())
      .toEqual(["2026-07-09", "2026-07-10"]);
  });

  it("keeps explicit UHD separate from Blu-ray/generic disc claims", () => {
    const result = reconcilePhysicalEvents(titles, [
      event("disc", "bluray-title", "bluray", "2026-07-10", "bluray", "source_claim", "ZZ"),
      event("uhd", "bluray-title", "uhd_bluray", "2026-07-10", "bluray", "source_claim", "ZZ"),
    ]);
    expect(result.map((group) => group.formatGroup).sort()).toEqual(["disc", "uhd"]);
  });

  it("requires a known in-window date only when a physical date window is active", () => {
    const known = event("known", "bluray-title", "bluray", "2026-07-10", "bluray", "source_claim", "ZZ");
    const old = event("old", "bluray-title", "bluray", "2026-06-01", "bluray", "source_claim", "ZZ");
    const unknown = { ...known, id: "unknown", date: undefined, datePrecision: "unknown" as const };
    const events = [unknown, old, known];

    expect(filterPhysicalEventsByDate(events)).toBe(events);
    expect(filterPhysicalEventsByDate(events, { start: "2026-07-01", end: "2026-07-10" }))
      .toEqual([known]);
  });
});
