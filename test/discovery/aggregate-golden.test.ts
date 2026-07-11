import { describe, expect, it } from "vitest";
import type { DiscoverySnapshot } from "../../src/discovery/adapter";
import {
  aggregateDiscoverySnapshots,
  selectDiscoveryEntries,
} from "../../src/discovery/aggregate";
import type {
  CatalogTitle,
  EvidenceConfidence,
  ReleaseEvent,
  ReleaseKind,
} from "../../src/discovery/types";

function title(
  id: string,
  tmdbId: number,
  name: string,
  popularity: number,
  originCountries: string[],
  originalLanguage: string,
): CatalogTitle {
  return {
    id,
    title: name,
    year: 2026,
    mediaType: "movie",
    tmdbId,
    originalLanguage,
    originCountries,
    genreIds: [18],
    popularity,
  };
}

function event(
  id: string,
  titleId: string,
  kind: ReleaseKind,
  date: string | undefined,
  confidence: EvidenceConfidence,
  providerId?: string,
): ReleaseEvent {
  return {
    id,
    titleId,
    kind,
    region: "IN",
    ...(date ? { date } : {}),
    datePrecision: date ? "day" : "unknown",
    ...(providerId ? { providerId, providerLabel: providerId } : {}),
    status: date ? "past" : "unknown",
    firstObservedAt: 1,
    lastObservedAt: 1,
    evidence: [{
      source: kind.startsWith("streaming_") ? "streaming-availability" : "tmdb",
      sourceId: id,
      observedAt: 1,
      confidence,
    }],
  };
}

function fixtureSnapshots(): DiscoverySnapshot[] {
  const sharedTmdb = title(
    "tmdb:movie:100",
    100,
    "Shared Hindi Film",
    50,
    ["US"],
    "hi",
  );
  const olderTmdb = title("tmdb:movie:101", 101, "Older Popular", 10_000, ["IN"], "hi");
  const newerTmdb = title("tmdb:movie:102", 102, "Newer Exact", 1, ["IN"], "ta");
  const undatedTmdb = title("tmdb:movie:103", 103, "Undated", 500, ["IN"], "hi");
  const availabilityOnly = title(
    "streaming:availability-only",
    104,
    "Currently Available Only",
    5,
    ["IN"],
    "en",
  );
  const indianDigital = title("tmdb:movie:105", 105, "Indian Digital", 2, ["IN"], "en");
  const streamingTitles = [sharedTmdb, olderTmdb, newerTmdb, undatedTmdb]
    .map((item) => ({ ...item, id: `streaming:${item.tmdbId}` }));
  return [
    {
      source: "tmdb",
      feedKind: "trending",
      titles: [sharedTmdb, olderTmdb, newerTmdb, undatedTmdb],
      events: [],
      fetchedAt: 1,
      warnings: [],
    },
    {
      source: "streaming-availability",
      feedKind: "streaming_added",
      titles: [...streamingTitles, availabilityOnly],
      events: [
        event("shared-netflix", "streaming:100", "streaming_added", "2026-07-10", "exact", "netflix"),
        event("shared-prime", "streaming:100", "streaming_added", "2026-07-10", "exact", "prime"),
        event("older", "streaming:101", "streaming_added", "2026-07-08", "exact", "netflix"),
        event("newer", "streaming:102", "streaming_added", "2026-07-09", "exact", "netflix"),
        event("undated", "streaming:103", "streaming_added", undefined, "source_claim", "netflix"),
      ],
      fetchedAt: 1,
      warnings: [],
    },
    {
      source: "tmdb",
      feedKind: "digital",
      titles: [indianDigital],
      events: [event("digital", indianDigital.id, "digital", "2026-07-07", "exact")],
      fetchedAt: 1,
      warnings: [],
    },
    {
      source: "bluray",
      feedKind: "bluray",
      titles: [{ ...sharedTmdb, id: "bluray:shared" }],
      events: [{
        ...event("bluray", "bluray:shared", "bluray", "2026-07-11", "source_claim"),
        region: "ZZ",
        formatLabel: "Blu-ray",
      }],
      fetchedAt: 1,
      warnings: [],
    },
  ];
}

describe("fixture-only discovery aggregation golden scenarios", () => {
  it("is deterministic and produces all four feeds without I/O", () => {
    const snapshots = fixtureSnapshots();
    const first = aggregateDiscoverySnapshots(snapshots);
    const second = aggregateDiscoverySnapshots(structuredClone(snapshots));

    expect(second).toEqual(first);
    expect(first.feeds.trending.length).toBeGreaterThan(0);
    expect(first.feeds.ott.length).toBeGreaterThan(0);
    expect(first.feeds.bluray.length).toBeGreaterThan(0);
    expect(first.feeds.india.length).toBeGreaterThan(0);
  });

  it("never admits or ranks an undated event in last week", () => {
    const aggregate = aggregateDiscoverySnapshots(fixtureSnapshots());
    const lastWeek = selectDiscoveryEntries(aggregate.feeds.ott, {
      date: {
        direction: "past",
        range: { start: "2026-07-04", end: "2026-07-10" },
      },
    }, { direction: "past" });

    expect(lastWeek.some((entry) => entry.event?.id === "undated")).toBe(false);
    expect(lastWeek.at(-1)?.event?.date).toBeDefined();
  });

  it("never lets an older popular title outrank a newer exact event", () => {
    const aggregate = aggregateDiscoverySnapshots(fixtureSnapshots());
    const ranked = selectDiscoveryEntries(aggregate.feeds.ott, {}, { direction: "past" });
    const ids = ranked.map((entry) => entry.event?.id);

    expect(ids.indexOf("newer")).toBeLessThan(ids.indexOf("older"));
  });

  it("does not turn an availability-only title into a recent-add event", () => {
    const aggregate = aggregateDiscoverySnapshots(fixtureSnapshots());
    const availableOnly = aggregate.titles.find((item) => item.tmdbId === 104)!;

    expect(availableOnly.title).toBe("Currently Available Only");
    expect(aggregate.feeds.ott.some((entry) => entry.title?.id === availableOnly.id)).toBe(false);
  });

  it("does not classify a non-Indian Hindi title as Indian", () => {
    const aggregate = aggregateDiscoverySnapshots(fixtureSnapshots(), {
      indianTitlesOnly: true,
    });

    expect(aggregate.feeds.india.some((entry) => entry.title?.tmdbId === 100)).toBe(false);
    expect(aggregate.feeds.india.some((entry) => entry.title?.tmdbId === 105)).toBe(true);
  });

  it("keeps Netflix and Prime events under one canonical movie", () => {
    const aggregate = aggregateDiscoverySnapshots(fixtureSnapshots());
    const shared = aggregate.feeds.ott.filter((entry) => entry.title?.tmdbId === 100);

    expect(shared).toHaveLength(2);
    expect(new Set(shared.map((entry) => entry.title?.id)).size).toBe(1);
    expect(new Set(shared.map((entry) => entry.event?.providerId))).toEqual(
      new Set(["netflix", "prime"]),
    );
  });
});
