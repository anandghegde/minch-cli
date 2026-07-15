import { useCallback, useEffect, useMemo, useState } from "react";
import type { Config, DiscoveryAdapterId } from "../../config/config";
import type {
  DiscoveryAdapter,
  DiscoveryAttribution,
  DiscoverySnapshot,
} from "../../discovery/adapter";
import {
  aggregateDiscoverySnapshots,
  type DiscoveryAggregation,
  type DiscoveryEventDateSelection,
} from "../../discovery/aggregate";
import { createRequestLedger, type RequestLedger } from "../../discovery/budget";
import { createDiscoveryCacheRepository } from "../../discovery/cache-repository";
import type { DiscoveryCacheDocument } from "../../discovery/cache";
import { indiaToday, shiftDateOnly } from "../../discovery/dates";
import type { DiscoveryRequest } from "../../discovery/request";
import { sanitizeDiscoverySnapshot } from "../../discovery/security";
import { createDiscoveryService } from "../../discovery/service";
import {
  loadDiscoverySourceState,
  type DiscoverySourceState,
} from "../../discovery/state";
import { createBlurayAdapter } from "../../discovery/sources/bluray";
import { createTmdbAdapter } from "../../discovery/sources/tmdb";
import {
  createStreamingAvailabilityAdapter,
  UPCOMING_SUPPORTED_PROVIDER_IDS,
} from "../../discovery/sources/streaming-availability";
import { createApifyAdapter } from "../../discovery/sources/apify";
import { createTamilmvAdapter } from "../../discovery/sources/tamilmv";
import type { DiscoveryDateWindow, DiscoveryFeed } from "../discovery-state";
import type { NormalizedProvider } from "../../discovery/normalize";
import type { CatalogRating } from "../../discovery/types";
import { useDiscoveryRatings } from "./useDiscoveryRatings";
import { logError, logEvent } from "../../util/logger";

type DiscoveryLoadFeed = DiscoveryFeed | "india";

const cache = createDiscoveryCacheRepository();
const ledger = createRequestLedger();
const service = createDiscoveryService({ cache, fetchImpl: (...args) => fetch(...args) });

export interface DiscoveryLoadTarget {
  key: string;
  label: string;
  adapter: DiscoveryAdapter;
  request: DiscoveryRequest;
}

export interface DiscoveryUiSourceState {
  key: string;
  label: string;
  state: DiscoverySourceState;
}

export interface DiscoveryUiModel {
  aggregation: DiscoveryAggregation;
  sourceStates: DiscoveryUiSourceState[];
  loading: boolean;
  done: number;
  total: number;
  providers: NonNullable<DiscoverySnapshot["providers"]>;
  attributions: DiscoveryAttribution[];
  ratings: ReadonlyMap<string, CatalogRating[]>;
  ratingsLoading: boolean;
  ratingsExactCount: number;
  ratingsFallbackCount: number;
  ratingsUnresolvedCount: number;
  refresh(): void;
}

export function mergeDiscoveryProviders(
  providers: readonly NormalizedProvider[],
): NormalizedProvider[] {
  const grouped = new Map<string, NormalizedProvider>();
  for (const provider of providers) {
    const existing = grouped.get(provider.id);
    grouped.set(provider.id, {
      id: provider.id,
      label: provider.label || existing?.label || provider.id,
      upstreamAliases: [...new Set([
        ...(existing?.upstreamAliases ?? []),
        ...provider.upstreamAliases,
      ])],
    });
  }
  return [...grouped.values()];
}

const FEED_CACHE_KINDS: Record<DiscoveryLoadFeed, Set<DiscoveryRequest["feedKind"]>> = {
  trending: new Set(["trending"]),
  popular: new Set(["provider_popular"]),
  charts: new Set(["streaming_charts"]),
  community: new Set(["community_popular"]),
  ott: new Set(["streaming_added", "streaming_upcoming", "provider_dictionary"]),
  bluray: new Set(["bluray", "physical"]),
  tamilmv: new Set(["tamilmv_latest"]),
  india: new Set([
    "streaming_added",
    "streaming_upcoming",
    "provider_dictionary",
    "digital",
    "physical",
  ]),
};

