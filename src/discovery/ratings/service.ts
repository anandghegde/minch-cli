import type { CatalogRating, CatalogTitle } from "../types";
import { mergeRatings, selectPreferredRating } from "./types";
import type { ImdbDatasetBackend } from "./imdb-dataset";
import type { RatingIdentityResolver } from "./identity-resolver";
import type { MdblistBackend } from "./mdblist";

export interface DiscoveryRatingsResult {
  byTitleId: ReadonlyMap<string, CatalogRating[]>;
  loading: boolean;
  exactCount: number;
  fallbackCount: number;
  unresolvedCount: number;
  error?: Error;
  refreshedAt?: number;
}

export interface DiscoveryRatingsService {
  load(
    titles: readonly CatalogTitle[],
    options: {
      provider: "off" | "imdb-dataset" | "mdblist";
      signal?: AbortSignal;
      onUpdate?: (result: DiscoveryRatingsResult) => void;
    },
  ): Promise<DiscoveryRatingsResult>;
}

export interface DiscoveryRatingsServiceOptions {
  dataset?: ImdbDatasetBackend;
  identities?: RatingIdentityResolver;
  mdblist?: MdblistBackend;
  now?: () => number;
}

function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function resultFor(
  titles: readonly CatalogTitle[],
  byTitleId: ReadonlyMap<string, CatalogRating[]>,
  loading: boolean,
  now: () => number,
  error?: Error,
): DiscoveryRatingsResult {
  let exactCount = 0;
  let fallbackCount = 0;
  let unresolvedCount = 0;
  for (const title of titles) {
    const preferred = selectPreferredRating(byTitleId.get(title.id) ?? []);
    if (preferred?.system === "imdb") exactCount += 1;
    else if (preferred) fallbackCount += 1;
    else unresolvedCount += 1;
  }
  return { byTitleId, loading, exactCount, fallbackCount, unresolvedCount,
    ...(error ? { error } : {}), refreshedAt: now() };
}

export function createDiscoveryRatingsService(
  dependencies: DiscoveryRatingsServiceOptions,
): DiscoveryRatingsService {
  const now = dependencies.now ?? Date.now;
  const inflight = new Map<string, {
    promise: Promise<DiscoveryRatingsResult>;
    signal?: AbortSignal;
  }>();

  async function perform(
    titles: readonly CatalogTitle[],
    options: { provider: "off" | "imdb-dataset" | "mdblist"; signal?: AbortSignal;
      onUpdate?: (result: DiscoveryRatingsResult) => void },
  ): Promise<DiscoveryRatingsResult> {
    const byTitleId = new Map<string, CatalogRating[]>();
    for (const title of titles) byTitleId.set(title.id, mergeRatings(title.ratings));
    let error: Error | undefined;
    if (options.provider === "imdb-dataset" && dependencies.dataset && dependencies.identities) {
      try {
        for (let offset = 0; offset < titles.length; offset += 8) {
          const batch = titles.slice(offset, offset + 8);
          const identities = await dependencies.identities.resolve(batch,
            { ...(options.signal ? { signal: options.signal } : {}) });
          const ids = [...new Set([...identities.values()].filter((id): id is string => !!id))];
          const exact = await dependencies.dataset.lookup(ids, options.signal);
          for (const title of batch) {
            const imdbId = identities.get(title.id);
            const rating = imdbId ? exact.get(imdbId) : undefined;
            if (rating) byTitleId.set(title.id, mergeRatings(byTitleId.get(title.id), [rating]));
          }
          if (offset + batch.length < titles.length) {
            options.onUpdate?.(resultFor(titles, new Map(byTitleId), true, now));
          }
        }
      } catch (caught) {
        if (options.signal?.aborted) throw caught;
        error = errorOf(caught);
      }
    } else if (options.provider === "mdblist" && dependencies.mdblist) {
      try {
        const exact = await dependencies.mdblist.lookup(titles, options.signal);
        for (const [titleId, rating] of exact) {
          byTitleId.set(titleId, mergeRatings(byTitleId.get(titleId), [rating]));
        }
      } catch (caught) {
        if (options.signal?.aborted) throw caught;
        error = errorOf(caught);
      }
    }
    return resultFor(titles, byTitleId, false, now, error);
  }

  function load(
    titles: readonly CatalogTitle[],
    options: { provider: "off" | "imdb-dataset" | "mdblist"; signal?: AbortSignal;
      onUpdate?: (result: DiscoveryRatingsResult) => void },
  ): Promise<DiscoveryRatingsResult> {
    const key = `${options.provider}\0${titles.map((title) =>
      `${title.id}:${title.imdbId ?? ""}:${title.tmdbId ?? ""}:${(title.ratings ?? [])
        .map((rating) => `${rating.system}:${rating.provider}:${rating.value}:${rating.observedAt}`).join(",")}`)
      .join("|")}`;
    const existing = inflight.get(key);
    if (existing && !existing.signal?.aborted) return existing.promise;
    if (existing) inflight.delete(key);
    const promise = perform(titles, options);
    inflight.set(key, { promise, ...(options.signal ? { signal: options.signal } : {}) });
    void promise.finally(() => {
      if (inflight.get(key)?.promise === promise) inflight.delete(key);
    }).catch(() => {});
    return promise;
  }
  return { load };
}
