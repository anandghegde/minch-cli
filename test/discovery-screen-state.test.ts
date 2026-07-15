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
      cursor: 0,
      detailsOpen: false,
    });
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
