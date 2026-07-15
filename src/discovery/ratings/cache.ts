import type { CatalogRating } from "../types";
import { normalizeRating, ratingKey } from "./types";

export const RATINGS_CACHE_VERSION = 1 as const;
export const RATING_FRESH_MS = 24 * 60 * 60 * 1_000;
export const RATING_STALE_MS = 30 * 24 * 60 * 60 * 1_000;
export const POSITIVE_IDENTITY_TTL_MS = 180 * 24 * 60 * 60 * 1_000;
export const NEGATIVE_IDENTITY_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const MISSING_RATING_TTL_MS = 24 * 60 * 60 * 1_000;

export interface CachedRating {
  key: string;
  rating: CatalogRating;
  fetchedAt: number;
  expiresAt: number;
  staleUntil: number;
  datasetEtag?: string;
}

export interface CachedIdentity {
  key: string;
  imdbId?: string;
  resolvedAt: number;
  expiresAt: number;
  unresolved?: boolean;
}

export interface CachedMissingRating {
  checkedAt: number;
  expiresAt: number;
  datasetEtag?: string;
}

export interface RatingsDatasetMetadata {
  etag?: string;
  lastModified?: string;
  downloadedAt?: number;
  checkedAt?: number;
  /** Last failed refresh attempt; keeps last-good/offline state explicit. */
  failedAt?: number;
}

export interface RatingsCacheDocument {
  version: typeof RATINGS_CACHE_VERSION;
  ratings: Record<string, CachedRating>;
  identities: Record<string, CachedIdentity>;
  missing: Record<string, CachedMissingRating>;
  dataset: RatingsDatasetMetadata;
}

export interface ParsedRatingsCache {
  document: RatingsCacheDocument;
  rejectedEntries: string[];
  documentError?: string;
}

const FORBIDDEN = new Set([
  "apikey", "authorization", "credential", "password", "secret", "token", "xapikey",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function finiteTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function containsCredential(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsCredential);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, entry]) =>
    FORBIDDEN.has(key.toLowerCase().replace(/[^a-z0-9]/g, "")) || containsCredential(entry));
}

export function emptyRatingsCache(): RatingsCacheDocument {
  return { version: RATINGS_CACHE_VERSION, ratings: {}, identities: {}, missing: {}, dataset: {} };
}

export function catalogRatingCacheKey(imdbId: string, rating: CatalogRating): string {
  return `${imdbId}:${ratingKey(rating)}`;
}

export function tmdbIdentityKey(mediaType: "movie" | "series", tmdbId: number): string {
  return `tmdb:${mediaType}:${tmdbId}`;
}

function parseRating(entry: unknown): CachedRating | undefined {
  if (!isRecord(entry) || containsCredential(entry) || typeof entry.key !== "string" || !entry.key) return undefined;
  const rating = normalizeRating(entry.rating as CatalogRating);
  if (!rating || !finiteTimestamp(entry.fetchedAt) || !finiteTimestamp(entry.expiresAt) ||
      !finiteTimestamp(entry.staleUntil) || entry.fetchedAt > entry.expiresAt ||
      entry.expiresAt > entry.staleUntil) return undefined;
  if (entry.datasetEtag !== undefined && typeof entry.datasetEtag !== "string") return undefined;
  return {
    key: entry.key,
    rating,
    fetchedAt: entry.fetchedAt,
    expiresAt: entry.expiresAt,
    staleUntil: entry.staleUntil,
    ...(typeof entry.datasetEtag === "string" ? { datasetEtag: entry.datasetEtag } : {}),
  };
}

export function normalizeCachedRating(entry: unknown): CachedRating | undefined {
  return parseRating(entry);
}

function parseIdentity(entry: unknown): CachedIdentity | undefined {
  if (!isRecord(entry) || containsCredential(entry) || typeof entry.key !== "string" || !entry.key ||
      !finiteTimestamp(entry.resolvedAt) || !finiteTimestamp(entry.expiresAt) ||
      entry.resolvedAt > entry.expiresAt) return undefined;
  const imdbId = typeof entry.imdbId === "string" && /^tt\d+$/.test(entry.imdbId)
    ? entry.imdbId : undefined;
  const unresolved = entry.unresolved === true;
  if ((!imdbId && !unresolved) || (imdbId && unresolved)) return undefined;
  return { key: entry.key, ...(imdbId ? { imdbId } : {}), resolvedAt: entry.resolvedAt,
    expiresAt: entry.expiresAt, ...(unresolved ? { unresolved: true } : {}) };
}

