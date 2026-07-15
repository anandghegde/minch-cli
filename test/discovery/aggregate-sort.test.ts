import { describe, expect, it } from "vitest";
import {
  sortDiscoveryEntries,
  type DiscoveryFeedEntry,
} from "../../src/discovery/aggregate";
import type { CatalogRating, CatalogTitle, ReleaseEvent } from "../../src/discovery/types";

function title(id: string, overrides: Partial<CatalogTitle> = {}): CatalogTitle {
  return {
    id,
    title: id,
    mediaType: "movie",
    originCountries: [],
    genreIds: [],
    ...overrides,
  };
}

function event(id: string, titleId: string, overrides: Partial<ReleaseEvent> = {}): ReleaseEvent {
  return {
    id,
    titleId,
    kind: "streaming_added",
    region: "IN",
    datePrecision: "day",
    status: "past",
    firstObservedAt: 1,
    lastObservedAt: 1,
    evidence: [{ source: "tamilmv", observedAt: 1, confidence: "source_claim" }],
    ...overrides,
  };
}

function imdb(value: number, votes?: number): CatalogRating {
  return {
    system: "imdb",
    provider: "imdb-dataset",
    value,
    scale: 10,
    ...(votes !== undefined ? { voteCount: votes } : {}),
    observedAt: 1,
  };
}

describe("sortDiscoveryEntries", () => {
  it("sorts by date_added using max observed timestamps desc, missing last", () => {
    const a: DiscoveryFeedEntry = {
      title: title("a"),
      event: event("ea", "a", { firstObservedAt: 10, lastObservedAt: 100 }),
    };
    const b: DiscoveryFeedEntry = {
      title: title("b"),
      event: event("eb", "b", { firstObservedAt: 50, lastObservedAt: 50 }),
    };
    const c: DiscoveryFeedEntry = { title: title("c") }; // no event
    const ordered = sortDiscoveryEntries([c, b, a], "date_added", { direction: "past" });
    expect(ordered.map((e) => e.title?.id)).toEqual(["a", "b", "c"]);
  });

  it("sorts by release_date desc and puts undated last", () => {
    const older: DiscoveryFeedEntry = {
      title: title("older"),
      event: event("e1", "older", { date: "2020-01-01" }),
    };
    const newer: DiscoveryFeedEntry = {
      title: title("newer"),
      event: event("e2", "newer", { date: "2024-06-01" }),
    };
    const undated: DiscoveryFeedEntry = {
      title: title("undated"),
      event: event("e3", "undated", { date: undefined, datePrecision: "unknown", status: "unknown" }),
    };
    const ordered = sortDiscoveryEntries(
      [older, undated, newer],
      "release_date",
      { direction: "past" },
    );
    expect(ordered.map((e) => e.title?.id)).toEqual(["newer", "older", "undated"]);
  });

  it("sorts by imdb_rating and imdb_votes with missing last", () => {
    const high: DiscoveryFeedEntry = {
      title: title("high", { ratings: [imdb(8.5, 1000)] }),
    };
    const mid: DiscoveryFeedEntry = {
      title: title("mid", { ratings: [imdb(7.0, 50_000)] }),
    };
    const none: DiscoveryFeedEntry = { title: title("none") };
    expect(sortDiscoveryEntries([none, mid, high], "imdb_rating", { direction: "past" })
      .map((e) => e.title?.id)).toEqual(["high", "mid", "none"]);
    expect(sortDiscoveryEntries([none, mid, high], "imdb_votes", { direction: "past" })
      .map((e) => e.title?.id)).toEqual(["mid", "high", "none"]);
  });

  it("sorts by title A-Z and delegates default to rankDiscoveryEntries", () => {
    const z: DiscoveryFeedEntry = {
      title: title("z", { title: "Zebra" }),
      event: event("ez", "z", { date: "2020-01-01" }),
    };
    const a: DiscoveryFeedEntry = {
      title: title("a", { title: "Alpha" }),
      event: event("ea", "a", { date: "2010-01-01" }),
    };
    expect(sortDiscoveryEntries([z, a], "title", { direction: "past" })
      .map((e) => e.title?.title)).toEqual(["Alpha", "Zebra"]);
    // default: newer date first
    expect(sortDiscoveryEntries([z, a], "default", { direction: "past" })
      .map((e) => e.title?.id)).toEqual(["z", "a"]);
  });
});