export function cachedSnapshotsForDiscoveryFeed(
  document: DiscoveryCacheDocument,
  feed: DiscoveryLoadFeed,
  now = Date.now(),
  disabledSources: readonly DiscoveryAdapterId[] = [],
): DiscoverySnapshot[] {
  return Object.values(document.entries)
    .filter((entry) =>
      entry.staleUntil >= now &&
      !disabledSources.includes(entry.source as DiscoveryAdapterId) &&
      FEED_CACHE_KINDS[feed].has(entry.request.feedKind) &&
      ((feed !== "india" && feed !== "ott") || entry.request.region === "IN"))
    .map((entry) => sanitizeDiscoverySnapshot(entry.snapshot));
}

function distinctSnapshots(snapshots: DiscoverySnapshot[]): DiscoverySnapshot[] {
  const unique = new Map<string, DiscoverySnapshot>();
  for (const snapshot of snapshots) {
    const key = [
      snapshot.source,
      snapshot.feedKind ?? "",
      snapshot.fetchedAt,
      snapshot.cursor ?? "",
    ].join("\u0000");
    unique.set(key, snapshot);
  }
  return [...unique.values()];
}

function recentDays(dateWindow: DiscoveryDateWindow): number {
  return dateWindow === "7d" || dateWindow === "upcoming-7d" ? 7 : 30;
}

export function discoveryDateSelection(
  dateWindow: DiscoveryDateWindow,
  today = indiaToday(),
): DiscoveryEventDateSelection {
  const upcoming = dateWindow.startsWith("upcoming-");
  if (dateWindow === "all") return { direction: "past" };
  const days = recentDays(dateWindow);
  return {
    direction: upcoming ? "upcoming" : "past",
    range: upcoming
      ? { start: today, end: shiftDateOnly(today, days - 1) }
      : { start: shiftDateOnly(today, -(days - 1)), end: today },
  };
}

function requestRange(dateWindow: DiscoveryDateWindow, today: string) {
  const selection = discoveryDateSelection(
    dateWindow === "all" ? "30d" : dateWindow,
    today,
  );
  return {
    ...selection.range!,
    direction: selection.direction,
  };
}

function request(
  feedKind: DiscoveryRequest["feedKind"],
  region: string,
  dateWindow: DiscoveryDateWindow,
  today: string,
  overrides: Partial<DiscoveryRequest> = {},
): DiscoveryRequest {
  return {
    region,
    feedKind,
    ...((feedKind === "trending" || feedKind === "provider_popular" || feedKind === "streaming_charts" || feedKind === "community_popular" || feedKind === "provider_dictionary" || feedKind === "bluray" || feedKind === "tamilmv_latest")
      ? {}
      : { dateRange: requestRange(dateWindow, today) }),
    mediaTypes: ["movie", "series"],
    providerIds: [],
    pageLimit: feedKind === "streaming_added" ? 4 : 1,
    ...overrides,
  };
}

