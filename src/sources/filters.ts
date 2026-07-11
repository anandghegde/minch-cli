import type { TorrentResult } from "./types";
import type { RelevanceConfig } from "../config/config";
import { classifyCategory, type CategoryFilter } from "./categories";

/**
 * Client-side result filtering. These filters run in the UI layer over the
 * already-deduped/sorted result set — they never push down into the per-source
 * `search()` calls. Keep everything here pure and unit-testable.
 *
 * Deliberately small: cycle-able dimensions (date, size, seeders, match mode)
 * that mirror the sort UX. Each has a fixed cycle of presets and a compact label.
 * `hideTrash` is session state seeded from config (not a dedicated key).
 *
 * (Distinct from src/cardigann/filters.ts, which transforms scraped field
 * strings during source execution.)
 */

const MB = 1000 * 1000;
const GB = 1000 * 1000 * 1000;
const DAY = 24 * 60 * 60;

/** Publish-date window presets. `seconds: null` means "all time" (no bound). */
export interface TimePreset {
  label: string;
  seconds: number | null;
}

export const TIME_PRESETS: TimePreset[] = [
  { label: "any", seconds: null },
  { label: "24h", seconds: DAY },
  { label: "week", seconds: 7 * DAY },
  { label: "month", seconds: 30 * DAY },
  { label: "3mo", seconds: 90 * DAY },
  { label: "year", seconds: 365 * DAY },
];

/** Size bucket presets, in bytes. `null` bound = unbounded on that side. */
export interface SizePreset {
  label: string;
  min: number | null;
  max: number | null;
}

export const SIZE_PRESETS: SizePreset[] = [
  { label: "any", min: null, max: null },
  { label: "<100MB", min: null, max: 100 * MB },
  { label: "100MB-1GB", min: 100 * MB, max: 1 * GB },
  { label: "1-5GB", min: 1 * GB, max: 5 * GB },
  { label: "5-20GB", min: 5 * GB, max: 20 * GB },
  { label: ">20GB", min: 20 * GB, max: null },
];

/** Minimum-seeders presets. */
export interface SeederPreset {
  label: string;
  min: number;
}

export const SEEDER_PRESETS: SeederPreset[] = [
  { label: "any", min: 0 },
  { label: ">0", min: 1 },
  { label: ">=5", min: 5 },
  { label: ">=50", min: 50 },
];

/**
 * Text-match strictness. Soft keeps partial/none rows sunk; strict hides tier < 2
 * (Jackett andmatch-style). Applied in the ranker, not `applyFilters`.
 */
export interface MatchPreset {
  label: string;
  /** When true, only full-AND (tier ≥ 2) rows remain. */
  strict: boolean;
}

export const MATCH_PRESETS: MatchPreset[] = [
  { label: "soft", strict: false },
  { label: "strict", strict: true },
];

export interface CategoryPreset {
  value: CategoryFilter;
  label: string;
}

export const CATEGORY_PRESETS: CategoryPreset[] = [
  { value: "all", label: "All" },
  { value: "movies", label: "Movies" },
  { value: "tv", label: "TV" },
  { value: "anime", label: "Anime" },
  { value: "games", label: "Games" },
  { value: "music", label: "Music" },
  { value: "xxx", label: "XXX" },
  { value: "other", label: "Other" },
];

export interface FilterState {
  /** Index into TIME_PRESETS. */
  time: number;
  /** Index into SIZE_PRESETS. */
  size: number;
  /** Index into SEEDER_PRESETS. */
  seeders: number;
  /** Normalized coarse torrent category, or `all`. */
  category: CategoryFilter;
  /** Index into MATCH_PRESETS (soft / strict AND). */
  match: number;
  /**
   * When true, hide trash releases (CAM/TS/SAMPLE/…). Seeded from
   * `config.relevance.hideTrash`; not a dedicated cycle key.
   */
  hideTrash: boolean;
}

export const emptyFilters: FilterState = {
  time: 0,
  size: 0,
  seeders: 0,
  category: "all",
  match: 0,
  hideTrash: false,
};

/**
 * Build session filter defaults from `config.relevance`. Used on boot and when
 * the user hits `r` so config-backed flags survive a soft reset.
 */
export function filtersFromConfig(relevance?: RelevanceConfig): FilterState {
  return {
    ...emptyFilters,
    match: relevance?.strictAnd === true ? 1 : 0,
    hideTrash: relevance?.hideTrash === true,
  };
}

