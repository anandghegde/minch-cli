import { describe, expect, it } from "vitest";
import {
  filterDiscoveryEntries,
  type DiscoveryFeedEntry,
} from "../../src/discovery/aggregate";
import type { CatalogTitle, ReleaseEvent } from "../../src/discovery/types";

function title(
  id: string,
  overrides: Partial<CatalogTitle> = {},
): CatalogTitle {
  return {
    id,
    title: id,
    year: 2026,
    mediaType: "movie",
    originalLanguage: "hi",
    originCountries: ["IN"],
    genreIds: [18],
    ...overrides,
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
    formatLabel: "Subscription",
    status: "today",
    firstObservedAt: 1,
    lastObservedAt: 1,
    evidence: [{
      source: "streaming-availability",
      observedAt: 1,
      confidence: "exact",
    }],
    ...overrides,
  };
}

const movie = title("movie");
const series = title("series", {
  mediaType: "series",
  originalLanguage: "en",
  originCountries: ["US"],
  genreIds: [35],
});
const entries: DiscoveryFeedEntry[] = [
  { title: movie, event: event("movie-event", movie.id, { audioLanguages: ["ta"] }) },
  {
    title: series,
    event: event("series-event", series.id, {
      providerId: "prime",
      providerLabel: "Prime Video",
      formatLabel: "Rent",
      date: "2026-07-01",
    }),
  },
  { title: title("undated"), event: event("undated-event", "undated", {
    date: undefined,
    datePrecision: "unknown",
    status: "unknown",
  }) },
];

describe("canonical discovery feed filters", () => {
  it("filters media and canonical genre independently", () => {
    expect(filterDiscoveryEntries(entries, { mediaTypes: ["series"] })
      .map((entry) => entry.title?.id)).toEqual(["series"]);
    expect(filterDiscoveryEntries(entries, { genreIds: [18] })
      .map((entry) => entry.title?.id)).toEqual(["movie", "undated"]);
  });

  it("requires provider and release-format evidence when selected", () => {
    expect(filterDiscoveryEntries(entries, { providerIds: ["prime"] })
      .map((entry) => entry.event?.id)).toEqual(["series-event"]);
    expect(filterDiscoveryEntries(entries, { formatLabels: ["rent"] })
      .map((entry) => entry.event?.id)).toEqual(["series-event"]);
  });

  it("matches original or explicitly supplied audio language", () => {
    expect(filterDiscoveryEntries(entries, { languageCodes: ["Hindi"] })
      .map((entry) => entry.title?.id)).toEqual(["movie", "undated"]);
    expect(filterDiscoveryEntries(entries, { languageCodes: ["ta-IN"] })
      .map((entry) => entry.title?.id)).toEqual(["movie"]);
    expect(filterDiscoveryEntries([
      { title: title("french", { originalLanguage: "fr" }) },
      { title: title("hindi") },
    ], { languageCodes: ["other"] }).map((entry) => entry.title?.id)).toEqual(["french"]);
  });

  it("applies day-precise ranges and excludes unknown dates", () => {
    expect(filterDiscoveryEntries(entries, {
      date: {
        direction: "past",
        range: { start: "2026-07-05", end: "2026-07-10" },
      },
    }).map((entry) => entry.event?.id)).toEqual(["movie-event"]);
  });

  it("defines Indian titles by origin country rather than language", () => {
    expect(filterDiscoveryEntries(entries, { indianTitlesOnly: true })
      .map((entry) => entry.title?.id)).toEqual(["movie", "undated"]);
  });
});
