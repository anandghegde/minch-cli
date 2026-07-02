import type { SearchOptions, Source, TorrentResult } from "./types";

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
  | "all"
  | "movies"
  | "tv"
  | "anime"
  | "games"
  | "xxx"
  | "music";

/** The concrete bucket a single result maps to (never "all"). */
export type ResultCategory = Exclude<TrendingCategory, "all"> | "other";

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

/**
 * Bucket a result's coarse `category` label (e.g. "Movies", "TV/Anime",
 * "Video", "Audio") into a trending chip. Sources supply wildly different
 * strings, so we normalize the head segment and match known synonyms. Anything
 * unrecognized (or missing) is "other" and only shows under "All".
 */
export function classifyCategory(category: string | undefined): ResultCategory {
  if (!category) return "other";
  const head = category.split("/")[0]!.trim().toLowerCase();
  if (head === "movies" || head === "movie" || head === "video") return "movies";
  if (head === "tv") return "tv";
  if (head === "anime") return "anime";
  if (head === "games" || head === "game" || head === "console") return "games";
  if (head === "xxx" || head === "porn" || head === "adult") return "xxx";
  if (head === "audio" || head === "music") return "music";
  return "other";
}

/** Filter results to a chip category. "all" returns the input unchanged. */
export function filterByCategory(
  results: TorrentResult[],
  category: TrendingCategory,
): TorrentResult[] {
  if (category === "all") return results;
  return results.filter((r) => classifyCategory(r.category) === category);
}
