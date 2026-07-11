import type { DiscoverySnapshot } from "./adapter";
import {
  validateDiscoveryRequest,
  type DiscoveryRequest,
} from "./request";
import type { DiscoverySource } from "./types";
import { parseDateOnly } from "./dates";

export const DISCOVERY_CACHE_VERSION = 1 as const;

export interface DiscoveryCacheEntry {
  source: DiscoverySource;
  request: DiscoveryRequest;
  snapshot: DiscoverySnapshot;
  expiresAt: number;
  staleUntil: number;
}

export interface DiscoveryCacheDocument {
  version: typeof DISCOVERY_CACHE_VERSION;
  entries: Record<string, DiscoveryCacheEntry>;
}

export interface RejectedCacheEntry {
  key: string;
  reason: string;
}

export interface ParsedDiscoveryCache {
  document: DiscoveryCacheDocument;
  rejectedEntries: RejectedCacheEntry[];
  documentError?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

const FORBIDDEN_CREDENTIAL_KEYS = new Set([
  "apikey",
  "authorization",
  "credential",
  "password",
  "proxyauthorization",
  "readtoken",
  "secret",
  "token",
  "xapikey",
]);

function hasCredentialField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasCredentialField);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, entry]) =>
    FORBIDDEN_CREDENTIAL_KEYS.has(key.toLowerCase().replace(/[^a-z0-9]/g, "")) ||
    hasCredentialField(entry));
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function optional(value: unknown, predicate: (input: unknown) => boolean): boolean {
  return value === undefined || predicate(value);
}

const SOURCES = new Set<DiscoverySource>([
  "tmdb",
  "bluray",
  "trakt",
  "streaming-availability",
]);
const MEDIA_TYPES = new Set(["movie", "series", "season", "episode"]);
const FEED_KINDS = new Set([
  "trending",
  "streaming_added",
  "streaming_upcoming",
  "digital",
  "physical",
  "bluray",
  "provider_dictionary",
]);
const RELEASE_KINDS = new Set([
  "streaming_added",
  "streaming_upcoming",
  "digital",
  "physical",
  "bluray",
  "uhd_bluray",
]);
const DATE_PRECISIONS = new Set(["day", "month", "year", "unknown"]);
const RELEASE_STATUSES = new Set(["past", "today", "upcoming", "unknown"]);
const CONFIDENCES = new Set(["exact", "source_claim", "inferred"]);

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function validTitle(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isString(value.id) &&
    isString(value.title) &&
    MEDIA_TYPES.has(String(value.mediaType)) &&
    optional(value.originalTitle, isString) &&
    optional(value.year, isFiniteNumber) &&
    optional(value.tmdbId, isFiniteNumber) &&
    optional(value.imdbId, isString) &&
    optional(value.traktId, isFiniteNumber) &&
    optional(value.originalLanguage, isString) &&
    isStringArray(value.originCountries) &&
    Array.isArray(value.genreIds) &&
    value.genreIds.every(isFiniteNumber) &&
    optional(value.genreLabels, isStringArray) &&
    optional(value.posterUrl, isString) &&
    optional(value.images, (images) =>
      isRecord(images) &&
      optional(images.verticalPoster, isString) &&
      optional(images.horizontalPoster, isString) &&
      optional(images.horizontalBackdrop, isString) &&
      optional(images.verticalBackdrop, isString)) &&
    optional(value.popularity, isFiniteNumber)
  );
}

function validEvidence(value: unknown): boolean {
  if (!isRecord(value) || !SOURCES.has(value.source as DiscoverySource)) return false;
  return (
    optional(value.sourceId, isString) &&
    optional(value.sourceUrl, isString) &&
    isFiniteNumber(value.observedAt) &&
    CONFIDENCES.has(String(value.confidence))
  );
}

function validEvent(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    isString(value.id) &&
    isString(value.titleId) &&
    RELEASE_KINDS.has(String(value.kind)) &&
    isString(value.region) &&
    optional(value.date, (date) => !!parseDateOnly(date)) &&
    DATE_PRECISIONS.has(String(value.datePrecision)) &&
    (value.date === undefined
      ? value.datePrecision === "unknown"
      : value.datePrecision !== "unknown") &&
    optional(value.providerId, isString) &&
    optional(value.providerLabel, isString) &&
    optional(value.formatLabel, isString) &&
    optional(value.accessType, isString) &&
    optional(value.audioLanguages, isStringArray) &&
    optional(value.subtitleLanguages, isStringArray) &&
    RELEASE_STATUSES.has(String(value.status)) &&
    isFiniteNumber(value.firstObservedAt) &&
    isFiniteNumber(value.lastObservedAt) &&
    value.firstObservedAt <= value.lastObservedAt &&
    Array.isArray(value.evidence) &&
    value.evidence.length > 0 &&
    value.evidence.every(validEvidence)
  );
}

function validWarning(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.code) &&
    isString(value.message) &&
    optional(value.sourceRecordId, isString)
  );
}

function validAttribution(value: unknown, source: DiscoverySource): boolean {
  return (
    isRecord(value) &&
    value.source === source &&
    isString(value.sourceLabel) &&
    isString(value.sourceUrl) &&
    optional(value.notice, isString) &&
    optional(value.logoGuidanceUrl, isString) &&
    optional(value.additionalNotices, isStringArray)
  );
}

