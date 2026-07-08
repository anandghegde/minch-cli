import { useMemo } from "react";
import { cachedSearch } from "../../sources/cache";
import { inferSearchIntent } from "../../sources/intent";
import { rankResults } from "../../sources/ranking";
import {
  useSourceFanout,
  type FanoutState,
  type SourceSearchState,
} from "./useSourceFanout";
import type { Source } from "../../sources/types";

export type { SourceSearchState };
export type ConcurrentSearchState = FanoutState;

/**
 * Search the given (enabled, working) sources concurrently, streaming partial
 * results as each finishes. Thin wrapper over useSourceFanout: gates on a
 * non-empty query and re-runs whenever the query or source set changes.
 *
 * Smart intent: the query is run through inferSearchIntent, which strips meta
 * keywords (anime/kdrama/bollywood/language) and picks preferred sources. The
 * cleaned query is what sources actually receive (with a fallback to the raw
 * query when every term was a keyword), and results are ordered by the
 * intent-aware relevance rank instead of plain seeders.
 */
export function useConcurrentSearch(
  query: string,
  sources: Source[],
  mirrorOf: (s: Source) => string,
): ConcurrentSearchState {
  const intent = useMemo(() => inferSearchIntent(query), [query]);
  return useSourceFanout(
    sources,
    query.trim() !== "",
    (source, signal) =>
      cachedSearch(source, intent.query, { signal, baseUrl: mirrorOf(source) }),
    query,
    (results) => rankResults(results, intent),
  );
}
