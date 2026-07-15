import type { DiscoveryAdapter, DiscoverySnapshot } from "./adapter";
import type { DiscoveryCacheRepository } from "./cache-repository";
import { discoveryRequestKey } from "./cache";
import { validateDiscoveryRequest, type DiscoveryRequest } from "./request";
import { sanitizeDiscoverySnapshot } from "./security";
import type { DiscoverySource } from "./types";

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

export interface RefreshPolicy {
  freshForMs: number;
  retainForMs: number;
}

export const REFRESH_POLICIES: Readonly<Record<DiscoverySource, RefreshPolicy>> = {
  tmdb: { freshForMs: 12 * HOUR_MS, retainForMs: 7 * DAY_MS },
  bluray: { freshForMs: 24 * HOUR_MS, retainForMs: 30 * DAY_MS },
  trakt: { freshForMs: 24 * HOUR_MS, retainForMs: 30 * DAY_MS },
  "streaming-availability": { freshForMs: 12 * HOUR_MS, retainForMs: 45 * DAY_MS },
  apify: { freshForMs: 6 * HOUR_MS, retainForMs: 14 * DAY_MS },
  tamilmv: { freshForMs: 6 * HOUR_MS, retainForMs: 14 * DAY_MS },
};

export const PROVIDER_DICTIONARY_POLICY: RefreshPolicy = {
  freshForMs: 30 * DAY_MS,
  retainForMs: 90 * DAY_MS,
};

export type DiscoveryCacheState = "fresh" | "stale" | "expired" | "miss" | "refreshed";

export interface DiscoveryRefreshResult {
  status: "ready" | "failed";
  snapshot?: DiscoverySnapshot;
  error?: Error;
  retained: boolean;
}

export interface DiscoveryLoadResult {
  cacheState: DiscoveryCacheState;
  snapshot?: DiscoverySnapshot;
  refreshing: boolean;
  refresh?: Promise<DiscoveryRefreshResult>;
  error?: Error;
}

export interface DiscoveryServiceOptions {
  cache: DiscoveryCacheRepository;
  fetchImpl: typeof fetch;
  now?: () => number;
  policies?: Partial<Record<DiscoverySource, RefreshPolicy>>;
}

export interface DiscoveryLoadOptions {
  signal?: AbortSignal;
}

export interface DiscoveryService {
  load(
    adapter: DiscoveryAdapter,
    request: DiscoveryRequest,
    options?: DiscoveryLoadOptions,
  ): Promise<DiscoveryLoadResult>;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function createDiscoveryService(options: DiscoveryServiceOptions): DiscoveryService {
  const now = options.now ?? Date.now;
  const inflight = new Map<string, Promise<DiscoveryRefreshResult>>();

  function refresh(
    adapter: DiscoveryAdapter,
    request: DiscoveryRequest,
    signal: AbortSignal | undefined,
    fallback: DiscoverySnapshot | undefined,
  ): Promise<DiscoveryRefreshResult> {
    const key = discoveryRequestKey(adapter.id, request);
    const existing = inflight.get(key);
    if (existing) return existing;

    const promise = (async (): Promise<DiscoveryRefreshResult> => {
      try {
        const snapshot = sanitizeDiscoverySnapshot(await adapter.fetch(request, {
          fetchImpl: options.fetchImpl,
          ...(signal ? { signal } : {}),
        }));
        if (snapshot.source !== adapter.id) {
          throw new TypeError(`adapter ${adapter.id} returned snapshot for ${snapshot.source}`);
        }
        const policy = request.feedKind === "provider_dictionary"
          ? PROVIDER_DICTIONARY_POLICY
          : options.policies?.[adapter.id] ?? REFRESH_POLICIES[adapter.id];
        await options.cache.putSnapshot(
          request,
          snapshot,
          snapshot.fetchedAt + policy.freshForMs,
          snapshot.fetchedAt + policy.retainForMs,
        );
        return { status: "ready", snapshot, retained: false };
      } catch (error) {
        return {
          status: "failed",
          ...(fallback ? { snapshot: fallback } : {}),
          error: asError(error),
          retained: !!fallback,
        };
      }
    })().finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, promise);
    return promise;
  }

  async function load(
    adapter: DiscoveryAdapter,
    request: DiscoveryRequest,
    loadOptions: DiscoveryLoadOptions = {},
  ): Promise<DiscoveryLoadResult> {
    validateDiscoveryRequest(request);
    const entry = await options.cache.get(adapter.id, request);
    const cachedSnapshot = entry
      ? sanitizeDiscoverySnapshot(entry.snapshot)
      : undefined;
    const currentTime = now();
    if (entry && currentTime < entry.expiresAt) {
      return { cacheState: "fresh", snapshot: cachedSnapshot, refreshing: false };
    }
    if (entry && currentTime < entry.staleUntil) {
      const pending = refresh(adapter, request, loadOptions.signal, cachedSnapshot);
      return {
        cacheState: "stale",
        snapshot: cachedSnapshot,
        refreshing: true,
        refresh: pending,
      };
    }

    const pending = refresh(adapter, request, loadOptions.signal, cachedSnapshot);
    const result = await pending;
    if (result.status === "ready") {
      return { cacheState: "refreshed", snapshot: result.snapshot, refreshing: false };
    }
    return {
      cacheState: entry ? "expired" : "miss",
      ...(result.snapshot ? { snapshot: result.snapshot } : {}),
      refreshing: false,
      error: result.error,
    };
  }

  return { load };
}