function validProvider(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value.id) &&
    isString(value.label) &&
    isStringArray(value.upstreamAliases)
  );
}

function validSnapshot(value: unknown, source: DiscoverySource): value is DiscoverySnapshot {
  if (!isRecord(value)) return false;
  return (
    value.source === source &&
    optional(value.feedKind, (feedKind) => isString(feedKind) && FEED_KINDS.has(feedKind)) &&
    Array.isArray(value.titles) &&
    value.titles.every(validTitle) &&
    Array.isArray(value.events) &&
    value.events.every(validEvent) &&
    isFiniteNumber(value.fetchedAt) &&
    optional(value.cursor, isString) &&
    optional(value.resume, (resume) =>
      isRecord(resume) &&
      isFiniteNumber(resume.newestTimestampUnixSeconds) &&
      resume.newestTimestampUnixSeconds >= 0 &&
      isFiniteNumber(resume.overlapSeconds) &&
      resume.overlapSeconds >= 0) &&
    Array.isArray(value.warnings) &&
    value.warnings.every(validWarning) &&
    optional(value.attribution, (attribution) => validAttribution(attribution, source)) &&
    optional(value.providers, (providers) =>
      Array.isArray(providers) && providers.every(validProvider))
  );
}

function validRequest(value: unknown): value is DiscoveryRequest {
  if (!isRecord(value)) return false;
  if (
    !isString(value.region) ||
    !isString(value.feedKind) ||
    !FEED_KINDS.has(value.feedKind) ||
    !Array.isArray(value.mediaTypes) ||
    !value.mediaTypes.every((item) => MEDIA_TYPES.has(String(item))) ||
    !isStringArray(value.providerIds) ||
    !isFiniteNumber(value.pageLimit) ||
    !optional(value.cursor, isString)
  ) {
    return false;
  }
  if (value.dateRange !== undefined) {
    if (
      !isRecord(value.dateRange) ||
      !isString(value.dateRange.start) ||
      !isString(value.dateRange.end) ||
      (value.dateRange.direction !== "past" && value.dateRange.direction !== "upcoming")
    ) {
      return false;
    }
  }
  try {
    validateDiscoveryRequest(value as unknown as DiscoveryRequest);
    return true;
  } catch {
    return false;
  }
}

function parseEntry(value: unknown): DiscoveryCacheEntry | undefined {
  if (
    !isRecord(value) ||
    hasCredentialField(value) ||
    !SOURCES.has(value.source as DiscoverySource)
  ) return undefined;
  const source = value.source as DiscoverySource;
  if (
    !validRequest(value.request) ||
    !validSnapshot(value.snapshot, source) ||
    !isFiniteNumber(value.expiresAt) ||
    !isFiniteNumber(value.staleUntil) ||
    value.snapshot.fetchedAt > value.expiresAt ||
    value.expiresAt > value.staleUntil
  ) {
    return undefined;
  }
  return value as unknown as DiscoveryCacheEntry;
}

export function emptyDiscoveryCache(): DiscoveryCacheDocument {
  return { version: DISCOVERY_CACHE_VERSION, entries: {} };
}

/** Stable key for one source/request pair; set-like request fields are sorted. */
export function discoveryRequestKey(
  source: DiscoverySource,
  request: DiscoveryRequest,
): string {
  validateDiscoveryRequest(request);
  return JSON.stringify({
    source,
    region: request.region,
    feedKind: request.feedKind,
    dateRange: request.dateRange ?? null,
    mediaTypes: [...request.mediaTypes].sort(),
    providerIds: [...request.providerIds].sort(),
    pageLimit: request.pageLimit,
    cursor: request.cursor ?? null,
  });
}

export function createDiscoveryCacheEntry(
  request: DiscoveryRequest,
  snapshot: DiscoverySnapshot,
  expiresAt: number,
  staleUntil: number,
): DiscoveryCacheEntry {
  validateDiscoveryRequest(request);
  const entry: DiscoveryCacheEntry = {
    source: snapshot.source,
    request,
    snapshot,
    expiresAt,
    staleUntil,
  };
  if (!parseEntry(entry)) throw new TypeError("invalid discovery cache entry");
  return entry;
}

/** Parse entries independently so one corrupt source/request never poisons peers. */
export function parseDiscoveryCache(value: unknown): ParsedDiscoveryCache {
  const document = emptyDiscoveryCache();
  if (!isRecord(value)) {
    return { document, rejectedEntries: [], documentError: "cache document is not an object" };
  }
  if (value.version !== DISCOVERY_CACHE_VERSION) {
    return {
      document,
      rejectedEntries: [],
      documentError: `unsupported cache version: ${String(value.version)}`,
    };
  }
  if (!isRecord(value.entries)) {
    return { document, rejectedEntries: [], documentError: "cache entries are not an object" };
  }

  const rejectedEntries: RejectedCacheEntry[] = [];
  for (const [key, raw] of Object.entries(value.entries)) {
    const entry = parseEntry(raw);
    if (!entry) {
      rejectedEntries.push({ key, reason: "invalid cache entry" });
      continue;
    }
    const expectedKey = discoveryRequestKey(entry.source, entry.request);
    if (key !== expectedKey) {
      rejectedEntries.push({ key, reason: "request key does not match entry" });
      continue;
    }
    document.entries[key] = entry;
  }
  return { document, rejectedEntries };
}
