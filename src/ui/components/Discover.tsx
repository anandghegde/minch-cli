import { useEffect, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import {
  selectDiscoveryEntries,
  type DiscoveryFeedEntry,
  type DiscoveryFeedFilters,
} from "../../discovery/aggregate";
import {
  DISCOVERY_SOURCE_CLAIM_NOTICE,
  IMDB_REQUIRED_NOTICE,
} from "../../discovery/attribution";
import { languageLabel, normalizeLanguage } from "../../discovery/normalize";
import { buildDiscoverySearchQuery } from "../../discovery/search-handoff";
import type { CatalogRating, DiscoverySource } from "../../discovery/types";
import {
  formatRatingValue,
  selectPreferredRating,
} from "../../discovery/ratings/types";
import { cleanText, formatRelative, truncate } from "../../util/format";
import { logEvent } from "../../util/logger";
import {
  DISCOVERY_DATE_WINDOWS,
  DISCOVERY_DATE_WINDOW_LABELS,
  DISCOVERY_FEEDS,
  DISCOVERY_LANGUAGE_FILTERS,
  DISCOVERY_MEDIA_FILTERS,
  useDiscoveryScreenState,
  type DiscoveryScreenAction,
  type DiscoveryScreenState,
} from "../discovery-state";
import {
  discoveryDateSelection,
  useDiscovery,
  type DiscoveryUiModel,
} from "../hooks/useDiscovery";
import { useStore } from "../store";
import { COLOR, ICON } from "../theme";
import { Spinner } from "./Spinner";

const FEED_LABELS = {
  trending: "Trending",
  popular: "Popular",
  charts: "India Charts",
  community: "Community",
  ott: "OTT",
  bluray: "Blu-ray",
  tamilmv: "TamilMV",
} as const;

const MEDIA_LABELS = { all: "All", movie: "Movies", series: "Series" } as const;

const MEDIA_TYPE_LABELS = { movie: "Movie", series: "TV", season: "TV", episode: "TV" } as const;

const SOURCE_LABELS: Record<DiscoverySource, string> = {
  tmdb: "TMDB",
  bluray: "Blu-ray.com",
  trakt: "Trakt",
  "streaming-availability": "Streaming Availability",
  apify: "Apify",
  tamilmv: "1TamilMV",
};

export interface DiscoveryContentProps {
  model: DiscoveryUiModel;
  screen: DiscoveryScreenState;
  dispatch: (action: DiscoveryScreenAction) => void;
  active: boolean;
  cols: number;
  listRows: number;
  onSearch?: (query: string) => void;
}

export type DiscoveryEmptyReason =
  | "filters"
  | "no-events"
  | "partial-no-events"
  | "offline-no-cache"
  | "quota-no-cache"
  | "disabled"
  | "unconfigured";

export function discoveryEmptyReason(
  model: DiscoveryUiModel,
  baseCount: number,
): DiscoveryEmptyReason {
  if (baseCount > 0) return "filters";
  const states = model.sourceStates.map((item) => item.state);
  const noCache = states.every((state) => !state.snapshot);
  if (
    noCache &&
    states.length > 0 &&
    states.every((state) => state.status === "disabled")
  ) {
    return "disabled";
  }
  if (
    noCache &&
    states.length > 0 &&
    states.every((state) => state.status === "unconfigured" || state.status === "auth-failed")
  ) {
    return "unconfigured";
  }
  if (noCache && states.some((state) => state.status === "failed")) {
    return "offline-no-cache";
  }
  if (noCache && states.some((state) => state.status === "quota-paused")) {
    return "quota-no-cache";
  }
  if (states.some((state) =>
    state.status === "stale" ||
    state.status === "disabled" ||
    state.status === "unconfigured" ||
    state.status === "auth-failed" ||
    state.status === "quota-paused" ||
    state.status === "failed")) {
    return "partial-no-events";
  }
  return "no-events";
}

export function discoverySearchQuery(entry: DiscoveryFeedEntry): string | undefined {
  return buildDiscoverySearchQuery(entry.title);
}

export function discoveryLanguageSummary(entry: DiscoveryFeedEntry): string {
  const original = normalizeLanguage(entry.title?.originalLanguage);
  const audio = [...new Set((entry.event?.audioLanguages ?? []).flatMap((value) => {
    const normalized = normalizeLanguage(value);
    return normalized && normalized.code !== original?.code ? [normalized.label] : [];
  }))];
  if (original && audio.length > 0) return `${original.label} · audio ${audio.join(", ")}`;
  if (original) return original.label;
  if (audio.length > 0) return `audio ${audio.join(", ")}`;
  return "—";
}

function cycle<T extends readonly string[]>(values: T, current: T[number], delta: number): T[number] {
  const index = values.indexOf(current);
  return values[(index + delta + values.length) % values.length]!;
}

function blurayTitleKey(entry: DiscoveryFeedEntry): string | undefined {
  if (!entry.title) return undefined;
  const normalizedTitle = cleanText(entry.title.title)
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  return `${normalizedTitle}\u0000${entry.title.year ?? ""}\u0000${entry.title.mediaType}`;
}

export function dedupeBlurayEntries(entries: readonly DiscoveryFeedEntry[]): DiscoveryFeedEntry[] {
  const seenTitles = new Set<string>();
  return entries.filter((entry) => {
    const key = blurayTitleKey(entry);
    if (!key) return true;
    if (seenTitles.has(key)) return false;
    seenTitles.add(key);
    return true;
  });
}

function sourceNames(entry: DiscoveryFeedEntry, feed: DiscoveryScreenState["feed"]): string {
  if (!entry.event) {
    return feed === "popular" || feed === "charts" || feed === "community" ? "Apify" : "TMDB";
  }
  return [...new Set(entry.event.evidence.map((evidence) => SOURCE_LABELS[evidence.source]))]
    .join("+");
}

function eventLabel(entry: DiscoveryFeedEntry, feed: DiscoveryScreenState["feed"]): string {
  if (!entry.event) {
    if (feed === "charts") return entry.title?.providerLabels?.join("+") ?? "Chart";
    if (feed === "community") return "Letterboxd";
    return feed === "popular" ? "Popular" : "Trending";
  }
  return cleanText(entry.event.providerLabel ??
    entry.event.formatLabel ??
    entry.event.kind.replace(/_/g, " "));
}

function sourceStatusText(model: DiscoveryUiModel): string {
  return model.sourceStates.map(({ label, state }) => `${label}: ${state.status}`).join(" · ");
}

export function formatVoteCount(value: number): string {
  if (!Number.isInteger(value) || value < 0) return "";
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${Math.round(value / 1_000)}K`;
  const millions = value / 1_000_000;
  return `${millions >= 10 ? Math.round(millions) : millions.toFixed(1).replace(/\.0$/, "")}M`;
}

function ratingLabel(rating: CatalogRating): string {
  return rating.system === "imdb" ? "IMDb" : rating.system === "tmdb" ? "TMDB" : "Score";
}

function formattedScore(rating: CatalogRating): string {
  const value = formatRatingValue(rating);
  return rating.system === "aggregate" ? String(Math.round(rating.value)) : value.toFixed(1);
}

export function formatDiscoveryRating(rating: CatalogRating): string {
  const votes = rating.voteCount === undefined ? "" : ` · ${formatVoteCount(rating.voteCount)}`;
  return `${ratingLabel(rating)} ${formattedScore(rating)}${votes}`;
}

function formatCompactRating(rating: CatalogRating): string {
  if (rating.system === "aggregate") return `Score ${Math.round(rating.value)}`;
  return `${formattedScore(rating)}${rating.voteCount === undefined ? "" : `/${formatVoteCount(rating.voteCount)}`}`;
}

function providerDescription(rating: CatalogRating): string {
  if (rating.provider === "imdb-dataset") return "Official IMDb dataset";
  if (rating.provider === "mdblist") return "MDBList · IMDb rating";
  if (rating.provider === "tmdb") return "TMDB";
  return "Streaming Availability blended score";
}

function formatRatingAge(observedAt: number): string {
  const minutes = Math.max(0, Math.floor((Date.now() - observedAt) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function sameClaim(left: DiscoveryFeedEntry["event"], right: DiscoveryFeedEntry["event"]): boolean {
  return !!left && !!right &&
    left.titleId === right.titleId &&
    left.providerId === right.providerId &&
    left.region === right.region &&
    left.kind === right.kind &&
    left.formatLabel === right.formatLabel &&
    left.accessType === right.accessType;
}

function sourcesDisagree(entry: DiscoveryFeedEntry, model: DiscoveryUiModel): boolean {
  if (!entry.event?.date) return false;
  const dates = new Set(model.aggregation.events
    .filter((event) => sameClaim(entry.event, event) && event.date)
    .map((event) => event.date!));
  return dates.size > 1;
}

function DiscoveryDetails({
  entry,
  model,
  cols,
  feed,
}: {
  entry: DiscoveryFeedEntry;
  model: DiscoveryUiModel;
  cols: number;
  feed: DiscoveryScreenState["feed"];
}) {
  const { title, event } = entry;
  const attributions = model.attributions;
  const rating = title ? selectPreferredRating(model.ratings.get(title.id) ?? title.ratings ?? []) : undefined;
  const sourceLinks = [...new Set(event?.evidence.flatMap((evidence) =>
    evidence.sourceUrl ? [evidence.sourceUrl] : []) ?? [])];
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={COLOR.accent}
      paddingX={1}
    >
      <Text color={COLOR.accent} bold>
        {title ? cleanText(title.title) : "Missing title metadata"}
        {title?.year ? ` (${title.year})` : ""}
      </Text>
      <Text color={COLOR.alt}>
        Media: {title?.mediaType ?? "unknown"}
        {event
          ? ` · ${event.kind.replace(/_/g, " ")} · ${event.date ?? "date unknown"} · ${event.region}`
          : ` · ${FEED_LABELS[feed]}`}
      </Text>
      {rating ? (
        <>
          <Text color={COLOR.alt}>
            {ratingLabel(rating)}: {formattedScore(rating)}/{rating.system === "aggregate" ? 100 : 10}
            {rating.voteCount !== undefined ? ` · ${rating.voteCount.toLocaleString("en-US")} votes` : ""}
          </Text>
          <Text color={COLOR.alt}>Rating provider: {providerDescription(rating)}</Text>
          <Text color={COLOR.alt}>
            Observed: {formatRatingAge(rating.observedAt)}
          </Text>
        </>
      ) : (
        <Text color={COLOR.alt}>IMDb: Not rated or identity unavailable</Text>
      )}
      {rating?.system === "imdb" ? <Text color={COLOR.dim}>{IMDB_REQUIRED_NOTICE}</Text> : null}
      {event ? (
        <Text color={COLOR.alt}>
          Provider/format: {cleanText(event.providerLabel ?? event.formatLabel ?? "not supplied")}
          {event.accessType ? ` · ${event.accessType}` : ""}
        </Text>
      ) : null}
      <Text color={COLOR.alt}>
        Original language: {title?.originalLanguage
          ? `${languageLabel(title.originalLanguage)} (${title.originalLanguage})`
          : "unknown"}
      </Text>
      <Text color={COLOR.alt}>
        Origin countries: {title?.originCountries.length
          ? title.originCountries.map(cleanText).join(", ")
          : "unknown"}
      </Text>
      <Text color={COLOR.alt}>
        Genres: {title?.genreLabels?.length
          ? title.genreLabels.map(cleanText).join(", ")
          : title?.genreIds.length
            ? title.genreIds.join(", ")
            : "unknown"}
      </Text>
      {event?.audioLanguages?.length ? (
        <Text color={COLOR.alt}>Audio: {event.audioLanguages.map(languageLabel).join(", ")}</Text>
      ) : null}
      {event?.subtitleLanguages?.length ? (
        <Text color={COLOR.alt}>
          Subtitles: {event.subtitleLanguages.map(languageLabel).join(", ")}
        </Text>
      ) : null}
      {event ? (
        <Text color={COLOR.alt}>
          Evidence: {event.evidence.map((evidence) =>
            `${SOURCE_LABELS[evidence.source]} ${evidence.confidence}`).join(" · ")}
        </Text>
      ) : null}
      {sourceLinks.map((link) => (
        <Text key={link} color={COLOR.dim}>
          {truncate(`Source link: ${cleanText(link)}`, Math.max(20, cols - 6))}
        </Text>
      ))}
      {attributions.map((attribution) => (
        <Box key={attribution.source} flexDirection="column">
          <Text color={COLOR.dim}>
            {truncate(
              `Attribution: ${cleanText(attribution.notice ?? attribution.sourceLabel)} · ${cleanText(attribution.sourceUrl)}`,
              Math.max(20, cols - 6),
            )}
          </Text>
          {attribution.additionalNotices?.map((notice) => (
            <Text key={notice} color={COLOR.dim}>{cleanText(notice)}</Text>
          ))}
        </Box>
      ))}
      <Text color={COLOR.dim}>{DISCOVERY_SOURCE_CLAIM_NOTICE}</Text>
      {sourcesDisagree(entry, model) ? (
        <Text color={COLOR.warn}>{ICON.warn} Sources disagree on the event date.</Text>
      ) : null}
      <Text color={COLOR.dim}>enter/esc close</Text>
    </Box>
  );
}

function DiscoveryEmpty({
  model,
  baseCount,
  cols,
}: {
  model: DiscoveryUiModel;
  baseCount: number;
  cols: number;
}) {
  const reason = discoveryEmptyReason(model, baseCount);
  const tmdbMissing = model.sourceStates.some(({ state }) =>
    state.source === "tmdb" &&
    (state.status === "unconfigured" || state.status === "auth-failed"));
  const streamingMissing = model.sourceStates.some(({ state }) =>
    state.source === "streaming-availability" &&
    (state.status === "unconfigured" || state.status === "auth-failed"));
  const apifyMissing = model.sourceStates.some(({ state }) =>
    state.source === "apify" &&
    (state.status === "unconfigured" || state.status === "auth-failed"));
  const tamilmvMissing = model.sourceStates.some(({ state }) =>
    state.source === "tamilmv" &&
    (state.status === "unconfigured" || state.status === "auth-failed"));
  const failures = [...new Set(model.sourceStates.flatMap(({ label, state }) =>
    state.error?.message ? [`${label}: ${state.error.message}`] : []))];
  const message = reason === "filters"
    ? "Filters removed all discovery rows; adjust type, window, provider, language, or format."
    : reason === "offline-no-cache"
      ? "Sources are offline or unavailable and there is no cached discovery data."
      : reason === "quota-no-cache"
        ? "The request quota is paused and there is no cached discovery data."
      : reason === "disabled"
        ? "This discovery feed is disabled in Settings."
      : reason === "unconfigured"
        ? "This discovery feed is unconfigured."
        : reason === "partial-no-events"
          ? "Available sources reported no events; unavailable sources make this result incomplete."
        : "No recent discovery events were reported for this window.";
  return (
    <Box flexDirection="column">
      <Text color={COLOR.dim}>{message}</Text>
      {tmdbMissing ? (
        <Text color={COLOR.dim}>
          TMDB: set TMDB_READ_TOKEN or use Settings → TMDB read token.
        </Text>
      ) : null}
      {streamingMissing ? (
        <Text color={COLOR.dim}>
          Streaming: set STREAMING_AVAILABILITY_API_KEY or use Settings → Streaming Availability key.
        </Text>
      ) : null}
      {apifyMissing ? (
        <Text color={COLOR.dim}>
          Apify: set APIFY_API_TOKEN or use Settings → Apify API token.
        </Text>
      ) : null}
      {tamilmvMissing ? (
        <Text color={COLOR.dim}>
          TamilMV: set FIRECRAWL_API_KEY or use Settings → Firecrawl API key.
        </Text>
      ) : null}
      {failures.map((failure) => (
        <Text key={failure} color={COLOR.warn}>
          {truncate(failure, Math.max(20, cols - 2))}
        </Text>
      ))}
      {tmdbMissing || streamingMissing || apifyMissing || tamilmvMissing ? (
        <Text color={COLOR.dim}>Blu-ray remains available without credentials.</Text>
      ) : null}
    </Box>
  );
}

export function DiscoveryContent({
  model,
  screen,
  dispatch,
  active,
  cols,
  listRows,
  onSearch,
}: DiscoveryContentProps) {
  const date = discoveryDateSelection(screen.dateWindow);
  const filters: DiscoveryFeedFilters = {
    ...(screen.media === "all" ? {} : { mediaTypes: [screen.media] }),
    ...(screen.feed === "trending" || screen.feed === "popular" || screen.feed === "charts" || screen.feed === "community" || screen.feed === "tamilmv" ? {} : { date }),
    ...(screen.providerId && (screen.feed === "ott" || screen.feed === "popular" || screen.feed === "charts")
      ? { providerIds: [screen.providerId] }
      : {}),
    ...(screen.languageCode ? { languageCodes: [screen.languageCode] } : {}),
    ...(screen.formatLabel ? { formatLabels: [screen.formatLabel] } : {}),
  };
  const entries = useMemo(() => {
    const selected = selectDiscoveryEntries(
      model.aggregation.feeds[screen.feed],
      filters,
      { direction: date.direction },
    );
    return screen.feed === "bluray" ? dedupeBlurayEntries(selected) : selected;
  },
    [date.direction, filters, model.aggregation.feeds, screen.feed],
  );
  const baseEntries = model.aggregation.feeds[screen.feed];
  const providerChoices = [
    { id: undefined, label: "All providers" },
    ...model.providers.map((provider) => ({ id: provider.id, label: cleanText(provider.label) })),
  ];
  const providerLabel = providerChoices.find((provider) => provider.id === screen.providerId)
    ?.label ?? screen.providerId ?? "All providers";
  const languageChoice = DISCOVERY_LANGUAGE_FILTERS.find(
    (choice) => choice.code === screen.languageCode,
  ) ?? DISCOVERY_LANGUAGE_FILTERS[0]!;
  useEffect(() => {
    dispatch({ type: "clamp-cursor", rowCount: entries.length });
  }, [dispatch, entries.length]);

  useEffect(() => {
    if (!active) return;
    logEvent("info", "discover.screen.state", {
      feed: screen.feed,
      dateWindow: screen.dateWindow,
      media: screen.media,
      providerId: screen.providerId,
      languageCode: screen.languageCode,
      detailsOpen: screen.detailsOpen,
      cursor: screen.cursor,
      resultCount: entries.length,
      loading: model.loading,
      completedSources: model.done,
      totalSources: model.total,
    });
  }, [
    active,
    entries.length,
    model.done,
    model.loading,
    model.total,
    screen.cursor,
    screen.dateWindow,
    screen.detailsOpen,
    screen.feed,
    screen.languageCode,
    screen.media,
    screen.providerId,
  ]);

  useInput((input, key) => {
    const action = key.leftArrow ? "feed.previous"
      : key.rightArrow ? "feed.next"
      : key.downArrow || input === "j" ? "cursor.next"
      : key.upArrow || input === "k" ? "cursor.previous"
      : key.return ? (screen.detailsOpen ? "details.close" : "details.open")
      : key.escape ? "details.close"
      : input === "s" ? "search.handoff"
      : input === "m" ? "media.next"
      : input === "p" ? "provider.next"
      : input === "l" ? "language.next"
      : input === "t" ? "window.next"
      : input === "r" ? "refresh"
      : /^[1-9]$/.test(input) ? "feed.select"
      : input === "g" || input === "G" ? "cursor.jump"
      : undefined;
    if (action) {
      logEvent("debug", "discover.input.action", {
        action,
        feed: screen.feed,
        cursor: screen.cursor,
        resultCount: entries.length,
      });
    }
    if (input === "s") {
      const query = entries[screen.cursor] ? discoverySearchQuery(entries[screen.cursor]!) : undefined;
      if (query) onSearch?.(query);
      return;
    }
    if (screen.detailsOpen) {
      if (key.escape || key.return) dispatch({ type: "close-details" });
      return;
    }
    if (key.leftArrow) {
      dispatch({ type: "set-feed", feed: cycle(DISCOVERY_FEEDS, screen.feed, -1) });
      return;
    }
    if (key.rightArrow) {
      dispatch({ type: "set-feed", feed: cycle(DISCOVERY_FEEDS, screen.feed, 1) });
      return;
    }
    if (/^[1-9]$/.test(input) && Number(input) <= DISCOVERY_FEEDS.length) {
      dispatch({ type: "set-feed", feed: DISCOVERY_FEEDS[Number(input) - 1]! });
      return;
    }
    if (input === "m") {
      dispatch({ type: "set-media", media: cycle(DISCOVERY_MEDIA_FILTERS, screen.media, 1) });
      return;
    }
    if (input === "p" && (screen.feed === "ott" || screen.feed === "popular" || screen.feed === "charts")) {
      const current = Math.max(
        0,
        providerChoices.findIndex((provider) => provider.id === screen.providerId),
      );
      const selected = providerChoices[(current + 1) % providerChoices.length]!;
      dispatch({ type: "set-provider", providerId: selected.id });
      return;
    }
    if (input === "l") {
      const current = Math.max(
        0,
        DISCOVERY_LANGUAGE_FILTERS.findIndex((choice) =>
          choice.code === screen.languageCode),
      );
      const selected = DISCOVERY_LANGUAGE_FILTERS[
        (current + 1) % DISCOVERY_LANGUAGE_FILTERS.length
      ]!;
      dispatch({ type: "set-language", languageCode: selected.code });
      return;
    }
    if (input === "t") {
      if (
        screen.feed === "trending" ||
        screen.feed === "popular" ||
        screen.feed === "charts" ||
        screen.feed === "community" ||
        screen.feed === "tamilmv"
      ) return;
      dispatch({
        type: "set-date-window",
        dateWindow: cycle(DISCOVERY_DATE_WINDOWS, screen.dateWindow, 1),
      });
      return;
    }
    if (input === "r") {
      model.refresh();
      return;
    }
    if (key.return && entries.length > 0) {
      dispatch({ type: "open-details" });
      return;
    }
    if (key.downArrow || input === "j") {
      dispatch({ type: "move-cursor", delta: 1, rowCount: entries.length });
    } else if (key.upArrow || input === "k") {
      dispatch({ type: "move-cursor", delta: -1, rowCount: entries.length });
    } else if (input === "g") {
      dispatch({ type: "set-cursor", cursor: 0, rowCount: entries.length });
    } else if (input === "G") {
      dispatch({ type: "set-cursor", cursor: entries.length - 1, rowCount: entries.length });
    }
  }, { isActive: active });

  const charts = screen.feed === "charts";
  const wide = cols >= 100;
  const medium = cols >= 80 && cols < 100;
  const compact = cols >= 70 && cols < 80;
  const ratingWidth = charts ? 10 : wide ? 18 : medium ? 17 : 12;
  const votesWidth = charts ? (cols >= 80 ? 10 : 9) : 0;
  const typeWidth = charts ? 7 : 0;
  const eventWidth = cols >= 70 ? 13 : 0;
  const languageWidth = cols >= 80 ? (wide ? 14 : 13) : 0;
  const sourceWidth = wide && !charts ? 11 : 0;
  // Ink measures the pointer glyph as two cells on some terminals; reserve one
  // extra cell so the last column never wraps.
  const fixedWidth = 3 + 12 + ratingWidth + votesWidth + typeWidth + eventWidth + languageWidth + sourceWidth;
  const titleWidth = Math.max(1, cols - fixedWidth);
  const lastRefreshed = Math.max(
    0,
    ...model.sourceStates.flatMap(({ state }) => state.snapshot ? [state.snapshot.fetchedAt] : []),
  );
  const partial = model.sourceStates.some(({ state }) =>
    state.status === "stale" ||
    state.status === "disabled" ||
    state.status === "unconfigured" ||
    state.status === "auth-failed" ||
    state.status === "quota-paused" ||
    state.status === "failed");
  const chromeRows = 5 +
    (model.sourceStates.length > 0 ? 1 : 0) +
    (cols < 80 ? 1 : 0) +
    (charts ? 1 : 0) +
    (partial ? 1 : 0);
  const capacity = Math.max(1, listRows - chromeRows);
  const start = Math.max(
    0,
    Math.min(
      screen.cursor - Math.floor(capacity / 2),
      Math.max(0, entries.length - capacity),
    ),
  );
  const visible = entries.slice(start, start + capacity);
  const selectedEntry = entries[screen.cursor];

  return (
    <Box flexDirection="column" flexGrow={1} width={cols}>
      <Box justifyContent="space-between">
        {model.loading ? (
          <Spinner label={`loading discovery ${model.done}/${model.total}`} />
        ) : (
          <Text color={COLOR.alt}>
            {entries.length === 0 && partial
              ? "Results unavailable or incomplete"
              : `${entries.length} result${entries.length === 1 ? "" : "s"}`}
            {lastRefreshed > 0
              ? ` · refreshed ${formatRelative(lastRefreshed / 1_000) || "now"}`
              : ""}
          </Text>
        )}
        <Text color={COLOR.dim}>←→ feed · m type · t window · r refresh</Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Box>
          {DISCOVERY_FEEDS.map((feed) => {
            const selected = feed === screen.feed;
            return (
              <Box key={feed} marginRight={1}>
                <Text color={selected ? COLOR.accent : COLOR.dim} bold={selected}>
                  {selected ? `[${FEED_LABELS[feed]}]` : ` ${FEED_LABELS[feed]} `}
                </Text>
              </Box>
            );
          })}
        </Box>
        <Text color={COLOR.dim}>
          {MEDIA_LABELS[screen.media]}
           {screen.feed === "trending" || screen.feed === "popular" || screen.feed === "charts" || screen.feed === "community" || screen.feed === "tamilmv" ? "" : ` · ${DISCOVERY_DATE_WINDOW_LABELS[screen.dateWindow]}`}
           {screen.feed === "ott" || screen.feed === "popular" || screen.feed === "charts" ? ` · ${providerLabel}` : ""}
          {screen.languageCode ? ` · ${languageChoice.label}` : ""}
        </Text>
      </Box>

      {model.sourceStates.length > 0 ? (
        <Text color={partial ? COLOR.warn : COLOR.dim}>
          {truncate(sourceStatusText(model), Math.max(20, cols - (partial ? 12 : 2)))}
          {partial ? " · partial" : ""}
        </Text>
      ) : null}
      {compact ? <Text color={COLOR.dim}>rating/votes: IMDb or TMDB · aggregate shown as Score</Text> : null}
      {cols < 70 ? <Text color={COLOR.dim}>rating/votes · IMDb/TMDB · Score=aggregate</Text> : null}

      {screen.detailsOpen && selectedEntry ? (
        <Box marginTop={1} flexGrow={1}>
          <DiscoveryDetails entry={selectedEntry} model={model} cols={cols} feed={screen.feed} />
        </Box>
      ) : (
      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        {charts ? (
          <Box width={cols}>
            <Box width={3}><Text color={COLOR.dim}>{" ".repeat(3)}</Text></Box>
            <Box width={12}><Text color={COLOR.dim}>{"Rank".padEnd(12)}</Text></Box>
            <Box width={titleWidth}><Text color={COLOR.dim}>{truncate("Title", titleWidth).padEnd(titleWidth)}</Text></Box>
            <Box width={ratingWidth}><Text color={COLOR.dim}>{"IMDb".padEnd(ratingWidth)}</Text></Box>
            <Box width={votesWidth}><Text color={COLOR.dim}>{"Votes".padEnd(votesWidth)}</Text></Box>
            <Box width={typeWidth}><Text color={COLOR.dim}>{"Type".padEnd(typeWidth)}</Text></Box>
            {eventWidth > 0 ? (
              <Box width={eventWidth}><Text color={COLOR.dim}>{"Platform".padEnd(eventWidth)}</Text></Box>
            ) : null}
            {languageWidth > 0 ? (
              <Box width={languageWidth}><Text color={COLOR.dim}>{"Language".padEnd(languageWidth)}</Text></Box>
            ) : null}
          </Box>
        ) : null}
        {visible.map((entry, index) => {
          const absoluteIndex = start + index;
          const selected = absoluteIndex === screen.cursor;
          const title = entry.title;
          const displayTitle = title
            ? `${cleanText(title.title)}${title.year ? ` (${title.year})` : ""}`
            : "Missing title metadata";
          const titleRatings = title ? model.ratings.get(title.id) ?? title.ratings ?? [] : [];
          const rating = selectPreferredRating(
            charts ? titleRatings.filter((item) => item.system === "imdb") : titleRatings,
          );
          const ratingText = rating
            ? charts
              ? formattedScore(rating)
              : cols < 80
                ? formatCompactRating(rating)
                : formatDiscoveryRating(rating).replace(" · ", medium ? " " : " · ")
            : model.ratingsLoading ? (charts ? "…" : "IMDb …") : "NR";
          const votesText = rating?.voteCount !== undefined
            ? formatVoteCount(rating.voteCount)
            : model.ratingsLoading ? "…" : "—";
            return (
              <Box
                key={entry.event?.id ?? title?.id ?? absoluteIndex}
                width={cols}
              >
                <Text
                  color={selected ? COLOR.accent : COLOR.dim}
                  backgroundColor={selected ? COLOR.selected : undefined}
                >
                  {selected ? ICON.pointer : " "}{" "}
                </Text>
                <Box width={12}>
                  <Text
                    color={selected ? COLOR.text : entry.event?.date ? COLOR.alt : COLOR.dim}
                    backgroundColor={selected ? COLOR.selected : undefined}
                  >
                    {(screen.feed === "charts" || screen.feed === "community"
                      ? `#${absoluteIndex + 1}`
                      : entry.event?.date ?? "—").padEnd(12)}
                  </Text>
                </Box>
                <Box width={titleWidth}>
                  <Text
                    color={selected ? COLOR.text : COLOR.alt}
                    backgroundColor={selected ? COLOR.selected : undefined}
                    wrap="truncate-end"
                  >
                    {truncate(displayTitle, titleWidth).padEnd(titleWidth)}
                  </Text>
                </Box>
                <Box width={ratingWidth}>
                  <Text
                    color={selected ? COLOR.text : rating ? COLOR.alt : COLOR.dim}
                    backgroundColor={selected ? COLOR.selected : undefined}
                  >
                    {truncate(ratingText, ratingWidth - 1).padEnd(ratingWidth)}
                  </Text>
                </Box>
                {votesWidth > 0 ? (
                  <Box width={votesWidth}>
                    <Text
                      color={selected ? COLOR.text : rating?.voteCount !== undefined ? COLOR.alt : COLOR.dim}
                      backgroundColor={selected ? COLOR.selected : undefined}
                    >
                      {truncate(votesText, votesWidth - 1).padEnd(votesWidth)}
                    </Text>
                  </Box>
                ) : null}
                {typeWidth > 0 ? (
                  <Box width={typeWidth}>
                    <Text
                      color={selected ? COLOR.text : COLOR.dim}
                      backgroundColor={selected ? COLOR.selected : undefined}
                    >
                      {(title ? MEDIA_TYPE_LABELS[title.mediaType] : "—").padEnd(typeWidth)}
                    </Text>
                  </Box>
                ) : null}
                {eventWidth > 0 ? (
                  <Box width={eventWidth}>
                    <Text
                      color={selected ? COLOR.text : COLOR.dim}
                      backgroundColor={selected ? COLOR.selected : undefined}
                    >
                      {truncate(eventLabel(entry, screen.feed), eventWidth - 1).padEnd(eventWidth)}
                    </Text>
                  </Box>
                ) : null}
                {languageWidth > 0 ? (
                  <>
                    <Box width={languageWidth}>
                      <Text
                        color={selected ? COLOR.text : COLOR.dim}
                        backgroundColor={selected ? COLOR.selected : undefined}
                      >
                        {truncate(discoveryLanguageSummary(entry), languageWidth - 1).padEnd(languageWidth)}
                      </Text>
                    </Box>
                    {sourceWidth > 0 ? (
                      <Box width={sourceWidth}>
                        <Text
                          color={selected ? COLOR.text : COLOR.dim}
                          backgroundColor={selected ? COLOR.selected : undefined}
                        >
                          {truncate(sourceNames(entry, screen.feed), sourceWidth - 1).padEnd(sourceWidth)}
                        </Text>
                      </Box>
                    ) : null}
                </>
              ) : null}
            </Box>
          );
        })}
        {!model.loading && entries.length === 0 ? (
          <DiscoveryEmpty model={model} baseCount={baseEntries.length} cols={cols} />
        ) : null}
      </Box>
      )}

      {partial ? (
        <Text color={COLOR.warn}>{ICON.warn} Partial results; unavailable sources kept independent.</Text>
      ) : null}
    </Box>
  );
}

export function Discover({ active, visible = true }: { active: boolean; visible?: boolean }) {
  const { config, cols, listRows, submitQuery } = useStore();
  const [screen, dispatch] = useDiscoveryScreenState();
  const model = useDiscovery(config, screen.feed, screen.dateWindow, active);
  const contentCols = Math.max(1, cols - 2);
  if (!visible) return null;
  return (
    <DiscoveryContent
      model={model}
      screen={screen}
      dispatch={dispatch}
      active={active}
      cols={contentCols}
      listRows={listRows}
      onSearch={submitQuery}
    />
  );
}