export function normalizeCachedIdentity(entry: unknown): CachedIdentity | undefined {
  return parseIdentity(entry);
}

function parseMissing(entry: unknown): CachedMissingRating | undefined {
  if (!isRecord(entry) || containsCredential(entry) || !finiteTimestamp(entry.checkedAt) ||
      !finiteTimestamp(entry.expiresAt) || entry.checkedAt > entry.expiresAt ||
      (entry.datasetEtag !== undefined && typeof entry.datasetEtag !== "string")) return undefined;
  return { checkedAt: entry.checkedAt, expiresAt: entry.expiresAt,
    ...(typeof entry.datasetEtag === "string" ? { datasetEtag: entry.datasetEtag } : {}) };
}

export function normalizeCachedMissingRating(entry: unknown): CachedMissingRating | undefined {
  return parseMissing(entry);
}

function parseDataset(value: unknown): RatingsDatasetMetadata {
  if (!isRecord(value) || containsCredential(value)) return {};
  const out: RatingsDatasetMetadata = {};
  if (typeof value.etag === "string") out.etag = value.etag;
  if (typeof value.lastModified === "string") out.lastModified = value.lastModified;
  if (finiteTimestamp(value.downloadedAt)) out.downloadedAt = value.downloadedAt;
  if (finiteTimestamp(value.checkedAt)) out.checkedAt = value.checkedAt;
  if (finiteTimestamp(value.failedAt)) out.failedAt = value.failedAt;
  return out;
}

export function normalizeRatingsDatasetMetadata(
  value: unknown,
): RatingsDatasetMetadata | undefined {
  if (!isRecord(value) || containsCredential(value)) return undefined;
  return parseDataset(value);
}

export function parseRatingsCache(value: unknown): ParsedRatingsCache {
  const document = emptyRatingsCache();
  if (!isRecord(value)) return { document, rejectedEntries: [], documentError: "cache document is not an object" };
  if (containsCredential(value)) return { document, rejectedEntries: [], documentError: "cache contains credential-like fields" };
  if (value.version !== RATINGS_CACHE_VERSION) return { document, rejectedEntries: [], documentError: "unsupported ratings cache version" };
  if (!isRecord(value.ratings) || !isRecord(value.identities) || !isRecord(value.missing)) {
    return { document, rejectedEntries: [], documentError: "ratings cache collections are malformed" };
  }
  const rejectedEntries: string[] = [];
  for (const [key, raw] of Object.entries(value.ratings)) {
    const parsed = parseRating(raw);
    if (parsed && parsed.key === key) document.ratings[key] = parsed;
    else rejectedEntries.push(`ratings:${key}`);
  }
  for (const [key, raw] of Object.entries(value.identities)) {
    const parsed = parseIdentity(raw);
    if (parsed && parsed.key === key) document.identities[key] = parsed;
    else rejectedEntries.push(`identities:${key}`);
  }
  for (const [key, raw] of Object.entries(value.missing)) {
    const parsed = parseMissing(raw);
    if (parsed) document.missing[key] = parsed;
    else rejectedEntries.push(`missing:${key}`);
  }
  document.dataset = parseDataset(value.dataset);
  return { document, rejectedEntries };
}

export function createCachedRating(
  key: string,
  rating: CatalogRating,
  fetchedAt = Date.now(),
  datasetEtag?: string,
): CachedRating {
  const normalized = normalizeRating(rating);
  if (!key || !normalized || !finiteTimestamp(fetchedAt)) throw new TypeError("invalid cached rating");
  return { key, rating: normalized, fetchedAt, expiresAt: fetchedAt + RATING_FRESH_MS,
    staleUntil: fetchedAt + RATING_STALE_MS, ...(datasetEtag ? { datasetEtag } : {}) };
}
