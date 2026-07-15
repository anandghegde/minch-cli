import { describe, expect, it } from "vitest";
import {
  INITIAL_DISCOVERY_SCREEN_STATE,
  discoveryScreenReducer,
  type DiscoveryScreenAction,
  type DiscoveryScreenState,
} from "../src/ui/discovery-state";

function reduce(
  actions: DiscoveryScreenAction[],
  initial: DiscoveryScreenState = INITIAL_DISCOVERY_SCREEN_STATE,
): DiscoveryScreenState {
  return actions.reduce(discoveryScreenReducer, initial);
}

describe("screen-local discovery state", () => {
  it("starts with every planned dimension represented", () => {
    expect(INITIAL_DISCOVERY_SCREEN_STATE).toEqual({
      feed: "trending",
      media: "all",
      dateWindow: "30d",
      sort: "default",
      yearFilter: "all",
      cursor: 0,
      detailsOpen: false,
    });
  });

  it("cycles sort, year, min IMDb rating/votes and resets them with filters", () => {
    const withFilters = reduce([
      { type: "set-feed", feed: "tamilmv" },
      { type: "set-sort", sort: "imdb_rating" },
      { type: "set-year-filter", yearFilter: "2020s" },
      { type: "set-min-imdb-rating", minImdbRating: 7 },
      { type: "set-min-imdb-votes", minImdbVotes: 1000 },
      { type: "set-language", languageCode: "ta" },
    ]);
    expect(withFilters).toMatchObject({
      feed: "tamilmv",
      sort: "imdb_rating",
      yearFilter: "2020s",
      minImdbRating: 7,
      minImdbVotes: 1000,
      languageCode: "ta",
      dateWindow: "all", // tamilmv feed still forces all
    });

    const reset = discoveryScreenReducer(withFilters, { type: "reset-filters" });
    expect(reset).toEqual({
      ...INITIAL_DISCOVERY_SCREEN_STATE,
      feed: "tamilmv",
    });
    expect(reset.minImdbRating).toBeUndefined();
    expect(reset.minImdbVotes).toBeUndefined();
  });

  it("stores feed, media, window, provider, language, and format filters", () => {
    expect(reduce([
      { type: "set-feed", feed: "charts" },
      { type: "set-media", media: "series" },
      { type: "set-date-window", dateWindow: "upcoming-7d" },
      { type: "set-provider", providerId: "netflix" },
      { type: "set-language", languageCode: "hi" },
      { type: "set-format", formatLabel: "Blu-ray" },
    ])).toMatchObject({
      feed: "charts",
      media: "series",
      dateWindow: "upcoming-7d",
      providerId: "netflix",
      languageCode: "hi",
      formatLabel: "Blu-ray",
    });
  });

  it("clamps navigation and closes stale details after result-changing actions", () => {
    const moved = reduce([
      { type: "set-cursor", cursor: 8, rowCount: 10 },
      { type: "open-details" },
      { type: "move-cursor", delta: 10, rowCount: 10 },
    ]);
    expect(moved).toMatchObject({ cursor: 9, detailsOpen: true });

    expect(discoveryScreenReducer(moved, { type: "set-provider", providerId: "prime" }))
      .toMatchObject({ cursor: 0, detailsOpen: false, providerId: "prime" });
    expect(discoveryScreenReducer(moved, { type: "clamp-cursor", rowCount: 3 }).cursor)
      .toBe(2);
    expect(discoveryScreenReducer(moved, { type: "clamp-cursor", rowCount: 0 }).cursor)
      .toBe(0);
  });

  it("resets filters without changing the selected feed", () => {
    const state = reduce([
      { type: "set-feed", feed: "bluray" },
      { type: "set-media", media: "movie" },
      { type: "set-format", formatLabel: "4K UHD" },
      { type: "reset-filters" },
    ]);

    expect(state).toEqual({ ...INITIAL_DISCOVERY_SCREEN_STATE, feed: "bluray" });
  });
});
