import { createElement, useReducer } from "react";
import { Box } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig, type Config } from "../src/config/config";
import type { DiscoverySnapshot } from "../src/discovery/adapter";
import { aggregateDiscoverySnapshots } from "../src/discovery/aggregate";
import type { BudgetStatus, RequestLedger } from "../src/discovery/budget";
import type { DiscoveryCacheDocument } from "../src/discovery/cache";
import type { CatalogTitle, ReleaseEvent } from "../src/discovery/types";
import {
  DISCOVERY_SOURCE_CLAIM_NOTICE,
  JUSTWATCH_ATTRIBUTION_NOTICE,
  TMDB_REQUIRED_NOTICE,
  IMDB_REQUIRED_NOTICE,
} from "../src/discovery/attribution";
import {
  DiscoveryContent,
  dedupeBlurayEntries,
  discoveryLanguageSummary,
  discoverySearchQuery,
  formatDiscoveryRating,
  formatVoteCount,
} from "../src/ui/components/Discover";
import {
  INITIAL_DISCOVERY_SCREEN_STATE,
  DISCOVERY_LANGUAGE_FILTERS,
  discoveryScreenReducer,
  type DiscoveryScreenState,
} from "../src/ui/discovery-state";
import {
  buildDiscoveryLoadTargets,
  cachedSnapshotsForDiscoveryFeed,
  discoveryDateSelection,
  mergeDiscoveryProviders,
  type DiscoveryUiModel,
} from "../src/ui/hooks/useDiscovery";

const NOW = Date.now();
const RIGHT = "\x1b[C";
const ESCAPE = "\x1b";

function Harness({
  uiModel,
  initial = INITIAL_DISCOVERY_SCREEN_STATE,
  cols = 100,
  onSearch,
}: {
  uiModel: DiscoveryUiModel;
  initial?: DiscoveryScreenState;
  cols?: number;
  onSearch?: (query: string) => void;
}) {
  const [screen, dispatch] = useReducer(discoveryScreenReducer, initial);
  return createElement(DiscoveryContent, {
    model: uiModel,
    screen,
    dispatch,
    onSearch,
    active: true,
    cols,
    listRows: 12,
  });
}

function fixtureSnapshot(): DiscoverySnapshot {
  const title: CatalogTitle = {
    id: "streaming:title",
    title: "Example Film",
    year: 2026,
    mediaType: "movie",
    originalLanguage: "hi",
    originCountries: ["IN"],
    genreIds: [18],
  };
  const event: ReleaseEvent = {
    id: "streaming:event",
    titleId: title.id,
    kind: "streaming_added",
    region: "IN",
    date: "2026-07-10",
    datePrecision: "day",
    providerId: "netflix",
    providerLabel: "Netflix",
    status: "today",
    firstObservedAt: NOW,
    lastObservedAt: NOW,
    evidence: [{
      source: "streaming-availability",
      sourceId: "event",
      observedAt: NOW,
      confidence: "exact",
    }],
  };
  return {
    source: "streaming-availability",
    feedKind: "streaming_added",
    titles: [title],
    events: [event],
    fetchedAt: NOW,
    warnings: [],
  };
}

function model(overrides: Partial<DiscoveryUiModel> = {}): DiscoveryUiModel {
  const snapshot = fixtureSnapshot();
  return {
    aggregation: aggregateDiscoverySnapshots([snapshot]),
    sourceStates: [
      {
        key: "streaming:recent",
        label: "Streaming Availability Recent",
        state: {
          source: "streaming-availability",
          label: "Streaming Availability",
          status: "stale",
          snapshot,
          warnings: [],
        },
      },
      {
        key: "streaming:quota",
        label: "Streaming Availability Upcoming",
        state: {
          source: "streaming-availability",
          label: "Streaming Availability",
          status: "quota-paused",
          warnings: [],
        },
      },
    ],
    loading: false,
    done: 2,
    total: 2,
    providers: [],
    attributions: [],
    ratings: new Map(),
    ratingsLoading: false,
    ratingsExactCount: 0,
    ratingsFallbackCount: 0,
    ratingsUnresolvedCount: 1,
    refresh: vi.fn(),
    ...overrides,
  };
}

