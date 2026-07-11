import type { TorrentResult } from "./types";
import { logSeeders } from "./relevance";
import { parseReleaseName, qualityRank } from "./releasename";

function stableResultKey(result: TorrentResult): string {
  return `${result.source}\u0000${result.name.toLocaleLowerCase()}\u0000${result.infoHash}`;
}

function stableTiebreak(a: TorrentResult, b: TorrentResult): number {
  return stableResultKey(a).localeCompare(stableResultKey(b));
}

function compareKnownDates(a: TorrentResult, b: TorrentResult, dir: SortDir): number {
  const aKnown = Number.isFinite(a.added);
  const bKnown = Number.isFinite(b.added);
  if (aKnown !== bKnown) return aKnown ? -1 : 1;
  if (!aKnown) return 0;
  return dir === "asc" ? a.added! - b.added! : b.added! - a.added!;
}

/**
 * Deduplicate results. Primary key is the info hash; when absent (download-URL
 * only sources), fall back to a normalized title+size key so the same release
 * surfaced by two sources collapses to one row. Keeps the healthiest copy.
 */
export function dedupe(list: TorrentResult[]): TorrentResult[] {
  const byKey = new Map<string, TorrentResult>();
  for (const r of list) {
    const hash = r.infoHash && /^[a-f0-9]{40}$/i.test(r.infoHash)
      ? r.infoHash.toLowerCase()
      : null;
    const key = hash ?? `${r.name.toLowerCase().replace(/\s+/g, " ").trim()}::${r.sizeBytes}`;
    const existing = byKey.get(key);
    if (!existing || r.seeders > existing.seeders) byKey.set(key, r);
  }
  return [...byKey.values()];
}

export type SortField = "seeders" | "size" | "source" | "date" | "quality";
export type SortDir = "asc" | "desc";
export interface SortState {
  field: SortField;
  dir: SortDir;
}

/**
 * Legacy seeders-only order (most seeders first, then most recent).
 * Still used by trending/browse (no query) and tests. Keyword search default
 * path uses rankResults from relevance.ts instead.
 */
export function defaultOrder(list: TorrentResult[]): TorrentResult[] {
  return list.slice().sort((a, b) => {
    if (b.seeders !== a.seeders) return b.seeders - a.seeders;
    return (b.added ?? 0) - (a.added ?? 0) || stableTiebreak(a, b);
  });
}

export function sortResults(list: TorrentResult[], sort: SortState): TorrentResult[] {
  const arr = list.slice();
  const mul = sort.dir === "asc" ? 1 : -1;
  switch (sort.field) {
    case "seeders":
      arr.sort((a, b) =>
        mul * (a.seeders - b.seeders) || (b.added ?? 0) - (a.added ?? 0) || stableTiebreak(a, b),
      );
      break;
    case "size":
      arr.sort((a, b) =>
        mul * (a.sizeBytes - b.sizeBytes) || b.seeders - a.seeders || stableTiebreak(a, b),
      );
      break;
    case "source":
      arr.sort(
        (a, b) =>
          mul * (a.sourceLabel ?? a.source).localeCompare(b.sourceLabel ?? b.source) ||
          b.seeders - a.seeders ||
          stableTiebreak(a, b),
      );
      break;
    case "date":
      arr.sort((a, b) =>
        compareKnownDates(a, b, sort.dir) || b.seeders - a.seeders || stableTiebreak(a, b),
      );
      break;
    case "quality":
      arr.sort((a, b) => {
        const qa = qualityRank(parseReleaseName(a.name));
        const qb = qualityRank(parseReleaseName(b.name));
        // desc: higher quality first; seeders are always a desc tiebreaker.
        return mul * (qa - qb) || logSeeders(b.seeders) - logSeeders(a.seeders) || stableTiebreak(a, b);
      });
      break;
  }
  return arr;
}

export const SORT_CYCLE: (SortState | "default")[] = [
  "default",
  { field: "seeders", dir: "desc" },
  { field: "quality", dir: "desc" },
  { field: "size", dir: "desc" },
  { field: "size", dir: "asc" },
  { field: "date", dir: "desc" },
  { field: "source", dir: "asc" },
];

export function nextSort(
  current: SortState | "default",
): SortState | "default" {
  const same = (a: SortState | "default", b: SortState | "default"): boolean =>
    a === "default" || b === "default"
      ? a === b
      : a.field === b.field && a.dir === b.dir;
  const i = SORT_CYCLE.findIndex((s) => same(s, current));
  return SORT_CYCLE[(i + 1) % SORT_CYCLE.length]!;
}

export function sortLabel(sort: SortState | "default"): string {
  // Default path is query-text relevance ranking (see rankResults).
  if (sort === "default") return "relevance";
  const arrow = sort.dir === "asc" ? "\u25b4" : "\u25be";
  return `${sort.field} ${arrow}`;
}