/** True when the filter set would let everything through unchanged. */
export function isEmptyFilters(f: FilterState): boolean {
  return (
    f.time === 0 &&
    f.size === 0 &&
    f.seeders === 0 &&
    f.category === "all" &&
    f.match === 0 &&
    !f.hideTrash
  );
}

/** Count active (non-default) filter dimensions, for UI badges. */
export function activeFilterCount(f: FilterState): number {
  return (
    (f.time > 0 ? 1 : 0) +
    (f.size > 0 ? 1 : 0) +
    (f.seeders > 0 ? 1 : 0) +
    (f.category !== "all" ? 1 : 0) +
    (f.match > 0 ? 1 : 0) +
    (f.hideTrash ? 1 : 0)
  );
}

/** Advance one dimension to its next preset, wrapping around. */
export function cycleTime(f: FilterState): FilterState {
  return { ...f, time: (f.time + 1) % TIME_PRESETS.length };
}
export function cycleSize(f: FilterState): FilterState {
  return { ...f, size: (f.size + 1) % SIZE_PRESETS.length };
}
export function cycleSeeders(f: FilterState): FilterState {
  return { ...f, seeders: (f.seeders + 1) % SEEDER_PRESETS.length };
}
export function cycleCategory(f: FilterState): FilterState {
  const current = CATEGORY_PRESETS.findIndex((preset) => preset.value === f.category);
  return {
    ...f,
    category: CATEGORY_PRESETS[(current + 1) % CATEGORY_PRESETS.length]!.value,
  };
}
/** Cycle match mode: soft ↔ strict (Jackett andmatch-style). */
export function cycleMatch(f: FilterState): FilterState {
  return { ...f, match: (f.match + 1) % MATCH_PRESETS.length };
}

/** Compact human summary of the active filters, e.g. "week · 1-5GB · >=5 · strict". */
export function filterSummary(f: FilterState): string {
  const parts: string[] = [];
  if (f.time > 0) parts.push(TIME_PRESETS[f.time]!.label);
  if (f.size > 0) parts.push(SIZE_PRESETS[f.size]!.label);
  if (f.seeders > 0) parts.push(SEEDER_PRESETS[f.seeders]!.label);
  if (f.category !== "all") {
    const label = CATEGORY_PRESETS.find((preset) => preset.value === f.category)!.label;
    parts.push(`category:${label}`);
  }
  if (f.match > 0) parts.push(`match:${MATCH_PRESETS[f.match]!.label}`);
  if (f.hideTrash) parts.push("no-trash");
  return parts.join(" \u00b7 ");
}

export function hasKnownAdded(result: TorrentResult): boolean {
  return Number.isFinite(result.added);
}

export function countUndatedResults(results: TorrentResult[]): number {
  return results.reduce((count, result) => count + (hasKnownAdded(result) ? 0 : 1), 0);
}

/**
 * Apply time/size/seeder/category filters. Pure: never mutates the input and
 * returns the same array instance when none of those dimensions is active.
 * An active time window requires a finite `added` timestamp at or after its
 * cutoff. Undated or invalid rows remain available only in the all-time view.
 *
 * Match-mode / hideTrash are **not** applied here — they need the query and live
 * in `rankResults` / `filterByRelevance` so tier scoring stays in one place.
 *
 * @param now Unix seconds reference for time windows; injectable for tests.
 */
export function applyFilters(
  results: TorrentResult[],
  filters: FilterState,
  now: number = Math.floor(Date.now() / 1000),
): TorrentResult[] {
  const directFiltersIdle =
    filters.time === 0 &&
    filters.size === 0 &&
    filters.seeders === 0 &&
    filters.category === "all";
  if (directFiltersIdle) return results;

  const time = TIME_PRESETS[filters.time]!;
  const size = SIZE_PRESETS[filters.size]!;
  const seeders = SEEDER_PRESETS[filters.seeders]!;
  const cutoff = time.seconds === null ? null : now - time.seconds;

  return results.filter((r) => {
    // Time window. A missing/invalid date cannot prove membership.
    if (cutoff !== null && (!hasKnownAdded(r) || r.added! < cutoff)) return false;

    // Size bounds (inclusive).
    if (size.min !== null && r.sizeBytes < size.min) return false;
    if (size.max !== null && r.sizeBytes > size.max) return false;

    // Seeders threshold (inclusive).
    if (seeders.min > 0 && r.seeders < seeders.min) return false;

    if (filters.category !== "all" && classifyCategory(r.category) !== filters.category) {
      return false;
    }

    return true;
  });
}