describe("Discover canonical rows and source status", () => {
  it("deduplicates Blu-ray rows by title while preserving ranked order", () => {
    const title = (id: string, name: string, year: number): CatalogTitle => ({
      id,
      title: name,
      year,
      mediaType: "movie",
      originCountries: [],
      genreIds: [],
    });
    const event = (id: string, titleId: string): ReleaseEvent => ({
      id,
      titleId,
      kind: "bluray",
      region: "US",
      date: "2026-07-10",
      datePrecision: "day",
      status: "today",
      firstObservedAt: NOW,
      lastObservedAt: NOW,
      evidence: [],
    });
    const entries = dedupeBlurayEntries([
      { title: title("first", "The Film!", 2026), event: event("first-event", "first") },
      { title: title("second", "the film", 2026), event: event("second-event", "second") },
      { title: title("next-year", "The Film", 2027), event: event("next-event", "next-year") },
    ]);

    expect(entries.map((entry) => entry.event?.id)).toEqual(["first-event", "next-event"]);
  });

  it("formats exact, fallback, and compact vote counts without relabeling", () => {
    expect(formatVoteCount(146_281)).toBe("146K");
    expect(formatVoteCount(1_420_000)).toBe("1.4M");
    expect(formatDiscoveryRating({
      system: "imdb", provider: "imdb-dataset", value: 8.4,
      scale: 10, voteCount: 146_281, observedAt: NOW,
    })).toBe("IMDb 8.4 · 146K");
    expect(formatDiscoveryRating({
      system: "tmdb", provider: "tmdb", value: 7.9,
      scale: 10, voteCount: 12_000, observedAt: NOW,
    })).toBe("TMDB 7.9 · 12K");
  });

  it("renders responsive rating columns and exact details", () => {
    const base = model({ sourceStates: [] });
    const titleId = base.aggregation.titles[0]!.id;
    const rating = {
      system: "imdb" as const, provider: "imdb-dataset" as const,
      value: 8.4, scale: 10 as const, voteCount: 146_281, observedAt: NOW,
    };
    base.ratings = new Map([[titleId, [rating]]]);
    const screen = { ...INITIAL_DISCOVERY_SCREEN_STATE, feed: "ott" as const, dateWindow: "all" as const };
    for (const [cols, expected] of [[120, "IMDb 8.4 · 146K"], [90, "IMDb 8.4 146K"], [75, "8.4/146K"], [60, "8.4/146K"]] as const) {
      const view = render(createElement(DiscoveryContent, {
        model: base, screen, dispatch: vi.fn(), active: false, cols, listRows: 10,
      }));
      expect(view.lastFrame()).toContain(expected);
      expect((view.lastFrame() ?? "").split("\n").every((line) => line.length <= cols)).toBe(true);
      view.unmount();
    }
    const details = render(createElement(DiscoveryContent, {
      model: base,
      screen: { ...screen, detailsOpen: true },
      dispatch: vi.fn(), active: false, cols: 120, listRows: 16,
    }));
    expect(details.lastFrame()).toContain("IMDb: 8.4/10 · 146,281 votes");
    expect(details.lastFrame()).toContain("Rating provider: Official IMDb dataset");
    expect(details.lastFrame()).toContain(IMDB_REQUIRED_NOTICE);
    details.unmount();
  });

  it("shows IMDb rating, votes, and media type instead of Apify on India Charts", () => {
    const titles: CatalogTitle[] = [
      {
        id: "apify:flixpatrol:netflix:series:chart-show",
        title: "Chart Show",
        mediaType: "series",
        originCountries: [],
        genreIds: [],
        providerIds: ["netflix"],
        providerLabels: ["Netflix"],
      },
      {
        id: "apify:flixpatrol:netflix:movie:chart-film",
        title: "Chart Film",
        mediaType: "movie",
        originCountries: [],
        genreIds: [],
        providerIds: ["netflix"],
        providerLabels: ["Netflix"],
      },
    ];
    const snapshot: DiscoverySnapshot = {
      source: "apify",
      feedKind: "streaming_charts",
      titles,
      events: [],
      fetchedAt: NOW,
      warnings: [],
    };
    const aggregation = aggregateDiscoverySnapshots([snapshot]);
    const rating = {
      system: "imdb" as const,
      provider: "imdb-dataset" as const,
      value: 8.4,
      scale: 10 as const,
      voteCount: 146_281,
      observedAt: NOW,
    };
    const ratings = new Map(aggregation.titles.map((title) => [title.id, [rating]]));
    const view = render(createElement(DiscoveryContent, {
      model: model({ aggregation, sourceStates: [], ratings }),
      screen: { ...INITIAL_DISCOVERY_SCREEN_STATE, feed: "charts" },
      dispatch: vi.fn(),
      active: false,
      cols: 120,
      listRows: 12,
    }));
    const frame = view.lastFrame() ?? "";

    expect(frame).toContain("IMDb");
    expect(frame).toContain("Votes");
    expect(frame).toContain("Type");
    expect(frame).toContain("8.4");
    expect(frame).toContain("146K");
    expect(frame).toContain("Movie");
    expect(frame).toContain("TV");
    expect(frame).not.toContain("Apify");
    expect(frame.split("\n").every((line) => line.length <= 120)).toBe(true);
    view.unmount();
  });

  it("uses the fallback while exact loading and ellipsis only without a fallback", () => {
    const fallback = model({ sourceStates: [], ratingsLoading: true });
    const titleId = fallback.aggregation.titles[0]!.id;
    fallback.ratings = new Map([[titleId, [{
      system: "tmdb", provider: "tmdb", value: 7.9, scale: 10,
      voteCount: 12_000, observedAt: NOW,
    }]]]);
    const screen = { ...INITIAL_DISCOVERY_SCREEN_STATE, feed: "ott" as const, dateWindow: "all" as const };
    const withFallback = render(createElement(DiscoveryContent, {
      model: fallback, screen, dispatch: vi.fn(), active: false, cols: 120, listRows: 10,
    }));
    expect(withFallback.lastFrame()).toContain("TMDB 7.9 · 12K");
    expect(withFallback.lastFrame()).not.toContain("IMDb …");
    withFallback.unmount();
    fallback.ratings = new Map();
    const pending = render(createElement(DiscoveryContent, {
      model: fallback, screen, dispatch: vi.fn(), active: false, cols: 120, listRows: 10,
    }));
    expect(pending.lastFrame()).toContain("IMDb …");
    pending.unmount();
  });

  it("renders release fields and partial source states without torrent fields", () => {
    const screen: DiscoveryScreenState = {
      ...INITIAL_DISCOVERY_SCREEN_STATE,
      feed: "ott",
      dateWindow: "all",
    };
    const view = render(createElement(DiscoveryContent, {
      model: model(),
      screen,
      dispatch: vi.fn(),
      active: false,
      cols: 120,
      listRows: 12,
    }));
    const frame = view.lastFrame() ?? "";

    expect(frame).toContain("2026-07-10");
    expect(frame).toContain("Example Film (2026)");
    expect(frame).toContain("Netflix");
    expect(frame).toContain("Hindi");
    expect(frame).toContain("Streaming");
    expect(frame).toContain("stale");
    expect(frame).toContain("quota-paused");
    expect(frame).toContain("partial");
    expect(frame).toContain("Partial results");
    expect(frame.toLowerCase()).not.toMatch(/seeders|magnet|torrent size/);
    expect(frame).not.toContain("GB");
    view.unmount();
  });

  it("shows per-target loading progress", () => {
    const view = render(createElement(DiscoveryContent, {
      model: model({
        aggregation: aggregateDiscoverySnapshots([]),
        sourceStates: [],
        loading: true,
        done: 1,
        total: 3,
      }),
      screen: INITIAL_DISCOVERY_SCREEN_STATE,
      dispatch: vi.fn(),
      active: false,
      cols: 100,
      listRows: 10,
    }));

    expect(view.lastFrame()).toContain("loading discovery 1/3");
    view.unmount();
  });

  it("shows full evidence, attribution, and conflicting-date disclosure in details", () => {
    const snapshot = fixtureSnapshot();
    snapshot.titles[0] = {
      ...snapshot.titles[0]!,
      genreLabels: ["Drama"],
    };
    snapshot.events[0] = {
      ...snapshot.events[0]!,
      audioLanguages: ["hi", "ta"],
      subtitleLanguages: ["en"],
      evidence: [{
        ...snapshot.events[0]!.evidence[0]!,
        sourceUrl: "https://provider.example.test/title/1",
      }],
    };
    snapshot.events.push({
      ...snapshot.events[0]!,
      id: "streaming:event-conflict",
      date: "2026-07-09",
    });
    snapshot.attribution = {
      source: "streaming-availability",
      sourceLabel: "Streaming Availability",
      sourceUrl: "https://www.movieofthenight.com/about/api",
      notice: "Streaming availability data by Movie of the Night.",
    };
    const screen: DiscoveryScreenState = {
      ...INITIAL_DISCOVERY_SCREEN_STATE,
      feed: "ott",
      dateWindow: "all",
      detailsOpen: true,
    };
    const view = render(createElement(DiscoveryContent, {
      model: model({
        aggregation: aggregateDiscoverySnapshots([snapshot]),
        attributions: [
          snapshot.attribution,
          {
            source: "tmdb",
            sourceLabel: "TMDB",
            sourceUrl: "https://www.themoviedb.org",
            notice: TMDB_REQUIRED_NOTICE,
            additionalNotices: [JUSTWATCH_ATTRIBUTION_NOTICE],
          },
        ],
      }),
      screen,
      dispatch: vi.fn(),
      active: false,
      cols: 120,
      listRows: 16,
    }));
    const frame = view.lastFrame() ?? "";

    expect(frame).toContain("Media: movie");
    expect(frame).toContain("streaming added");
    expect(frame).toContain("Netflix");
    expect(frame).toContain("Hindi (hi)");
    expect(frame).toContain("Origin countries: IN");
    expect(frame).toContain("Genres: Drama");
    expect(frame).toContain("Audio: Hindi, Tamil");
    expect(frame).toContain("Subtitles: English");
    expect(frame).toContain("Evidence: Streaming Availability exact");
    expect(frame).toContain("https://provider.example.test/title/1");
    expect(frame).toContain("Attribution: Streaming availability data by Movie of the Night.");
    expect(frame).toContain("Attribution: This product uses the TMDB API");
    expect(frame).toContain(JUSTWATCH_ATTRIBUTION_NOTICE);
    expect(frame).toContain(DISCOVERY_SOURCE_CLAIM_NOTICE);
    expect(frame).toContain("Sources disagree on the event date");
    view.unmount();
  });

  it("hands off only the clean title and year on s", async () => {
    const onSearch = vi.fn();
    const screen: DiscoveryScreenState = {
      ...INITIAL_DISCOVERY_SCREEN_STATE,
      feed: "ott",
      dateWindow: "all",
    };
    const view = render(createElement(DiscoveryContent, {
      model: model(),
      screen,
      dispatch: vi.fn(),
      onSearch,
      active: true,
      cols: 100,
      listRows: 10,
    }));

    await new Promise((resolve) => setTimeout(resolve, 30));
    view.stdin.write("s");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(onSearch).toHaveBeenCalledWith("Example Film 2026");
    expect(onSearch.mock.calls[0]![0]).not.toMatch(/Netflix|Blu-ray|Hindi/);
    expect(discoverySearchQuery(model().aggregation.feeds.ott[0]!)).toBe(
      "Example Film 2026",
    );
    view.unmount();
  });

  it("distinguishes filtered-empty results from an empty source window", () => {
    const filtered = render(createElement(DiscoveryContent, {
      model: model(),
      screen: {
        ...INITIAL_DISCOVERY_SCREEN_STATE,
        feed: "ott",
        dateWindow: "all",
        media: "series",
      },
      dispatch: vi.fn(),
      active: false,
      cols: 110,
      listRows: 10,
    }));
    expect(filtered.lastFrame()).toContain("Filters removed all discovery rows");
    filtered.unmount();

    const emptySnapshot: DiscoverySnapshot = {
      source: "bluray",
      feedKind: "bluray",
      titles: [],
      events: [],
      fetchedAt: NOW,
      warnings: [],
    };
    const noEvents = render(createElement(DiscoveryContent, {
      model: model({
        aggregation: aggregateDiscoverySnapshots([emptySnapshot]),
        sourceStates: [{
          key: "bluray:rss",
          label: "Blu-ray.com RSS",
          state: {
            source: "bluray",
            label: "Blu-ray.com RSS",
            status: "ready",
            snapshot: emptySnapshot,
            warnings: [],
          },
        }],
      }),
      screen: { ...INITIAL_DISCOVERY_SCREEN_STATE, feed: "bluray" },
      dispatch: vi.fn(),
      active: false,
      cols: 110,
      listRows: 10,
    }));
    expect(noEvents.lastFrame()).toContain("No recent discovery events were reported");
    noEvents.unmount();
  });

  it("distinguishes unconfigured guidance from offline with no cache", () => {
    const unconfigured = render(createElement(DiscoveryContent, {
      model: model({
        aggregation: aggregateDiscoverySnapshots([]),
        sourceStates: [
          {
            key: "tmdb:trending",
            label: "TMDB Trending",
            state: {
              source: "tmdb",
              label: "TMDB",
              status: "unconfigured",
              warnings: [],
            },
          },
          {
            key: "streaming:recent",
            label: "Streaming Availability Recent",
            state: {
              source: "streaming-availability",
              label: "Streaming Availability",
              status: "unconfigured",
              warnings: [],
            },
          },
        ],
      }),
      screen: INITIAL_DISCOVERY_SCREEN_STATE,
      dispatch: vi.fn(),
      active: false,
      cols: 120,
      listRows: 12,
    }));
    const unconfiguredFrame = unconfigured.lastFrame() ?? "";
    expect(unconfiguredFrame).toContain("This discovery feed is unconfigured");
    expect(unconfiguredFrame).toContain("TMDB_READ_TOKEN");
    expect(unconfiguredFrame).toContain("Settings → TMDB read token");
    expect(unconfiguredFrame).toContain("STREAMING_AVAILABILITY_API_KEY");
    expect(unconfiguredFrame).toContain("Settings → Streaming Availability key");
    expect(unconfiguredFrame).toContain("Blu-ray remains available without credentials");
    unconfigured.unmount();

    const offline = render(createElement(DiscoveryContent, {
      model: model({
        aggregation: aggregateDiscoverySnapshots([]),
        sourceStates: [
          {
            key: "bluray:rss",
            label: "Blu-ray.com RSS",
            state: {
              source: "bluray",
              label: "Blu-ray.com RSS",
              status: "failed",
              warnings: [],
              error: new Error("offline"),
            },
          },
          {
            key: "tmdb:physical",
            label: "TMDB Physical",
            state: {
              source: "tmdb",
              label: "TMDB",
              status: "failed",
              warnings: [],
              error: new Error("offline"),
            },
          },
        ],
      }),
      screen: { ...INITIAL_DISCOVERY_SCREEN_STATE, feed: "bluray" },
      dispatch: vi.fn(),
      active: false,
      cols: 100,
      listRows: 10,
    }));
    expect(offline.lastFrame()).toContain("offline or unavailable");
    expect(offline.lastFrame()).toContain("no cached discovery data");
    expect(offline.lastFrame()).toContain("Results unavailable or incomplete");
    expect(offline.lastFrame()).toContain("Blu-ray.com RSS: offline");
    expect(offline.lastFrame()).toContain("TMDB Physical: offline");
    expect(offline.lastFrame()).not.toContain("0 results");
    offline.unmount();
  });

  it("qualifies empty partial and quota-paused feeds instead of claiming zero releases", () => {
    const emptySnapshot: DiscoverySnapshot = {
      source: "tmdb",
      feedKind: "physical",
      titles: [],
      events: [],
      fetchedAt: NOW,
      warnings: [],
    };
    const partial = render(createElement(DiscoveryContent, {
      model: model({
        aggregation: aggregateDiscoverySnapshots([emptySnapshot]),
        sourceStates: [
          {
            key: "tmdb:physical",
            label: "TMDB Physical",
            state: {
              source: "tmdb",
              label: "TMDB",
              status: "ready",
              snapshot: emptySnapshot,
              warnings: [],
            },
          },
          {
            key: "bluray:rss",
            label: "Blu-ray.com RSS",
            state: {
              source: "bluray",
              label: "Blu-ray.com RSS",
              status: "failed",
              warnings: [],
              error: new Error("offline"),
            },
          },
        ],
      }),
      screen: { ...INITIAL_DISCOVERY_SCREEN_STATE, feed: "bluray" },
      dispatch: vi.fn(),
      active: false,
      cols: 120,
      listRows: 12,
    }));
    const partialFrame = partial.lastFrame() ?? "";
    expect(partialFrame).toContain("Available sources reported no events");
    expect(partialFrame).toContain("result incomplete");
    expect(partialFrame).toContain("Results unavailable or incomplete");
    expect(partialFrame).not.toContain("0 results");
    partial.unmount();

    const quota = render(createElement(DiscoveryContent, {
      model: model({
        aggregation: aggregateDiscoverySnapshots([]),
        sourceStates: [{
          key: "streaming:recent",
          label: "Streaming Availability Recent",
          state: {
            source: "streaming-availability",
            label: "Streaming Availability",
            status: "quota-paused",
            warnings: [],
          },
        }],
      }),
      screen: {
        ...INITIAL_DISCOVERY_SCREEN_STATE,
        feed: "ott",
        dateWindow: "all",
      },
      dispatch: vi.fn(),
      active: false,
      cols: 120,
      listRows: 12,
    }));
    const quotaFrame = quota.lastFrame() ?? "";
    expect(quotaFrame).toContain("request quota is paused");
    expect(quotaFrame).toContain("no cached discovery data");
    expect(quotaFrame).not.toContain("0 results");
    quota.unmount();
  });

  it("shows an explicit disabled-adapter state without credential guidance", () => {
    const view = render(createElement(DiscoveryContent, {
      model: model({
        aggregation: aggregateDiscoverySnapshots([]),
        sourceStates: [{
          key: "bluray:rss",
          label: "Blu-ray.com RSS",
          state: {
            source: "bluray",
            label: "Blu-ray.com RSS",
            status: "disabled",
            warnings: [],
          },
        }],
      }),
      screen: { ...INITIAL_DISCOVERY_SCREEN_STATE, feed: "bluray" },
      dispatch: vi.fn(),
      active: false,
      cols: 110,
      listRows: 10,
    }));
    const frame = view.lastFrame() ?? "";

    expect(frame).toContain("disabled in Settings");
    expect(frame).toContain("Results unavailable or incomplete");
    expect(frame).not.toContain("TMDB_READ_TOKEN");
    expect(frame).not.toContain("STREAMING_AVAILABILITY_API_KEY");
    view.unmount();
  });
});

