import { describe, expect, it } from "vitest";
import type { DiscoverySnapshot } from "../../src/discovery/adapter";
import {
  canonicalizeSnapshotEvents,
  canonicalizeSnapshotTitles,
} from "../../src/discovery/aggregate";
import type {
  CatalogTitle,
  DiscoverySource,
  ReleaseEvent,
} from "../../src/discovery/types";

const OBSERVED = 1_783_665_832_000;

function title(id: string, tmdbId: number): CatalogTitle {
  return {
    id,
    title: "Shared Film",
    year: 2026,
    mediaType: "movie",
    tmdbId,
    originCountries: [],
    genreIds: [],
  };
}

function event(
  id: string,
  titleId: string,
  overrides: Partial<ReleaseEvent> = {},
): ReleaseEvent {
  return {
    id,
    titleId,
    kind: "streaming_added",
    region: "IN",
    date: "2026-07-10",
    datePrecision: "day",
    providerId: "netflix",
    providerLabel: "Netflix",
    status: "today",
    firstObservedAt: OBSERVED,
    lastObservedAt: OBSERVED,
    evidence: [{
      source: id.startsWith("tmdb") ? "tmdb" : "streaming-availability",
      sourceId: id,
      observedAt: OBSERVED,
      confidence: "exact",
    }],
    ...overrides,
  };
}

function snapshot(
  source: DiscoverySource,
  titles: CatalogTitle[],
  events: ReleaseEvent[],
): DiscoverySnapshot {
  return { source, titles, events, fetchedAt: OBSERVED, warnings: [] };
}

describe("canonical discovery event deduplication", () => {
  it("combines evidence and observation bounds for identical canonical events", () => {
    const snapshots = [
      snapshot("tmdb", [title("tmdb:movie:7", 7)], [
        event("tmdb:event", "tmdb:movie:7", {
          firstObservedAt: OBSERVED - 1_000,
          audioLanguages: ["hi"],
        }),
      ]),
      snapshot("streaming-availability", [title("streaming:7", 7)], [
        event("streaming:event", "streaming:7", {
          lastObservedAt: OBSERVED + 1_000,
          audioLanguages: ["en"],
          subtitleLanguages: ["ta"],
        }),
      ]),
    ];
    const identities = canonicalizeSnapshotTitles(snapshots);
    const result = canonicalizeSnapshotEvents(
      snapshots,
      identities.canonicalIdBySourceTitleId,
    );

    expect(result.duplicateEvents).toBe(1);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      titleId: "canonical:movie:tmdb:7",
      firstObservedAt: OBSERVED - 1_000,
      lastObservedAt: OBSERVED + 1_000,
      audioLanguages: ["en", "hi"],
      subtitleLanguages: ["ta"],
    });
    expect(result.events[0]!.evidence).toHaveLength(2);
  });

  it("preserves provider, region, kind, format, access, and conflicting-date distinctions", () => {
    const sharedTitle = title("streaming:7", 7);
    const events = [
      event("base", sharedTitle.id),
      event("prime", sharedTitle.id, { providerId: "prime", providerLabel: "Prime Video" }),
      event("global", sharedTitle.id, { region: "ZZ" }),
      event("physical", sharedTitle.id, {
        kind: "physical",
        providerId: undefined,
        providerLabel: undefined,
        formatLabel: "DVD",
      }),
      event("bluray", sharedTitle.id, {
        kind: "physical",
        providerId: undefined,
        providerLabel: undefined,
        formatLabel: "Blu-ray",
      }),
      event("rent", sharedTitle.id, { accessType: "rent" }),
      event("other-date", sharedTitle.id, { date: "2026-07-09", status: "past" }),
    ];
    const snapshots = [snapshot("streaming-availability", [sharedTitle], events)];
    const identities = canonicalizeSnapshotTitles(snapshots);

    const result = canonicalizeSnapshotEvents(
      snapshots,
      identities.canonicalIdBySourceTitleId,
    );

    expect(result.duplicateEvents).toBe(0);
    expect(result.events).toHaveLength(events.length);
    expect(new Set(result.events.map((item) => item.providerId))).toEqual(
      new Set(["netflix", "prime", undefined]),
    );
    expect(new Set(result.events.map((item) => item.date))).toEqual(
      new Set(["2026-07-10", "2026-07-09"]),
    );
  });
});
