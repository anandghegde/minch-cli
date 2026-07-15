import type { CatalogTitle } from "../types";
import { normalizeIdentityTitle } from "../normalize";
import type { TmdbEnricher } from "../sources/tmdb";
import {
  NEGATIVE_IDENTITY_TTL_MS,
  POSITIVE_IDENTITY_TTL_MS,
  tmdbIdentityKey,
  type CachedIdentity,
} from "./cache";
import type { RatingsCacheRepository } from "./cache-repository";

export interface TmdbIdentitySearchCandidate {
  tmdbId?: number;
  title: string;
  year?: number;
  imdbId?: string;
  mediaType?: "movie" | "series";
}

export interface RatingIdentityResolverOptions {
  repository: RatingsCacheRepository;
  enricher: TmdbEnricher;
  fetchImpl?: typeof fetch;
  now?: () => number;
  maxConcurrency?: number;
  searchTitle?: (
    title: CatalogTitle,
    options: { signal?: AbortSignal },
  ) => Promise<readonly TmdbIdentitySearchCandidate[]>;
  searchTmdbMovie?: (
    title: CatalogTitle,
    options: { signal?: AbortSignal },
  ) => Promise<readonly TmdbIdentitySearchCandidate[]>;
}

export interface RatingIdentityResolver {
  resolve(
    titles: readonly CatalogTitle[],
    options?: { signal?: AbortSignal },
  ): Promise<ReadonlyMap<string, string | undefined>>;
}

function supportedMediaType(title: CatalogTitle): "movie" | "series" | undefined {
  if (title.mediaType === "movie") return "movie";
  if (title.mediaType === "series") return "series";
  return undefined;
}

function isBluRayTitle(title: CatalogTitle): boolean {
  // Aggregation preserves the source ID at the end of canonical fallback IDs.
  return title.id.startsWith("bluray:") || title.id.includes(":bluray:");
}

export function createRatingIdentityResolver(
  options: RatingIdentityResolverOptions,
): RatingIdentityResolver {
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;

  async function persist(
    key: string,
    imdbId: string | undefined,
    currentTime: number,
  ): Promise<void> {
    const entry: CachedIdentity = imdbId
      ? { key, imdbId, resolvedAt: currentTime, expiresAt: currentTime + POSITIVE_IDENTITY_TTL_MS }
      : { key, unresolved: true, resolvedAt: currentTime,
          expiresAt: currentTime + NEGATIVE_IDENTITY_TTL_MS };
    await options.repository.putIdentity(entry);
  }

  async function one(title: CatalogTitle, signal?: AbortSignal): Promise<string | undefined> {
    if (/^tt\d+$/.test(title.imdbId ?? "")) return title.imdbId;
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    const mediaType = supportedMediaType(title);
    if (mediaType && title.tmdbId !== undefined) {
      const key = tmdbIdentityKey(mediaType, title.tmdbId);
      const cached = await options.repository.getIdentity(key);
      if (cached && cached.expiresAt > now()) return cached.imdbId;
      const currentTime = now();
      try {
        const enriched = await options.enricher.enrich(
          { tmdbId: title.tmdbId, mediaType, missingFields: ["external_ids"] },
          { fetchImpl, ...(signal ? { signal } : {}) },
        );
        const imdbId = /^tt\d+$/.test(enriched.imdbId ?? "") ? enriched.imdbId : undefined;
        await persist(key, imdbId, currentTime);
        return imdbId;
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
        await persist(key, undefined, currentTime);
        return undefined;
      }
    }
    if (mediaType && options.searchTitle) {
      const currentTime = now();
      const cacheKey = `title:${mediaType}:${normalizeIdentityTitle(title.title)}:${title.year ?? "unknown"}`;
      const cached = await options.repository.getIdentity(cacheKey);
      if (cached && cached.expiresAt > currentTime) return cached.imdbId;
      try {
        const candidates = (await options.searchTitle(title, { ...(signal ? { signal } : {}) }))
          .filter((candidate) =>
            normalizeIdentityTitle(candidate.title) === normalizeIdentityTitle(title.title) &&
            (!candidate.mediaType || candidate.mediaType === mediaType) &&
            (title.year === undefined || candidate.year === title.year));
        // With no year in a chart row, the provider's ordered exact match is the
        // best available identity signal; type filtering keeps movies and TV apart.
        const candidate = candidates[0];
        let imdbId = candidate && /^tt\d+$/.test(candidate.imdbId ?? "")
          ? candidate.imdbId : undefined;
        if (!imdbId && candidate?.tmdbId !== undefined) {
          const enriched = await options.enricher.enrich(
            { tmdbId: candidate.tmdbId, mediaType, missingFields: ["external_ids"] },
            { fetchImpl, ...(signal ? { signal } : {}) },
          );
          if (/^tt\d+$/.test(enriched.imdbId ?? "")) imdbId = enriched.imdbId;
        }
        await persist(cacheKey, imdbId, currentTime);
        return imdbId;
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
        await persist(cacheKey, undefined, currentTime);
        return undefined;
      }
    }
    if (title.mediaType === "movie" && isBluRayTitle(title) && options.searchTmdbMovie) {
      const currentTime = now();
      const cacheKey = `bluray:${normalizeIdentityTitle(title.title)}:${title.year ?? "unknown"}`;
      const cached = await options.repository.getIdentity(cacheKey);
      if (cached && cached.expiresAt > currentTime) return cached.imdbId;
      try {
        const candidates = (await options.searchTmdbMovie(title, { ...(signal ? { signal } : {}) }))
          .filter((candidate) =>
            normalizeIdentityTitle(candidate.title) === normalizeIdentityTitle(title.title) &&
            (title.year === undefined || candidate.year === title.year));
        const candidate = candidates.length === 1 ? candidates[0] : undefined;
        let imdbId = candidate && /^tt\d+$/.test(candidate.imdbId ?? "")
          ? candidate.imdbId : undefined;
        if (!imdbId && candidate?.tmdbId !== undefined) {
          const enriched = await options.enricher.enrich(
            { tmdbId: candidate.tmdbId, mediaType: "movie", missingFields: ["external_ids"] },
            { fetchImpl, ...(signal ? { signal } : {}) },
          );
          if (/^tt\d+$/.test(enriched.imdbId ?? "")) imdbId = enriched.imdbId;
        }
        await persist(cacheKey, imdbId, currentTime);
        return imdbId;
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
        await persist(cacheKey, undefined, currentTime);
      }
    }
    return undefined;
  }

  async function resolve(
    titles: readonly CatalogTitle[],
    resolveOptions: { signal?: AbortSignal } = {},
  ): Promise<ReadonlyMap<string, string | undefined>> {
    const result = new Map<string, string | undefined>();
    let cursor = 0;
    const worker = async () => {
      while (cursor < titles.length) {
        if (resolveOptions.signal?.aborted) return;
        const title = titles[cursor++]!;
        result.set(title.id, await one(title, resolveOptions.signal));
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(options.maxConcurrency ?? 4, titles.length) },
      worker,
    ));
    if (resolveOptions.signal?.aborted) {
      throw resolveOptions.signal.reason ?? new DOMException("Aborted", "AbortError");
    }
    return result;
  }
  return { resolve };
}