describe("Discover bounded load planning", () => {
  function ledger() {
    const status: BudgetStatus = {
      source: "streaming-availability",
      endpoint: "changes",
      month: "2026-07",
      used: 0,
      endpointUsed: 0,
      allowed: true,
      warning: false,
      softWarning: 350,
      hardCap: 450,
      remaining: 450,
    };
    return {
      recordAttempt: vi.fn<Pick<RequestLedger, "recordAttempt">["recordAttempt"]>(
        async () => status,
      ),
      canSpend: vi.fn<Pick<RequestLedger, "canSpend">["canSpend"]>(async () => status),
    };
  }

  it("plans only the adapters needed for each feed and date direction", () => {
    const upcoming = buildDiscoveryLoadTargets(
      defaultConfig,
      "ott",
      "upcoming-7d",
      ledger(),
      "2026-07-10",
    );
    expect(upcoming).toHaveLength(2);
    expect(upcoming[0]!.request).toMatchObject({
      feedKind: "streaming_upcoming",
      dateRange: { start: "2026-07-10", end: "2026-07-16", direction: "upcoming" },
      pageLimit: 1,
    });
    expect(upcoming[0]!.request.providerIds.length).toBeGreaterThan(0);
    expect(upcoming[1]!.request.feedKind).toBe("provider_dictionary");

    expect(buildDiscoveryLoadTargets(defaultConfig, "bluray", "30d", ledger()))
      .toHaveLength(2);
    expect(buildDiscoveryLoadTargets(defaultConfig, "charts", "30d", ledger()))
      .toMatchObject([
        {
          key: "apify:flixpatrol:netflix",
          label: "FlixPatrol Netflix India",
          request: { region: "IN", feedKind: "streaming_charts", providerIds: ["netflix"] },
        },
        { key: "apify:flixpatrol:prime", request: { providerIds: ["prime"] } },
        { key: "apify:flixpatrol:hotstar", request: { providerIds: ["hotstar"] } },
        { key: "apify:flixpatrol:zee5", request: { providerIds: ["zee5"] } },
      ]);
    expect(buildDiscoveryLoadTargets(defaultConfig, "community", "30d", ledger()))
      .toMatchObject([{
        key: "apify:letterboxd-community",
        label: "Letterboxd Weekly Popular",
        request: { region: "ZZ", feedKind: "community_popular" },
      }]);
    expect(discoveryDateSelection("7d", "2026-07-10")).toEqual({
      direction: "past",
      range: { start: "2026-07-04", end: "2026-07-10" },
    });
    expect(discoveryDateSelection("upcoming-30d", "2026-07-10")).toEqual({
      direction: "upcoming",
      range: { start: "2026-07-10", end: "2026-08-08" },
    });
    expect(discoveryDateSelection("all", "2026-07-10")).toEqual({ direction: "past" });
  });

  it("merges rebrand aliases by normalized ID and preserves unknown providers", () => {
    expect(mergeDiscoveryProviders([
      { id: "hotstar", label: "Hotstar", upstreamAliases: ["hotstar"] },
      { id: "hotstar", label: "JioHotstar", upstreamAliases: ["hotstar", "JioHotstar"] },
      { id: "localflix", label: "LocalFlix", upstreamAliases: ["localflix"] },
    ])).toEqual([
      {
        id: "hotstar",
        label: "JioHotstar",
        upstreamAliases: ["hotstar", "JioHotstar"],
      },
      { id: "localflix", label: "LocalFlix", upstreamAliases: ["localflix"] },
    ]);
  });

  it("keeps the documented language order and labels additional audio separately", () => {
    expect(DISCOVERY_LANGUAGE_FILTERS.map((choice) => choice.label)).toEqual([
      "All languages",
      "Hindi",
      "Kannada",
      "Tamil",
      "Telugu",
      "Malayalam",
      "Bengali",
      "Marathi",
      "Punjabi",
      "Gujarati",
      "English",
      "Other",
    ]);
    const entry = model().aggregation.feeds.ott[0]!;
    expect(discoveryLanguageSummary({
      ...entry,
      event: { ...entry.event!, audioLanguages: ["hi", "ta"] },
    })).toBe("Hindi · audio Tamil");
  });

  it("selects every retained cache snapshot relevant to All cached", () => {
    const recent = fixtureSnapshot();
    const upcoming = {
      ...fixtureSnapshot(),
      feedKind: "streaming_upcoming" as const,
      fetchedAt: NOW + 1,
    };
    const bluray = {
      ...fixtureSnapshot(),
      source: "bluray" as const,
      feedKind: "bluray" as const,
      fetchedAt: NOW + 2,
    };
    const charts = {
      ...fixtureSnapshot(),
      source: "apify" as const,
      feedKind: "streaming_charts" as const,
      events: [],
      fetchedAt: NOW + 3,
    };
    const community = {
      ...fixtureSnapshot(),
      source: "apify" as const,
      feedKind: "community_popular" as const,
      events: [],
      fetchedAt: NOW + 4,
    };
    const requestBase = {
      region: "IN",
      mediaTypes: ["movie" as const],
      providerIds: [],
      pageLimit: 1,
    };
    const document: DiscoveryCacheDocument = {
      version: 1,
      entries: {
        recent: {
          source: "streaming-availability",
          request: { ...requestBase, feedKind: "streaming_added" },
          snapshot: recent,
          expiresAt: NOW + 1,
          staleUntil: NOW + 10_000,
        },
        upcoming: {
          source: "streaming-availability",
          request: { ...requestBase, feedKind: "streaming_upcoming" },
          snapshot: upcoming,
          expiresAt: NOW + 1,
          staleUntil: NOW + 10_000,
        },
        bluray: {
          source: "bluray",
          request: { ...requestBase, region: "ZZ", feedKind: "bluray" },
          snapshot: bluray,
          expiresAt: NOW + 1,
          staleUntil: NOW + 10_000,
        },
        charts: {
          source: "apify",
          request: { ...requestBase, feedKind: "streaming_charts" },
          snapshot: charts,
          expiresAt: NOW + 1,
          staleUntil: NOW + 10_000,
        },
        community: {
          source: "apify",
          request: { ...requestBase, region: "ZZ", feedKind: "community_popular" },
          snapshot: community,
          expiresAt: NOW + 1,
          staleUntil: NOW + 10_000,
        },
        expired: {
          source: "streaming-availability",
          request: { ...requestBase, feedKind: "streaming_added" },
          snapshot: { ...recent, fetchedAt: NOW - 10_000 },
          expiresAt: NOW - 2,
          staleUntil: NOW - 1,
        },
      },
    };

    expect(cachedSnapshotsForDiscoveryFeed(document, "ott", NOW)
      .map((snapshot) => snapshot.feedKind)).toEqual([
      "streaming_added",
      "streaming_upcoming",
    ]);
    expect(cachedSnapshotsForDiscoveryFeed(document, "bluray", NOW)
      .map((snapshot) => snapshot.source)).toEqual(["bluray"]);
    expect(cachedSnapshotsForDiscoveryFeed(document, "bluray", NOW, ["bluray"]))
      .toEqual([]);
    expect(cachedSnapshotsForDiscoveryFeed(document, "charts", NOW)
      .map((snapshot) => snapshot.feedKind)).toEqual(["streaming_charts"]);
    expect(cachedSnapshotsForDiscoveryFeed(document, "community", NOW)
      .map((snapshot) => snapshot.feedKind)).toEqual(["community_popular"]);
  });

  it("marks explicitly disabled load targets unconfigured even when keys exist", () => {
    const configured: Config = {
      ...defaultConfig,
      discovery: {
        tmdb: { readToken: "tmdb-token" },
        streamingAvailability: { apiKey: "streaming-key" },
        disabledSources: ["tmdb", "bluray", "streaming-availability"],
      },
    };
    const targets = [
      ...buildDiscoveryLoadTargets(configured, "ott", "7d", ledger(), "2026-07-10"),
      ...buildDiscoveryLoadTargets(configured, "bluray", "7d", ledger(), "2026-07-10"),
    ];

    expect(targets.every((target) => !target.adapter.isConfigured())).toBe(true);
  });
});

