import { createElement } from "react";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { aggregateDiscoverySnapshots } from "../../src/discovery/aggregate";
import type { DiscoverySnapshot } from "../../src/discovery/adapter";
import type { CatalogRating, CatalogTitle, ReleaseEvent } from "../../src/discovery/types";
import { DiscoveryContent } from "../../src/ui/components/Discover";
import { INITIAL_DISCOVERY_SCREEN_STATE } from "../../src/ui/discovery-state";
import type { DiscoveryUiModel } from "../../src/ui/hooks/useDiscovery";

const NOW = Date.parse("2026-07-11T00:00:00Z");

function title(id: number, mediaType: "movie" | "series", label: string): CatalogTitle {
  return { id: `tmdb:${mediaType}:${id}`, title: label, year: 2026, mediaType, tmdbId: id,
    originCountries: mediaType === "movie" ? ["IN"] : [], genreIds: [] };
}

function event(item: CatalogTitle, kind: ReleaseEvent["kind"], source: "streaming-availability" | "bluray"): ReleaseEvent {
  return { id: `${source}:${item.id}:${kind}`, titleId: item.id, kind,
    region: source === "bluray" ? "ZZ" : "IN", date: "2026-07-10", datePrecision: "day",
    providerLabel: source === "bluray" ? undefined : "Netflix",
    formatLabel: source === "bluray" ? "Blu-ray" : undefined,
    status: "past", firstObservedAt: NOW, lastObservedAt: NOW,
    evidence: [{ source, observedAt: NOW, confidence: "exact" }] };
}

describe("ratings acceptance matrix", () => {
  it("renders exact IMDb, labeled fallback, and NR across every Discover feed", () => {
    const catalog = [
      title(1, "movie", "Exact Movie"), title(2, "series", "Exact Series"),
      title(3, "movie", "Fallback Movie"), title(4, "series", "Fallback Series"),
      title(5, "movie", "NR Movie"), title(6, "series", "NR Series"),
    ];
    const discs = [catalog[0]!, catalog[2]!, catalog[4]!].map((item) => ({
      ...item, id: `bluray:${item.tmdbId}`, mediaType: "movie" as const,
    }));
    const snapshots: DiscoverySnapshot[] = [
      { source: "tmdb", feedKind: "trending", titles: catalog, events: [],
        fetchedAt: NOW, warnings: [] },
      { source: "streaming-availability", feedKind: "streaming_added", titles: catalog,
        events: catalog.map((item) => event(item, "streaming_added", "streaming-availability")),
        fetchedAt: NOW, warnings: [] },
      { source: "bluray", feedKind: "bluray", titles: discs,
        events: discs.map((item) => event(item, "bluray", "bluray")), fetchedAt: NOW, warnings: [] },
    ];
    const aggregation = aggregateDiscoverySnapshots(snapshots);
    const exact: CatalogRating = { system: "imdb", provider: "imdb-dataset", value: 8.4,
      scale: 10, voteCount: 146_281, observedAt: NOW };
    const fallback: CatalogRating = { system: "tmdb", provider: "tmdb", value: 7.9,
      scale: 10, voteCount: 12_000, observedAt: NOW };
    const ratings = new Map<string, CatalogRating[]>();
    for (const item of aggregation.titles) {
      if (item.tmdbId === 1 || item.tmdbId === 2) ratings.set(item.id, [exact]);
      if (item.tmdbId === 3 || item.tmdbId === 4) ratings.set(item.id, [fallback]);
    }
    const model: DiscoveryUiModel = { aggregation, sourceStates: [], loading: false,
      done: 0, total: 0, providers: [], attributions: [], ratings,
      ratingsLoading: false, ratingsExactCount: 2, ratingsFallbackCount: 2,
      ratingsUnresolvedCount: 2, refresh: vi.fn() };

    for (const feed of ["trending", "ott", "bluray"] as const) {
      const view = render(createElement(DiscoveryContent, {
        model,
        screen: { ...INITIAL_DISCOVERY_SCREEN_STATE, feed, dateWindow: "all" },
        dispatch: vi.fn(), active: false, cols: 120, listRows: 20,
      }));
      const frame = view.lastFrame() ?? "";
      expect(frame, feed).toContain("IMDb 8.4 · 146K");
      expect(frame, feed).toContain("TMDB 7.9 · 12K");
      expect(frame, feed).toContain("NR");
      if (feed !== "bluray") {
        expect(frame, feed).toContain("Exact Movie");
        expect(frame, feed).toContain("Exact Series");
        expect(frame, feed).toContain("Fallback Movie");
        expect(frame, feed).toContain("Fallback Series");
      }
      expect(frame.split("\n").every((line) => line.length <= 120)).toBe(true);
      view.unmount();
    }
  });
});
