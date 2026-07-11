import { describe, expect, it } from "vitest";
import {
  rankDiscoveryEntries,
  selectDiscoveryEntries,
  type DiscoveryFeedEntry,
} from "../../src/discovery/aggregate";
import type {
  CatalogTitle,
  EvidenceConfidence,
  ReleaseEvent,
} from "../../src/discovery/types";

function entry(
  id: string,
  date: string | undefined,
  confidence: EvidenceConfidence,
  popularity: number,
  title = id,
): DiscoveryFeedEntry {
  const catalogTitle: CatalogTitle = {
    id: `title:${id}`,
    title,
    mediaType: "movie",
    originCountries: [],
    genreIds: [],
    popularity,
  };
  const event: ReleaseEvent = {
    id: `event:${id}`,
    titleId: catalogTitle.id,
    kind: "streaming_added",
    region: "IN",
    ...(date ? { date } : {}),
    datePrecision: date ? "day" : "unknown",
    status: date ? "past" : "unknown",
    firstObservedAt: 1,
    lastObservedAt: 1,
    evidence: [{ source: "streaming-availability", observedAt: 1, confidence }],
  };
  return { title: catalogTitle, event };
}

describe("canonical discovery ranking", () => {
  it("never lets popularity or confidence outrank a newer past event", () => {
    const selected = rankDiscoveryEntries([
      entry("older-popular", "2026-07-08", "exact", 10_000),
      entry("newer", "2026-07-09", "inferred", 1),
    ], { direction: "past" });

    expect(selected.map((item) => item.event?.id)).toEqual([
      "event:newer",
      "event:older-popular",
    ]);
  });

  it("uses evidence confidence before popularity on the same date", () => {
    const selected = rankDiscoveryEntries([
      entry("inferred", "2026-07-09", "inferred", 100),
      entry("claim", "2026-07-09", "source_claim", 50),
      entry("exact", "2026-07-09", "exact", 1),
    ], { direction: "past" });

    expect(selected.map((item) => item.event?.id)).toEqual([
      "event:exact",
      "event:claim",
      "event:inferred",
    ]);
  });

  it("sorts upcoming soonest first and unknown dates last", () => {
    const selected = rankDiscoveryEntries([
      entry("unknown", undefined, "exact", 100),
      entry("later", "2026-07-20", "exact", 10),
      entry("soon", "2026-07-12", "exact", 1),
    ], { direction: "upcoming" });

    expect(selected.map((item) => item.event?.id)).toEqual([
      "event:soon",
      "event:later",
      "event:unknown",
    ]);
  });

  it("uses popularity late, then stable title and ID ties", () => {
    const selected = rankDiscoveryEntries([
      entry("z", undefined, "inferred", 5, "Same"),
      entry("a", undefined, "inferred", 5, "Same"),
      entry("popular", undefined, "inferred", 6, "Zed"),
      entry("alpha", undefined, "inferred", 5, "Alpha"),
    ], { direction: "past" });

    expect(selected.map((item) => item.event?.id)).toEqual([
      "event:popular",
      "event:alpha",
      "event:a",
      "event:z",
    ]);
  });

  it("applies hard filters before the ranking cascade", () => {
    const newer = entry("newer", "2026-07-09", "exact", 1);
    newer.event!.providerId = "netflix";
    const older = entry("older", "2026-07-08", "exact", 100);
    older.event!.providerId = "prime";

    expect(selectDiscoveryEntries([older, newer], { providerIds: ["prime"] }, {
      direction: "past",
    }).map((item) => item.event?.id)).toEqual(["event:older"]);
  });
});
