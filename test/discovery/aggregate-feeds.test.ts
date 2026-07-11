import { describe, expect, it } from "vitest";
import type { DiscoverySnapshot } from "../../src/discovery/adapter";
import {
  canonicalizeSnapshotEvents,
  canonicalizeSnapshotTitles,
  classifyDiscoveryFeeds,
} from "../../src/discovery/aggregate";
import type {
  CatalogTitle,
  DiscoverySource,
  ReleaseEvent,
  ReleaseKind,
} from "../../src/discovery/types";
import type { DiscoveryFeedKind } from "../../src/discovery/request";

function title(
  id: string,
  tmdbId: number,
  originCountries: string[] = [],
): CatalogTitle {
  return {
    id,
    title: `Title ${tmdbId}`,
    year: 2026,
    mediaType: "movie",
    tmdbId,
    originCountries,
    genreIds: [],
    popularity: tmdbId,
  };
}

function event(
  id: string,
  titleId: string,
  kind: ReleaseKind,
  region = "IN",
): ReleaseEvent {
  return {
    id,
    titleId,
    kind,
    region,
    date: "2026-07-10",
    datePrecision: "day",
    status: "today",
    firstObservedAt: 1,
    lastObservedAt: 1,
    evidence: [{ source: "tmdb", observedAt: 1, confidence: "exact" }],
  };
}

function snapshot(
  source: DiscoverySource,
  feedKind: DiscoveryFeedKind,
  titles: CatalogTitle[],
  events: ReleaseEvent[] = [],
): DiscoverySnapshot {
  return { source, feedKind, titles, events, fetchedAt: 1, warnings: [] };
}

function aggregate(snapshots: DiscoverySnapshot[]) {
  const identities = canonicalizeSnapshotTitles(snapshots);
  const canonicalEvents = canonicalizeSnapshotEvents(
    snapshots,
    identities.canonicalIdBySourceTitleId,
  );
  return { identities, events: canonicalEvents.events };
}

describe("canonical discovery feed classification", () => {
  it("uses TMDB trending request provenance without creating release events", () => {
    const trending = title("tmdb:trending", 1);
    const digital = title("tmdb:digital", 2);
    const snapshots = [
      snapshot("tmdb", "trending", [trending]),
      snapshot("tmdb", "digital", [digital], [event("digital", digital.id, "digital")]),
    ];
    const canonical = aggregate(snapshots);

    const feeds = classifyDiscoveryFeeds(snapshots, canonical.identities, canonical.events);

    expect(feeds.trending.map((entry) => entry.title?.tmdbId)).toEqual([1]);
    expect(feeds.trending[0]!.event).toBeUndefined();
    expect(feeds.trending.some((entry) => entry.title?.tmdbId === 2)).toBe(false);
  });

  it("classifies only streaming events as OTT and can exclude upcoming", () => {
    const shared = title("streaming:title", 3);
    const snapshots = [snapshot("streaming-availability", "streaming_added", [shared], [
      event("added", shared.id, "streaming_added"),
      event("upcoming", shared.id, "streaming_upcoming"),
      event("digital", shared.id, "digital"),
    ])];
    const canonical = aggregate(snapshots);

    expect(classifyDiscoveryFeeds(snapshots, canonical.identities, canonical.events)
      .ott.map((entry) => entry.event?.kind)).toEqual([
      "streaming_added",
      "streaming_upcoming",
    ]);
    expect(classifyDiscoveryFeeds(snapshots, canonical.identities, canonical.events, {
      includeStreamingUpcoming: false,
    }).ott.map((entry) => entry.event?.kind)).toEqual(["streaming_added"]);
  });

  it("keeps generic physical fallback opt-in for the Blu-ray feed", () => {
    const shared = title("bluray:title", 4);
    const snapshots = [snapshot("bluray", "bluray", [shared], [
      event("disc", shared.id, "bluray", "ZZ"),
      event("uhd", shared.id, "uhd_bluray", "ZZ"),
      event("generic", shared.id, "physical", "IN"),
    ])];
    const canonical = aggregate(snapshots);

    expect(classifyDiscoveryFeeds(snapshots, canonical.identities, canonical.events)
      .bluray.map((entry) => entry.event?.kind)).toEqual(["bluray", "uhd_bluray"]);
    expect(classifyDiscoveryFeeds(snapshots, canonical.identities, canonical.events, {
      includeGenericPhysical: true,
    }).bluray.map((entry) => entry.event?.kind)).toEqual([
      "bluray",
      "physical",
      "uhd_bluray",
    ]);
  });

  it("defines India by event region and Indian titles by origin country", () => {
    const indian = title("tmdb:indian", 5, ["IN"]);
    const global = title("tmdb:global", 6, ["US"]);
    const snapshots = [snapshot("tmdb", "digital", [indian, global], [
      event("indian-in", indian.id, "digital", "IN"),
      event("global-in", global.id, "digital", "IN"),
      event("indian-global", indian.id, "physical", "ZZ"),
    ])];
    const canonical = aggregate(snapshots);

    expect(classifyDiscoveryFeeds(snapshots, canonical.identities, canonical.events)
      .india.map((entry) => entry.event?.id)).toEqual(["global-in", "indian-in"]);
    expect(classifyDiscoveryFeeds(snapshots, canonical.identities, canonical.events, {
      indianTitlesOnly: true,
    }).india.map((entry) => entry.event?.id)).toEqual(["indian-in"]);
  });
});
