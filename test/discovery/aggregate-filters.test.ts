import { describe, expect, it } from "vitest";
import {
  filterDiscoveryEntries,
  matchesYearFilter,
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

function titleWithoutYear(id: string): CatalogTitle {
  const base = title(id);
  const { year: _y, ...rest } = base;
  return rest;
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

describe("matchesYearFilter", () => {
  it("treats undefined and all as no constraint", () => {
    expect(matchesYearFilter(undefined, undefined)).toBe(true);
    expect(matchesYearFilter(undefined, "all")).toBe(true);
    expect(matchesYearFilter(1999, undefined)).toBe(true);
    expect(matchesYearFilter(1999, "all")).toBe(true);
  });

  it("matches decade tokens inclusively", () => {
    expect(matchesYearFilter(2020, "2020s")).toBe(true);
    expect(matchesYearFilter(2029, "2020s")).toBe(true);
    expect(matchesYearFilter(2019, "2020s")).toBe(false);
    expect(matchesYearFilter(2030, "2020s")).toBe(false);
  });

  it("matches exact years", () => {
    expect(matchesYearFilter(2026, "2026")).toBe(true);
    expect(matchesYearFilter(2025, "2026")).toBe(false);
  });

  it("matches pre-1980 as year strictly less than 1980", () => {
    expect(matchesYearFilter(1979, "pre-1980")).toBe(true);
    expect(matchesYearFilter(1980, "pre-1980")).toBe(false);
  });

  it("excludes missing or non-finite years when a filter is active", () => {
    expect(matchesYearFilter(undefined, "2020s")).toBe(false);
    expect(matchesYearFilter(Number.NaN, "2026")).toBe(false);
  });
});

describe("filterDiscoveryEntries year filter", () => {
  it("excludes missing years when yearFilter is active", () => {
    const yearEntries: DiscoveryFeedEntry[] = [
      { title: title("y2026", { year: 2026 }) },
      { title: title("y2021", { year: 2021 }) },
      { title: title("y1975", { year: 1975 }) },
      { title: titleWithoutYear("no-year") },
    ];

    expect(
      filterDiscoveryEntries(yearEntries, { yearFilter: "2020s" })
        .map((entry) => entry.title?.id),
    ).toEqual(["y2026", "y2021"]);

    expect(
      filterDiscoveryEntries(yearEntries, { yearFilter: "2026" })
        .map((entry) => entry.title?.id),
    ).toEqual(["y2026"]);

    expect(
      filterDiscoveryEntries(yearEntries, { yearFilter: "pre-1980" })
        .map((entry) => entry.title?.id),
    ).toEqual(["y1975"]);

    expect(
      filterDiscoveryEntries(yearEntries, { yearFilter: "all" })
        .map((entry) => entry.title?.id),
    ).toEqual(["y2026", "y2021", "y1975", "no-year"]);

    expect(
      filterDiscoveryEntries(yearEntries, {})
        .map((entry) => entry.title?.id),
    ).toEqual(["y2026", "y2021", "y1975", "no-year"]);
  });
});
