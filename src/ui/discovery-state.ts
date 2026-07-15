import { useReducer } from "react";

export const DISCOVERY_FEEDS = [
  "trending",
  "ott",
  "bluray",
  "popular",
  "charts",
  "community",
  "tamilmv",
] as const;
export type DiscoveryFeed = typeof DISCOVERY_FEEDS[number];

export const DISCOVERY_MEDIA_FILTERS = ["all", "movie", "series"] as const;
export type DiscoveryMediaFilter = typeof DISCOVERY_MEDIA_FILTERS[number];

export const DISCOVERY_DATE_WINDOWS = [
  "7d",
  "30d",
  "upcoming-7d",
  "upcoming-30d",
  "all",
] as const;
export type DiscoveryDateWindow = typeof DISCOVERY_DATE_WINDOWS[number];

export const DISCOVERY_DATE_WINDOW_LABELS: Record<DiscoveryDateWindow, string> = {
  "7d": "Recent 7d",
  "30d": "Recent 30d",
  "upcoming-7d": "Upcoming 7d",
  "upcoming-30d": "Upcoming 30d",
  all: "All cached",
};

export interface DiscoveryLanguageChoice {
  code?: string;
  label: string;
}

export const DISCOVERY_LANGUAGE_FILTERS: readonly DiscoveryLanguageChoice[] = [
  { label: "All languages" },
  { code: "hi", label: "Hindi" },
  { code: "kn", label: "Kannada" },
  { code: "ta", label: "Tamil" },
  { code: "te", label: "Telugu" },
  { code: "ml", label: "Malayalam" },
  { code: "bn", label: "Bengali" },
  { code: "mr", label: "Marathi" },
  { code: "pa", label: "Punjabi" },
  { code: "gu", label: "Gujarati" },
  { code: "en", label: "English" },
  { code: "other", label: "Other" },
];

export const DISCOVERY_SORT_MODES = [
  "default",
  "date_added",
  "release_date",
  "imdb_rating",
  "imdb_votes",
  "title",
] as const;
export type DiscoverySortMode = typeof DISCOVERY_SORT_MODES[number];

export const DISCOVERY_YEAR_FILTERS = [
  "all",
  "2020s",
  "2010s",
  "2000s",
  "1990s",
  "1980s",
  "pre-1980",
  "2026",
  "2025",
  "2024",
  "2023",
  "2022",
  "2021",
] as const;
export type DiscoveryYearFilter = typeof DISCOVERY_YEAR_FILTERS[number];

export const DISCOVERY_MIN_IMDB_RATINGS = [undefined, 6, 7, 7.5, 8] as const;
export type DiscoveryMinImdbRating = typeof DISCOVERY_MIN_IMDB_RATINGS[number];

export const DISCOVERY_MIN_IMDB_VOTES = [
  undefined,
  1000,
  5000,
  10000,
  50000,
] as const;
export type DiscoveryMinImdbVotes = typeof DISCOVERY_MIN_IMDB_VOTES[number];

export const DISCOVERY_SORT_LABELS: Record<DiscoverySortMode, string> = {
  default: "default",
  date_added: "date added",
  release_date: "release date",
  imdb_rating: "IMDb rating",
  imdb_votes: "IMDb votes",
  title: "title",
};

export const DISCOVERY_YEAR_FILTER_LABELS: Record<DiscoveryYearFilter, string> = {
  all: "All years",
  "2020s": "2020s",
  "2010s": "2010s",
  "2000s": "2000s",
  "1990s": "1990s",
  "1980s": "1980s",
  "pre-1980": "pre-1980",
  "2026": "2026",
  "2025": "2025",
  "2024": "2024",
  "2023": "2023",
  "2022": "2022",
  "2021": "2021",
};

export interface DiscoveryScreenState {
  feed: DiscoveryFeed;
  media: DiscoveryMediaFilter;
  dateWindow: DiscoveryDateWindow;
  sort: DiscoverySortMode;
  yearFilter: DiscoveryYearFilter;
  minImdbRating?: number;
  minImdbVotes?: number;
  providerId?: string;
  languageCode?: string;
  formatLabel?: string;
  cursor: number;
  detailsOpen: boolean;
}