export function buildDiscoveryLoadTargets(
  config: Config,
  feed: DiscoveryLoadFeed,
  dateWindow: DiscoveryDateWindow,
  requestLedger: Pick<RequestLedger, "recordAttempt" | "canSpend"> = ledger,
  today = indiaToday(),
): DiscoveryLoadTarget[] {
  const tmdb = createTmdbAdapter({ config, ledger: requestLedger });
  const streaming = createStreamingAvailabilityAdapter({ config, ledger: requestLedger });
  const apify = createApifyAdapter({ config, ledger: requestLedger });
  const bluray = createBlurayAdapter({ config, ledger: requestLedger });
  const tamilmv = createTamilmvAdapter({ config, ledger: requestLedger });
  if (feed === "trending") {
    return [{
      key: "tmdb:trending",
      label: "TMDB Trending",
      adapter: tmdb,
      request: request("trending", "IN", dateWindow, today),
    }];
  }
  if (feed === "ott") {
    const upcoming = dateWindow.startsWith("upcoming-");
    return [
      {
        key: `streaming-availability:${upcoming ? "upcoming" : "added"}`,
        label: `Streaming Availability ${upcoming ? "Upcoming" : "Recent"}`,
        adapter: streaming,
        request: request(
          upcoming ? "streaming_upcoming" : "streaming_added",
          "IN",
          dateWindow,
          today,
          upcoming ? { providerIds: [...UPCOMING_SUPPORTED_PROVIDER_IDS] } : {},
        ),
      },
      {
        key: "streaming-availability:providers",
        label: "India Provider Dictionary",
        adapter: streaming,
        request: request("provider_dictionary", "IN", dateWindow, today),
      },
    ];
  }
  if (feed === "popular") {
    return [{
      key: "apify:popular",
      label: "Apify OTT Popular",
      adapter: apify,
      request: request("provider_popular", "IN", dateWindow, today),
    }];
  }
  if (feed === "charts") {
    return [
      ["netflix", "Netflix"],
      ["prime", "Prime Video"],
      ["hotstar", "JioHotstar"],
      ["zee5", "ZEE5"],
    ].map(([providerId, providerLabel]) => ({
      key: `apify:flixpatrol:${providerId}`,
      label: `FlixPatrol ${providerLabel} India`,
      adapter: apify,
      request: request("streaming_charts", "IN", dateWindow, today, {
        providerIds: [providerId!],
      }),
    }));
  }
  if (feed === "community") {
    return [{
      key: "apify:letterboxd-community",
      label: "Letterboxd Weekly Popular",
      adapter: apify,
      request: request("community_popular", "ZZ", dateWindow, today),
    }];
  }
  if (feed === "bluray") {
    return [
      {
        key: "bluray:rss",
        label: "Blu-ray.com RSS",
        adapter: bluray,
        request: request("bluray", "ZZ", dateWindow, today, { mediaTypes: ["movie"] }),
      },
      {
        key: "tmdb:physical",
        label: "TMDB Physical",
        adapter: tmdb,
        request: request("physical", "IN", dateWindow, today, { mediaTypes: ["movie"] }),
      },
    ];
  }
  if (feed === "tamilmv") {
    return [{
      key: "tamilmv:latest",
      label: "1TamilMV Latest + Recent",
      adapter: tamilmv,
      // Homepage + forums + activity stream (capped by TAMILMV_LISTING_PATHS).
      request: request("tamilmv_latest", "IN", dateWindow, today, { pageLimit: 3 }),
    }];
  }
  const upcoming = dateWindow.startsWith("upcoming-");
  return [
    {
      key: `streaming-availability:${upcoming ? "upcoming" : "added"}`,
      label: `Streaming Availability ${upcoming ? "Upcoming" : "Recent"}`,
      adapter: streaming,
      request: request(
        upcoming ? "streaming_upcoming" : "streaming_added",
        "IN",
        dateWindow,
        today,
        upcoming ? { providerIds: [...UPCOMING_SUPPORTED_PROVIDER_IDS] } : {},
      ),
    },
    {
      key: "streaming-availability:providers",
      label: "India Provider Dictionary",
      adapter: streaming,
      request: request("provider_dictionary", "IN", dateWindow, today),
    },
    {
      key: "tmdb:digital",
      label: "TMDB Digital",
      adapter: tmdb,
      request: request("digital", "IN", dateWindow, today, { mediaTypes: ["movie"] }),
    },
    {
      key: "tmdb:physical",
      label: "TMDB Physical",
      adapter: tmdb,
      request: request("physical", "IN", dateWindow, today, { mediaTypes: ["movie"] }),
    },
  ];
}

const EMPTY_AGGREGATION = aggregateDiscoverySnapshots([]);

