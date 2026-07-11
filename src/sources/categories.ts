import type { TorrentResult } from "./types";

/** Normalized coarse category for a single torrent result. */
export type ResultCategory =
  | "movies"
  | "tv"
  | "anime"
  | "games"
  | "xxx"
  | "music"
  | "other";

/** Category filter value; `all` bypasses category filtering. */
export type CategoryFilter = "all" | ResultCategory;

/**
 * Normalize a source's coarse category label. Only aliases already emitted by
 * current source contracts belong here; unknown or missing labels stay honest
 * as `other`.
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

/** Filter torrent rows by normalized category without mutating the input. */
export function filterByCategory(
  results: TorrentResult[],
  category: CategoryFilter,
): TorrentResult[] {
  if (category === "all") return results;
  return results.filter((result) => classifyCategory(result.category) === category);
}
