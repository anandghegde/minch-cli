import type { SearchOptions, Source, TorrentResult } from "./types";
import type { CategoryFilter } from "./categories";

export { classifyCategory, filterByCategory } from "./categories";
export type { ResultCategory } from "./categories";

/**
 * Trending / browse support. Pure and side-effect free apart from `browseSource`
 * (which just delegates to a Source method). The UI layer (useTrending +
 * Trending.tsx) uses these; keeping them here makes the mapping unit-testable.
 */

/** Fetch a source's trending feed, falling back to an empty-query search when
 * the source has no dedicated browse(). */
export function browseSource(
  source: Source,
  opts: SearchOptions & { baseUrl?: string } = {},
): Promise<TorrentResult[]> {
  return source.browse ? source.browse(opts) : source.search("", opts);
}

/** Chip categories shown on the Trending tab. "all" is the unfiltered view. */
export type TrendingCategory =
  Exclude<CategoryFilter, "other">;

export interface TrendingChip {
  category: TrendingCategory;
  label: string;
}

/** Ordered chips for the Trending tab. Index 0 must be "all". */
export const TRENDING_CATEGORIES: TrendingChip[] = [
  { category: "all", label: "All" },
  { category: "movies", label: "Movies" },
  { category: "tv", label: "TV" },
  { category: "anime", label: "Anime" },
  { category: "games", label: "Games" },
  { category: "xxx", label: "XXX" },
  { category: "music", label: "Music" },
];
