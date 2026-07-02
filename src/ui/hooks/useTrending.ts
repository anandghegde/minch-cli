import { cachedBrowse } from "../../sources/cache";
import { useSourceFanout, type FanoutState } from "./useSourceFanout";
import type { Source } from "../../sources/types";

export type TrendingState = FanoutState;

/**
 * Fetch trending / popular results from every enabled source concurrently via
 * each source's browse() (falling back to an empty-query search). Category
 * filtering happens client-side over the returned rows, so this fetches once
 * regardless of the selected category. Re-runs only when the source set changes.
 */
export function useTrending(
  sources: Source[],
  mirrorOf: (s: Source) => string,
): TrendingState {
  return useSourceFanout(
    sources,
    sources.length > 0,
    (source, signal) =>
      cachedBrowse(source, { signal, baseUrl: mirrorOf(source) }),
    "trending",
  );
}
