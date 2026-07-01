import { useEffect, useRef, useState } from "react";
import { cachedSearch } from "../../sources/cache";
import { dedupe, defaultOrder } from "../../sources/search";
import { HttpError } from "../../util/net";
import type { Source, TorrentResult } from "../../sources/types";

export interface SourceSearchState {
  loading: boolean;
  error: string | null;
  code: string | null;
  count: number;
}

export interface ConcurrentSearchState {
  results: TorrentResult[];
  perSource: Record<string, SourceSearchState>;
  loading: boolean;
  done: number;
  total: number;
}

const PER_SOURCE_TIMEOUT_MS = 20_000;

function errorCode(e: unknown, timedOut: boolean): string {
  if (timedOut) return "timed out";
  if (e instanceof HttpError && e.status > 0) return `HTTP ${e.status}`;
  return "no response";
}

function idle(total: number): ConcurrentSearchState {
  return { results: [], perSource: {}, loading: false, done: 0, total };
}

/**
 * Search the given (enabled, working) sources concurrently, streaming partial
 * results as each finishes. One failed source never breaks the run; per-source
 * timeouts abort stragglers. Re-runs whenever the query or source set changes.
 */
export function useConcurrentSearch(
  query: string,
  sources: Source[],
  mirrorOf: (s: Source) => string,
): ConcurrentSearchState {
  const [state, setState] = useState<ConcurrentSearchState>(() =>
    idle(sources.length),
  );
  // Keep mirrorOf stable across renders without re-triggering the effect.
  const mirrorRef = useRef(mirrorOf);
  mirrorRef.current = mirrorOf;
  const ids = sources.map((s) => s.id).join(",");

  useEffect(() => {
    if (!query.trim() || sources.length === 0) {
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

    for (const source of sources) {
      const sc = new AbortController();
      const onAbort = (): void => sc.abort();
      ctrl.signal.addEventListener("abort", onAbort);
      const timer = setTimeout(() => sc.abort(), PER_SOURCE_TIMEOUT_MS);

      cachedSearch(source, query, {
        signal: sc.signal,
        baseUrl: mirrorRef.current(source),
      })
        .then((res) => {
          if (!alive) return;
          collected.push(...res);
          per[source.id] = {
            loading: false,
            error: null,
            code: null,
            count: res.length,
          };
        })
        .catch((e: unknown) => {
          if (!alive || ctrl.signal.aborted) return;
          const timedOut = sc.signal.aborted;
          per[source.id] = {
            loading: false,
            error: timedOut ? "timed out" : e instanceof Error ? e.message : String(e),
            code: errorCode(e, timedOut),
            count: 0,
          };
        })
        .finally(() => {
          clearTimeout(timer);
          ctrl.signal.removeEventListener("abort", onAbort);
          if (!alive) return;
          done += 1;
          setState({
            results: defaultOrder(dedupe(collected.slice())),
            perSource: { ...per },
            loading: done < sources.length,
            done,
            total: sources.length,
          });
        });
    }

    return () => {
      alive = false;
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, ids]);

  return state;
}