export function useDiscovery(
  config: Config,
  feed: DiscoveryFeed,
  dateWindow: DiscoveryDateWindow,
  active: boolean,
): DiscoveryUiModel {
  const [sourceStates, setSourceStates] = useState<DiscoveryUiSourceState[]>([]);
  const [loading, setLoading] = useState(false);
  const [cachedFallback, setCachedFallback] = useState<DiscoverySnapshot[]>([]);
  const [revision, setRevision] = useState(0);
  const today = indiaToday();
  const disabledSourcesKey = (config.discovery?.disabledSources ?? []).slice().sort().join(",");
  const targets = useMemo(
    () => buildDiscoveryLoadTargets(config, feed, dateWindow, ledger, today),
    [
      config.discovery?.streamingAvailability?.apiKey,
      config.discovery?.tmdb?.readToken,
      config.discovery?.apify?.apiToken,
      dateWindow,
      disabledSourcesKey,
      feed,
      today,
    ],
  );

  useEffect(() => {
    if (!active) {
      logEvent("debug", "discover.load.inactive", { feed, dateWindow });
      return;
    }
    const controller = new AbortController();
    let alive = true;
    let completedSources = 0;
    const startedAt = Date.now();
    logEvent("info", "discover.load.started", {
      feed,
      dateWindow,
      targets: targets.map((target) => ({
        key: target.key,
        source: target.adapter.id,
        feedKind: target.request.feedKind,
        region: target.request.region,
      })),
      revision,
    });
    setLoading(true);
    setSourceStates([]);
    const targetOrder = new Map(targets.map((target, index) => [target.key, index]));
    const putState = (item: DiscoveryUiSourceState) => {
      setSourceStates((current) => [
        ...current.filter((entry) => entry.key !== item.key),
        item,
      ].sort((left, right) =>
        (targetOrder.get(left.key) ?? 0) - (targetOrder.get(right.key) ?? 0)));
    };
    void Promise.all(targets.map(async (target): Promise<DiscoveryUiSourceState> => {
      const item = {
        key: target.key,
        label: target.label,
        state: await loadDiscoverySourceState(
          service,
          target.adapter,
          target.request,
          { signal: controller.signal },
        ),
      };
      completedSources += 1;
      logEvent(item.state.status === "failed" ? "warn" : "info", "discover.source.settled", {
        feed,
        target: target.key,
        source: item.state.source,
        status: item.state.status,
        titleCount: item.state.snapshot?.titles.length ?? 0,
        eventCount: item.state.snapshot?.events.length ?? 0,
        warningCount: item.state.warnings.length,
        error: item.state.error?.message,
        elapsedMs: Date.now() - startedAt,
      });
      if (alive) putState(item);
      if (item.state.refresh) {
        void item.state.refresh
          .then((state) => {
            logEvent(state.status === "failed" ? "warn" : "info", "discover.source.refresh_settled", {
              feed,
              target: target.key,
              source: state.source,
              status: state.status,
              error: state.error?.message,
              elapsedMs: Date.now() - startedAt,
            });
            if (alive) putState({ ...item, state });
          })
          .catch((error: unknown) => {
            if (!controller.signal.aborted) {
              logError("discover.source.refresh_failed", error, {
                feed,
                target: target.key,
                elapsedMs: Date.now() - startedAt,
              });
            }
          });
      }
      return item;
    })).then(() => {
      logEvent("info", "discover.load.completed", {
        feed,
        dateWindow,
        targetCount: targets.length,
        elapsedMs: Date.now() - startedAt,
      });
      if (alive) setLoading(false);
    }).catch((error: unknown) => {
      logError("discover.load.failed", error, {
        feed,
        dateWindow,
        aborted: controller.signal.aborted,
        elapsedMs: Date.now() - startedAt,
      });
      if (alive) setLoading(false);
    });
    return () => {
      alive = false;
      logEvent("info", "discover.load.cancelled", {
        feed,
        dateWindow,
        completedSources,
        targetCount: targets.length,
        elapsedMs: Date.now() - startedAt,
      });
      controller.abort();
    };
  }, [active, revision, targets]);

  useEffect(() => {
    if (dateWindow !== "all") {
      setCachedFallback([]);
      return;
    }
    let alive = true;
    void cache.load()
      .then(({ document }) => {
        if (alive) {
          setCachedFallback(cachedSnapshotsForDiscoveryFeed(
            document,
            feed,
            Date.now(),
            config.discovery?.disabledSources,
          ));
        }
      })
      .catch(() => {
        logEvent("warn", "discover.cache.load_failed", { feed, dateWindow });
        if (alive) setCachedFallback([]);
      });
    return () => {
      alive = false;
    };
  }, [config.discovery?.disabledSources, dateWindow, feed, revision]);

  const snapshots = useMemo(() => distinctSnapshots([
    ...sourceStates.flatMap((item) => item.state.snapshot ? [item.state.snapshot] : []),
    ...(dateWindow === "all" ? cachedFallback : []),
  ]), [cachedFallback, dateWindow, sourceStates]);
  const aggregation = useMemo(
    () => snapshots.length > 0
      ? aggregateDiscoverySnapshots(snapshots, { includeGenericPhysical: feed === "bluray" })
      : EMPTY_AGGREGATION,
    [feed, snapshots],
  );
  const providers = mergeDiscoveryProviders(
    snapshots.flatMap((snapshot) => snapshot.providers ?? []),
  );
  const attributions = [...new Map(snapshots.flatMap((snapshot) =>
    snapshot.attribution ? [[snapshot.attribution.source, snapshot.attribution] as const] : [])
    .map(([source, attribution]) => [source, attribution])).values()];
  const ratings = useDiscoveryRatings(config, aggregation.titles, active, revision);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  return {
    aggregation,
    sourceStates,
    loading,
    done: sourceStates.length,
    total: targets.length,
    providers,
    attributions,
    ratings: ratings.byTitleId,
    ratingsLoading: ratings.loading,
    ratingsExactCount: ratings.exactCount,
    ratingsFallbackCount: ratings.fallbackCount,
    ratingsUnresolvedCount: ratings.unresolvedCount,
    refresh,
  };
}
