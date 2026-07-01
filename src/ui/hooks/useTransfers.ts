import { useCallback, useEffect, useRef, useState } from "react";
import { isDebridError, type DebridProvider, type Transfer } from "../../debrid/types";
import { mapPool } from "../../util/concurrency";

export interface ProviderPollState {
  loading: boolean;
  error: string | null;
}

export interface TransfersState {
  /** Merged, newest-first transfers across every configured provider. */
  transfers: Transfer[];
  /** Per-provider load/error state, keyed by provider id. */
  perProvider: Record<string, ProviderPollState>;
  /** True only during the very first poll (background refreshes don't flip it). */
  loading: boolean;
  /** Unix ms of the last completed poll cycle. */
  lastUpdated: number | null;
}

// Poll quickly while anything is in flight, slowly when everything is settled.
const ACTIVE_INTERVAL_MS = 4_000;
const IDLE_INTERVAL_MS = 15_000;
// Providers are few, but route through the shared pool for consistency.
const TRANSFERS_CONCURRENCY = 6;

function idle(): TransfersState {
  return { transfers: [], perProvider: {}, loading: false, lastUpdated: null };
}

function isActive(t: Transfer): boolean {
  return (
    t.status === "queued" ||
    t.status === "downloading" ||
    t.status === "seeding" ||
    t.status === "needs_selection"
  );
}

function sortNewestFirst(transfers: Transfer[]): Transfer[] {
  return transfers
    .slice()
    .sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0) || a.name.localeCompare(b.name));
}

function errorMessage(e: unknown): string {
  if (isDebridError(e)) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Poll every configured provider concurrently, merging results newest-first.
 * Mirrors `useConcurrentSearch`: stable inputs are read through a ref so the
 * effect only restarts when the provider set (or a manual refresh) changes.
 *
 * Resilience guarantees:
 * - A failure on one provider never blanks the screen; its last-known rows are
 *   retained and the error is surfaced per provider.
 * - Rate-limited providers (quota errors with a `retryAfterMs`) are skipped
 *   until their backoff elapses, while other providers keep polling.
 * - The interval adapts: ~4s while any transfer is active, ~15s when all idle.
 */
export function useTransfers(
  providers: DebridProvider[],
): TransfersState & { refresh: () => void } {
  const [state, setState] = useState<TransfersState>(idle);
  const providersRef = useRef(providers);
  providersRef.current = providers;
  const ids = providers.map((p) => p.id).join(",");

  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (providers.length === 0) {
      setState(idle());
      return;
    }

    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ctrl = new AbortController();
    // Survives across poll cycles within this effect run.
    const lastByProvider = new Map<string, Transfer[]>();
    const cooldownUntil = new Map<string, number>();

    const schedule = (ms: number): void => {
      timer = setTimeout(() => void poll(), ms);
    };

    const poll = async (): Promise<void> => {
      ctrl = new AbortController();
      const ps = providersRef.current;
      const now = Date.now();

      const settled = await mapPool(ps, TRANSFERS_CONCURRENCY, async (p) => {
        if ((cooldownUntil.get(p.id) ?? 0) > now) {
          // Still backing off: reuse the last-known rows, skip the call.
          return lastByProvider.get(p.id) ?? [];
        }
        return p.listTransfers(ctrl.signal);
      });
      if (!alive) return;

      const merged: Transfer[] = [];
      const perProvider: Record<string, ProviderPollState> = {};
      settled.forEach((result, i) => {
        const p = ps[i]!;
        if (result.status === "fulfilled") {
          lastByProvider.set(p.id, result.value);
          merged.push(...result.value);
          perProvider[p.id] = { loading: false, error: null };
        } else {
          // Keep whatever we last saw so the row set never collapses.
          merged.push(...(lastByProvider.get(p.id) ?? []));
          perProvider[p.id] = { loading: false, error: errorMessage(result.reason) };
          const e = result.reason;
          if (isDebridError(e) && e.kind === "quota" && e.retryAfterMs) {
            cooldownUntil.set(p.id, Date.now() + e.retryAfterMs);
          }
        }
      });

      const transfers = sortNewestFirst(merged);
      setState({ transfers, perProvider, loading: false, lastUpdated: Date.now() });
      schedule(transfers.some(isActive) ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS);
    };

    setState((s) => ({ ...s, loading: true }));
    void poll();

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, nonce]);

  return { ...state, refresh };
}
