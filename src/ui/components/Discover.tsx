import { useEffect, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import {
  selectDiscoveryEntries,
  type DiscoveryFeedEntry,
  type DiscoveryFeedFilters,
} from "../../discovery/aggregate";
import { DISCOVERY_SOURCE_CLAIM_NOTICE } from "../../discovery/attribution";
import { languageLabel, normalizeLanguage } from "../../discovery/normalize";
import { buildDiscoverySearchQuery } from "../../discovery/search-handoff";
import type { DiscoverySource } from "../../discovery/types";
import { cleanText, formatRelative, truncate } from "../../util/format";
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
  ott: "OTT",
  bluray: "Blu-ray",
  india: "India",
} as const;

const MEDIA_LABELS = { all: "All", movie: "Movies", series: "Series" } as const;

const SOURCE_LABELS: Record<DiscoverySource, string> = {
  tmdb: "TMDB",
  bluray: "Blu-ray.com",
  trakt: "Trakt",
  "streaming-availability": "Streaming Availability",
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

function sourceNames(entry: DiscoveryFeedEntry): string {
  if (!entry.event) return "TMDB";
  return [...new Set(entry.event.evidence.map((evidence) => SOURCE_LABELS[evidence.source]))]
    .join("+");
}

function eventLabel(entry: DiscoveryFeedEntry): string {
  if (!entry.event) return "Trending";
  return cleanText(entry.event.providerLabel ??
    entry.event.formatLabel ??
    entry.event.kind.replace(/_/g, " "));
}

function sourceStatusText(model: DiscoveryUiModel): string {
  return model.sourceStates.map(({ label, state }) => `${label}: ${state.status}`).join(" · ");
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
}: {
  entry: DiscoveryFeedEntry;
  model: DiscoveryUiModel;
  cols: number;
}) {
  const { title, event } = entry;
  const attributions = model.attributions;
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
        {event ? ` · ${event.kind.replace(/_/g, " ")} · ${event.date ?? "date unknown"} · ${event.region}` : " · Trending"}
      </Text>
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
}: {
  model: DiscoveryUiModel;
  baseCount: number;
}) {
  const reason = discoveryEmptyReason(model, baseCount);
  const tmdbMissing = model.sourceStates.some(({ state }) =>
    state.source === "tmdb" &&
    (state.status === "unconfigured" || state.status === "auth-failed"));
  const streamingMissing = model.sourceStates.some(({ state }) =>
    state.source === "streaming-availability" &&
    (state.status === "unconfigured" || state.status === "auth-failed"));
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
      {tmdbMissing || streamingMissing ? (
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
    ...(screen.feed === "trending" ? {} : { date }),
    ...(screen.providerId && (screen.feed === "ott" || screen.feed === "india")
      ? { providerIds: [screen.providerId] }
      : {}),
    ...(screen.languageCode ? { languageCodes: [screen.languageCode] } : {}),
    ...(screen.formatLabel ? { formatLabels: [screen.formatLabel] } : {}),
    ...(screen.indianTitlesOnly ? { indianTitlesOnly: true } : {}),
  };
  const entries = useMemo(
    () => selectDiscoveryEntries(
      model.aggregation.feeds[screen.feed],
      filters,
      { direction: date.direction },
    ),
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

  useInput((input, key) => {
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
    if (/^[1-4]$/.test(input)) {
      dispatch({ type: "set-feed", feed: DISCOVERY_FEEDS[Number(input) - 1]! });
      return;
    }
    if (input === "m") {
      dispatch({ type: "set-media", media: cycle(DISCOVERY_MEDIA_FILTERS, screen.media, 1) });
      return;
    }
    if (input === "p" && (screen.feed === "ott" || screen.feed === "india")) {
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
    if (input === "i" && screen.feed === "india") {
      dispatch({ type: "toggle-indian-titles" });
      return;
    }
    if (input === "t") {
      if (screen.feed === "trending") return;
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

  const capacity = Math.max(3, listRows - 4);
  const start = Math.max(
    0,
    Math.min(
      screen.cursor - Math.floor(capacity / 2),
      Math.max(0, entries.length - capacity),
    ),
  );
  const visible = entries.slice(start, start + capacity);
  const selectedEntry = entries[screen.cursor];
  const narrow = cols < 90;
  const titleWidth = Math.max(18, cols - (narrow ? 31 : 70));
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

  return (
    <Box flexDirection="column" flexGrow={1}>
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

      <Box marginTop={1}>
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
        <Text color={COLOR.dim}>
          {MEDIA_LABELS[screen.media]}
          {screen.feed === "trending" ? "" : ` · ${DISCOVERY_DATE_WINDOW_LABELS[screen.dateWindow]}`}
          {screen.feed === "ott" || screen.feed === "india" ? ` · ${providerLabel}` : ""}
          {screen.languageCode ? ` · ${languageChoice.label}` : ""}
          {screen.feed === "india"
            ? ` · ${screen.indianTitlesOnly ? "Indian titles only" : "Available in India"}`
            : ""}
        </Text>
      </Box>

      {model.sourceStates.length > 0 ? (
        <Text color={partial ? COLOR.warn : COLOR.dim}>
          {truncate(sourceStatusText(model), Math.max(20, cols - (partial ? 12 : 2)))}
          {partial ? " · partial" : ""}
        </Text>
      ) : null}

      {screen.detailsOpen && selectedEntry ? (
        <Box marginTop={1} flexGrow={1}>
          <DiscoveryDetails entry={selectedEntry} model={model} cols={cols} />
        </Box>
      ) : (
      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        {visible.map((entry, index) => {
          const absoluteIndex = start + index;
          const selected = absoluteIndex === screen.cursor;
          const title = entry.title;
          const displayTitle = title
            ? `${cleanText(title.title)}${title.year ? ` (${title.year})` : ""}`
            : "Missing title metadata";
          return (
            <Box key={entry.event?.id ?? title?.id ?? absoluteIndex}>
              <Text color={selected ? COLOR.accent : COLOR.dim}>
                {selected ? ICON.pointer : " "}{" "}
              </Text>
              <Box width={12}>
                <Text color={entry.event?.date ? COLOR.alt : COLOR.dim}>
                  {entry.event?.date ?? "—"}
                </Text>
              </Box>
              <Box width={titleWidth}>
                <Text color={selected ? COLOR.text : COLOR.alt} wrap="truncate-end">
                  {truncate(displayTitle, titleWidth)}
                </Text>
              </Box>
              <Box width={narrow ? 15 : 18}>
                <Text color={COLOR.dim}>{truncate(eventLabel(entry), narrow ? 14 : 17)}</Text>
              </Box>
              {!narrow ? (
                <>
                  <Box width={20}>
                    <Text color={COLOR.dim}>
                      {truncate(discoveryLanguageSummary(entry), 19)}
                    </Text>
                  </Box>
                  <Box width={16}>
                    <Text color={COLOR.dim}>{truncate(sourceNames(entry), 15)}</Text>
                  </Box>
                </>
              ) : null}
            </Box>
          );
        })}
        {!model.loading && entries.length === 0 ? (
          <DiscoveryEmpty model={model} baseCount={baseEntries.length} />
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
  if (!visible) return null;
  return (
    <DiscoveryContent
      model={model}
      screen={screen}
      dispatch={dispatch}
      active={active}
      cols={cols}
      listRows={listRows}
      onSearch={submitQuery}
    />
  );
}