describe("Discover interactions", () => {
  it("keeps feed subtabs visible when a populated feed fills the viewport", () => {
    const snapshot = fixtureSnapshot();
    snapshot.titles = Array.from({ length: 20 }, (_, index) => ({
      ...snapshot.titles[0]!,
      id: `streaming:title-${index}`,
      title: `Example Film ${index}`,
    }));
    snapshot.events = snapshot.titles.map((title, index) => ({
      ...snapshot.events[0]!,
      id: `streaming:event-${index}`,
      titleId: title.id,
    }));
    const uiModel = model({ aggregation: aggregateDiscoverySnapshots([snapshot]) });
    const screen = {
      ...INITIAL_DISCOVERY_SCREEN_STATE,
      feed: "ott" as const,
    };
    const view = render(createElement(
      Box,
      { height: 12, flexDirection: "column" },
      createElement(DiscoveryContent, {
        model: uiModel,
        screen,
        dispatch: vi.fn(),
        active: false,
        cols: 78,
        listRows: 12,
      }),
    ));

    const frame = view.lastFrame() ?? "";
    expect(frame).toContain("Trending");
    expect(frame).toContain("[OTT]");
    expect(frame).toContain("Blu-ray");
    expect(frame).toContain("Popular");
    expect(frame).toContain("India Charts");
    expect(frame).toContain("Community");
    view.unmount();
  });

  it("switches feed, media type, and date window through the live reducer", async () => {
    const view = render(createElement(Harness, { uiModel: model() }));
    await new Promise((resolve) => setTimeout(resolve, 30));

    view.stdin.write(RIGHT);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(view.lastFrame()).toContain("[OTT]");
    view.stdin.write("m");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(view.lastFrame()).toContain("Movies");
    view.stdin.write("t");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(view.lastFrame()).toContain("Upcoming 7d");
    view.unmount();
  });

  it("exposes Community as the sixth Discover subtab", async () => {
    const view = render(createElement(Harness, { uiModel: model() }));
    await new Promise((resolve) => setTimeout(resolve, 30));

    view.stdin.write("6");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(view.lastFrame()).toContain("[Community]");
    expect(view.lastFrame()).not.toContain("All providers");
    view.unmount();
  });

  it("cycles live and unknown provider choices without fragmenting IDs", async () => {
    const uiModel = model({
      providers: [
        { id: "netflix", label: "Netflix", upstreamAliases: ["netflix"] },
        { id: "localflix", label: "LocalFlix", upstreamAliases: ["localflix"] },
      ],
    });
    const initial: DiscoveryScreenState = {
      ...INITIAL_DISCOVERY_SCREEN_STATE,
      feed: "ott",
      dateWindow: "all",
    };
    const view = render(createElement(Harness, { uiModel, initial }));
    await new Promise((resolve) => setTimeout(resolve, 30));

    view.stdin.write("p");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(view.lastFrame()).toContain("Netflix");
    expect(view.lastFrame()).toContain("Example Film");
    view.stdin.write("p");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(view.lastFrame()).toContain("LocalFlix");
    expect(view.lastFrame()).toContain("Filters removed all discovery rows");
    view.unmount();
  });

  it("cycles ordered language filters while keeping original language primary", async () => {
    const initial: DiscoveryScreenState = {
      ...INITIAL_DISCOVERY_SCREEN_STATE,
      feed: "ott",
      dateWindow: "all",
    };
    const view = render(createElement(Harness, { uiModel: model(), initial }));
    await new Promise((resolve) => setTimeout(resolve, 30));

    view.stdin.write("l");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(view.lastFrame()).toContain("Hindi");
    expect(view.lastFrame()).toContain("Example Film");
    view.unmount();
  });

  it("opens and closes details from the selected row", async () => {
    const initial: DiscoveryScreenState = {
      ...INITIAL_DISCOVERY_SCREEN_STATE,
      feed: "ott",
      dateWindow: "all",
    };
    const view = render(createElement(Harness, { uiModel: model(), initial }));
    await new Promise((resolve) => setTimeout(resolve, 30));

    view.stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(view.lastFrame()).toContain("Media: movie");
    view.stdin.write(ESCAPE);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(view.lastFrame()).toContain("Example Film (2026)");
    expect(view.lastFrame()).not.toContain("Media: movie");
    view.unmount();
  });

  it("drops provider, language, and source columns before rating data on narrow terminals", () => {
    const screen: DiscoveryScreenState = {
      ...INITIAL_DISCOVERY_SCREEN_STATE,
      feed: "ott",
      dateWindow: "all",
    };
    const view = render(createElement(DiscoveryContent, {
      model: model({ sourceStates: [] }),
      screen,
      dispatch: vi.fn(),
      active: false,
      cols: 60,
      listRows: 8,
    }));
    const frame = view.lastFrame() ?? "";

    expect(frame).toContain("Example Film");
    expect(frame).not.toContain("Netflix");
    expect(frame).not.toContain("Hindi");
    expect(frame).not.toContain("Streaming Avai");
    view.unmount();
  });

  it("ignores torrent-only copy/open/debrid keys", async () => {
    const uiModel = model();
    const onSearch = vi.fn();
    const initial: DiscoveryScreenState = {
      ...INITIAL_DISCOVERY_SCREEN_STATE,
      feed: "ott",
      dateWindow: "all",
    };
    const view = render(createElement(Harness, { uiModel, initial, onSearch }));
    await new Promise((resolve) => setTimeout(resolve, 30));

    view.stdin.write("yob");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(onSearch).not.toHaveBeenCalled();
    expect(uiModel.refresh).not.toHaveBeenCalled();
    expect(view.lastFrame()).toContain("Example Film (2026)");
    view.unmount();
  });
});
