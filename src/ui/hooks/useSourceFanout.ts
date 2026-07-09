import { useEffect, useRef, useState } from "react";
import { errorToCode } from "../../sources/adapter";
import { dedupe, defaultOrder } from "../../sources/search";
import { rankResults } from "../../sources/relevance";
import { mapPool } from "../../util/concurrency";
import type { Source, TorrentResult } from "../../sources/types";

export interface SourceSearchState {
  loading: boolean;
  error: string | null;
  code: string | null;
  count: number;
}

export interface FanoutState {
  results: TorrentResult[];
  perSource: Record<string, SourceSearchState>;
  loading: boolean;
  done: number;
  total: number;
}

/** One source's outcome: either its results or a normalized error. */
type SourceOutcome =
  | { ok: true; results: TorrentResult[] }
  | { ok: false; error: string; code: string };

const PER_SOURCE_TIMEOUT_MS = 20_000;
// Bound simultaneous requests so 50+ enabled sources don't all fire at once.
const FANOUT_CONCURRENCY = 12;

function idle(total: number): FanoutState {
  return { results: [], perSource: {}, loading: false, done: 0, total };
}

/**
 * Fan a per-source fetch out across sources concurrently, streaming partial
 * results as each finishes. One failed source never breaks the run; per-source
 * timeouts abort stragglers. Shared by keyword search (useConcurrentSearch) and
 * trending browse (useTrending) — only the per-source `fetchOne` and the re-run
 * trigger differ.
 *
 * @param sources  the sources to query
 * @param active   when false, the hook stays idle (e.g. an empty query)
 * @param fetchOne fetch one source's results, honoring the abort signal. Kept
 *   in a ref, so a fresh closure each render is fine and never re-triggers.
 * @param depKey   changing this string re-runs the fan-out (alongside the
 *   source id set)
 */
export function useSourceFanout(
  sources: Source[],
  active: boolean,
  fetchOne: (source: Source, signal: AbortSignal) => Promise<TorrentResult[]>,
  depKey: string,
): FanoutState {
  const [state, setState] = useState<FanoutState>(() => idle(sources.length));
  // Keep fetchOne stable across renders without re-triggering the effect.
  const fetchRef = useRef(fetchOne);
  fetchRef.current = fetchOne;
  const ids = sources.map((s) => s.id).join(",");

  useEffect(() => {
    if (!active || sources.length === 0) {
      setState(idle(sources.length));
      return;
    }
    const ctrl = new AbortController();
    let alive = true;
    const collected: TorrentResult[] = [];
    const per: Record<string, SourceSearchState> = {};
    for (const s of sources) {
      per[s.id] = { loading: true, error: null, code: null, count: 0 };
    }
    let done = 0;

    setState({
      results: [],
      perSource: { ...per },
      loading: true,
      done: 0,
      total: sources.length,
    });

    // Fetch one source: per-source timeout + abort linked to the run's signal.
    // Returns a result union so an expected failure is data, not a thrown
    // exception (keeps control flow explicit and testable).
    const runSource = async (source: Source): Promise<SourceOutcome> => {
      if (ctrl.signal.aborted) return { ok: false, error: "aborted", code: "aborted" };
      const sc = new AbortController();
      const onAbort = (): void => sc.abort();
      ctrl.signal.addEventListener("abort", onAbort);
      const timer = setTimeout(() => sc.abort(), PER_SOURCE_TIMEOUT_MS);
      try {
        const res = await fetchRef.current(source, sc.signal);
        return { ok: true, results: res };
      } catch (e: unknown) {
        const timedOut = sc.signal.aborted && !ctrl.signal.aborted;
        return {
          ok: false,
          error: timedOut ? "timed out" : e instanceof Error ? e.message : String(e),
          code: errorToCode(e, timedOut),
        };
      } finally {
        clearTimeout(timer);
        ctrl.signal.removeEventListener("abort", onAbort);
      }
    };

    const onSettled = (
      source: Source,
      _index: number,
      settled: PromiseSettledResult<SourceOutcome>,
    ): void => {
      if (!alive) return;
      if (settled.status === "fulfilled") {
        const r = settled.value;
        if (r.ok) {
          collected.push(...r.results);
          per[source.id] = { loading: false, error: null, code: null, count: r.results.length };
        } else {
          per[source.id] = { loading: false, error: r.error, code: r.code, count: 0 };
        }
      } else {
        per[source.id] = { loading: false, error: "no response", code: "no response", count: 0 };
      }
      done += 1;
      const deduped = dedupe(collected.slice());
      // Keyword search passes the user query as depKey; trending/browse passes
      // a non-query sentinel (or empty). rankResults falls back to seeders
      // order when the query has no tokens — but for the explicit trending
      // sentinel we keep legacy defaultOrder so a random word never re-ranks browse.
      const ordered =
        depKey === "trending" || !depKey.trim()
          ? defaultOrder(deduped)
          : rankResults(deduped, depKey);
      setState({
        results: ordered,
        perSource: { ...per },
        loading: done < sources.length,
        done,
        total: sources.length,
      });
    };

    void mapPool(sources, FANOUT_CONCURRENCY, runSource, onSettled);

    return () => {
      alive = false;
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depKey, ids, active]);

  return state;
}