export type DiscoveryScreenAction =
  | { type: "set-feed"; feed: DiscoveryFeed }
  | { type: "set-media"; media: DiscoveryMediaFilter }
  | { type: "set-date-window"; dateWindow: DiscoveryDateWindow }
  | { type: "set-sort"; sort: DiscoverySortMode }
  | { type: "set-year-filter"; yearFilter: DiscoveryYearFilter }
  | { type: "set-min-imdb-rating"; minImdbRating?: number }
  | { type: "set-min-imdb-votes"; minImdbVotes?: number }
  | { type: "set-provider"; providerId?: string }
  | { type: "set-language"; languageCode?: string }
  | { type: "set-format"; formatLabel?: string }
  | { type: "move-cursor"; delta: number; rowCount: number }
  | { type: "set-cursor"; cursor: number; rowCount: number }
  | { type: "clamp-cursor"; rowCount: number }
  | { type: "open-details" }
  | { type: "close-details" }
  | { type: "reset-filters" };

export const INITIAL_DISCOVERY_SCREEN_STATE: DiscoveryScreenState = {
  feed: "trending",
  media: "all",
  dateWindow: "30d",
  sort: "default",
  yearFilter: "all",
  cursor: 0,
  detailsOpen: false,
};

export function cycleChoice<T>(values: readonly T[], current: T, delta = 1): T {
  const index = values.indexOf(current);
  const start = index < 0 ? 0 : index;
  return values[(start + delta + values.length) % values.length]!;
}

function clampCursor(cursor: number, rowCount: number): number {
  if (!Number.isFinite(cursor) || rowCount <= 0) return 0;
  return Math.max(0, Math.min(Math.floor(cursor), rowCount - 1));
}

function resetSelection(
  state: DiscoveryScreenState,
  change: Partial<DiscoveryScreenState>,
): DiscoveryScreenState {
  return { ...state, ...change, cursor: 0, detailsOpen: false };
}

export function discoveryScreenReducer(
  state: DiscoveryScreenState,
  action: DiscoveryScreenAction,
): DiscoveryScreenState {
  switch (action.type) {
    case "set-feed":
      // TamilMV listings often lack calendar dates; default to all cached rows.
      return resetSelection(state, {
        feed: action.feed,
        ...(action.feed === "tamilmv" ? { dateWindow: "all" as const } : {}),
      });
    case "set-media":
      return resetSelection(state, { media: action.media });
    case "set-date-window":
      return resetSelection(state, { dateWindow: action.dateWindow });
    case "set-sort":
      return resetSelection(state, { sort: action.sort });
    case "set-year-filter":
      return resetSelection(state, { yearFilter: action.yearFilter });
    case "set-min-imdb-rating":
      return resetSelection(state, {
        ...(action.minImdbRating !== undefined
          ? { minImdbRating: action.minImdbRating }
          : { minImdbRating: undefined }),
      });
    case "set-min-imdb-votes":
      return resetSelection(state, {
        ...(action.minImdbVotes !== undefined
          ? { minImdbVotes: action.minImdbVotes }
          : { minImdbVotes: undefined }),
      });
    case "set-provider":
      return resetSelection(state, {
        ...(action.providerId ? { providerId: action.providerId } : { providerId: undefined }),
      });
    case "set-language":
      return resetSelection(state, {
        ...(action.languageCode
          ? { languageCode: action.languageCode }
          : { languageCode: undefined }),
      });
    case "set-format":
      return resetSelection(state, {
        ...(action.formatLabel
          ? { formatLabel: action.formatLabel }
          : { formatLabel: undefined }),
      });
    case "move-cursor":
      return {
        ...state,
        cursor: clampCursor(state.cursor + action.delta, action.rowCount),
      };
    case "set-cursor":
      return { ...state, cursor: clampCursor(action.cursor, action.rowCount) };
    case "clamp-cursor":
      return { ...state, cursor: clampCursor(state.cursor, action.rowCount) };
    case "open-details":
      return { ...state, detailsOpen: true };
    case "close-details":
      return { ...state, detailsOpen: false };
    case "reset-filters":
      return {
        ...INITIAL_DISCOVERY_SCREEN_STATE,
        feed: state.feed,
      };
  }
}

export function useDiscoveryScreenState() {
  return useReducer(discoveryScreenReducer, INITIAL_DISCOVERY_SCREEN_STATE);
}
