import { cachedSearch } from "../../sources/cache";
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
 */
export function useConcurrentSearch(
  query: string,
  sources: Source[],
  mirrorOf: (s: Source) => string,
): ConcurrentSearchState {
  return useSourceFanout(
    sources,
    query.trim() !== "",
    (source, signal) =>
      cachedSearch(source, query, { signal, baseUrl: mirrorOf(source) }),
    query,
  );
}
