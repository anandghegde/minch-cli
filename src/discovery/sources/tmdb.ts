import type { Config } from "../../config/config";
import type {
  DiscoveryAdapter,
  DiscoveryAttribution,
  DiscoverySnapshot,
  DiscoveryWarning,
} from "../adapter";
import {
  JUSTWATCH_ATTRIBUTION_NOTICE,
  TMDB_REQUIRED_NOTICE,
} from "../attribution";
import { DiscoveryBudgetExceededError, type RequestLedger } from "../budget";
import {
  isDiscoveryAdapterEnabled,
  resolveTmdbCredential,
  TMDB_API_BASE_URL,
} from "../config";
import { parseDateOnly } from "../dates";
import { validateDiscoveryRequest, type DiscoveryRequest } from "../request";
import {
  sanitizeDiscoveryData,
  sanitizeDiscoverySnapshot,
  sanitizeDiscoveryText,
} from "../security";
import type { CatalogTitle, MediaType, ReleaseEvent, ReleaseKind } from "../types";
import {
  disposeResponse,
  fetchResilient,
  HttpError,
  USER_AGENT,
  type FetchImpl,
  type SleepImpl,
} from "../../util/net";
import { cleanText } from "../../util/format";

export type TmdbMediaType = "movie" | "tv" | "person";

export const TMDB_ATTRIBUTION: DiscoveryAttribution = {
  source: "tmdb",
  sourceLabel: "TMDB",
  sourceUrl: "https://www.themoviedb.org",
  notice: TMDB_REQUIRED_NOTICE,
  logoGuidanceUrl: "https://www.themoviedb.org/about/logos-attribution",
  additionalNotices: [
    JUSTWATCH_ATTRIBUTION_NOTICE,
  ],
};

export function tmdbTitleUrl(mediaType: "movie" | "series", tmdbId: number): string {
  return `https://www.themoviedb.org/${mediaType === "series" ? "tv" : "movie"}/${tmdbId}`;
}

export interface TmdbListRow {
  id: number;
  title: string;
  originalTitle?: string;
  mediaType?: TmdbMediaType;
  originalLanguage?: string;
  originCountries: string[];
  genreIds: number[];
  posterPath?: string;
  popularity?: number;
  voteAverage?: number;
  voteCount?: number;
  date?: string;
}

export interface TmdbListPage {
  page: number;
  totalPages: number;
  totalResults: number;
  rows: TmdbListRow[];
  warnings: DiscoveryWarning[];
}

export interface TmdbListResult {
  pages: number;
  totalPages: number;
  totalResults: number;
  rows: TmdbListRow[];
  warnings: DiscoveryWarning[];
}

export interface TmdbRegionalRelease {
  date: string;
  type: number;
  certification?: string;
  note?: string;
}

export interface TmdbCountryReleaseDates {
  region: string;
  releases: TmdbRegionalRelease[];
}

export interface TmdbReleaseDatesResult {
  id: number;
  countries: TmdbCountryReleaseDates[];
  warnings: DiscoveryWarning[];
}

export interface TmdbProvider {
  id: number;
  name: string;
  logoPath?: string;
  displayPriority?: number;
}

export interface TmdbRegionProviders {
  link?: string;
  flatrate: TmdbProvider[];
  free: TmdbProvider[];
  ads: TmdbProvider[];
  rent: TmdbProvider[];
  buy: TmdbProvider[];
}

export interface TmdbWatchProvidersResult {
  id: number;
  regions: Record<string, TmdbRegionProviders>;
  warnings: DiscoveryWarning[];
}

export interface TmdbDetailsResult {
  id: number;
  title: string;
  originalTitle?: string;
  originalLanguage?: string;
  originCountries: string[];
  genreIds: number[];
  posterPath?: string;
  popularity?: number;
  voteAverage?: number;
  voteCount?: number;
  date?: string;
}

export interface TmdbExternalIdsResult {
  id: number;
  imdbId?: string;
}

export class TmdbContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TmdbContractError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = cleanText(value);
  return cleaned || undefined;
}

function listRow(value: unknown): TmdbListRow | undefined {
  if (!isRecord(value)) return undefined;
  const id = positiveInteger(value.id);
  const title = stringValue(value.title) ?? stringValue(value.name);
  if (!id || !title) return undefined;
  const mediaType = value.media_type === "movie" || value.media_type === "tv" || value.media_type === "person"
    ? value.media_type
    : undefined;
  const genreIds = Array.isArray(value.genre_ids)
    ? value.genre_ids.filter((id): id is number => Number.isInteger(id) && id >= 0)
    : [];
  const originCountries = Array.isArray(value.origin_country)
    ? value.origin_country
        .map(stringValue)
        .filter((country): country is string => !!country && /^[a-z]{2}$/i.test(country))
        .map((country) => country.toUpperCase())
    : [];
  const posterPath = stringValue(value.poster_path);
  const popularity = finiteNumber(value.popularity);
  const voteAverage = finiteNumber(value.vote_average);
  const voteCount = Number.isInteger(value.vote_count) && Number(value.vote_count) >= 0
    ? Number(value.vote_count)
    : undefined;
  const originalTitle = stringValue(value.original_title) ?? stringValue(value.original_name);
  const originalLanguage = stringValue(value.original_language);
  const date = stringValue(value.release_date) ?? stringValue(value.first_air_date);
  return {
    id,
    title,
    ...(originalTitle ? { originalTitle } : {}),
    ...(mediaType ? { mediaType } : {}),
    ...(originalLanguage ? { originalLanguage } : {}),
    originCountries,
    genreIds,
    ...(posterPath ? { posterPath } : {}),
    ...(popularity !== undefined ? { popularity } : {}),
    ...(voteAverage !== undefined && voteAverage >= 0 && voteAverage <= 10
      ? { voteAverage }
      : {}),
    ...(voteCount !== undefined ? { voteCount } : {}),
    ...(date ? { date } : {}),
  };
}

export function parseTmdbListPage(value: unknown): TmdbListPage {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    throw new TmdbContractError("TMDB list response is missing results");
  }
  const page = positiveInteger(value.page);
  const totalPages = positiveInteger(value.total_pages);
  const totalResults = finiteNumber(value.total_results);
  if (!page || !totalPages || totalResults === undefined || totalResults < 0) {
    throw new TmdbContractError("TMDB list response has invalid pagination");
  }
  const rows: TmdbListRow[] = [];
  const warnings: DiscoveryWarning[] = [];
  for (const [index, raw] of value.results.entries()) {
    const row = listRow(raw);
    if (row) rows.push(row);
    else warnings.push({
      code: "malformed-row",
      message: `Skipped malformed TMDB list row ${index}`,
      sourceRecordId: isRecord(raw) && raw.id !== undefined
        ? stringValue(String(raw.id))
        : undefined,
    });
  }
  return { page, totalPages, totalResults, rows, warnings };
}

export function parseTmdbReleaseDates(value: unknown): TmdbReleaseDatesResult {
  if (!isRecord(value) || !Array.isArray(value.results)) {
    throw new TmdbContractError("TMDB release-dates response is malformed");
  }
  const id = positiveInteger(value.id);
  if (!id) throw new TmdbContractError("TMDB release-dates response has no ID");
  const countries: TmdbCountryReleaseDates[] = [];
  const warnings: DiscoveryWarning[] = [];
  for (const rawCountry of value.results) {
    if (!isRecord(rawCountry) || !stringValue(rawCountry.iso_3166_1) || !Array.isArray(rawCountry.release_dates)) {
      warnings.push({ code: "malformed-region", message: "Skipped malformed TMDB release region" });
      continue;
    }
    const region = String(rawCountry.iso_3166_1);
    const releases: TmdbRegionalRelease[] = [];
    for (const rawRelease of rawCountry.release_dates) {
      if (!isRecord(rawRelease)) continue;
      const date = stringValue(rawRelease.release_date);
      const type = positiveInteger(rawRelease.type);
      if (!date || !type || type > 6) {
        warnings.push({ code: "malformed-release", message: `Skipped malformed TMDB release for ${region}` });
        continue;
      }
      const certification = stringValue(rawRelease.certification);
      const note = stringValue(rawRelease.note);
      releases.push({
        date,
        type,
        ...(certification ? { certification } : {}),
        ...(note ? { note } : {}),
      });
    }
    countries.push({ region, releases });
  }
  return { id, countries, warnings };
}

const PROVIDER_BUCKETS = ["flatrate", "free", "ads", "rent", "buy"] as const;

function providers(value: unknown, region: string, bucket: string, warnings: DiscoveryWarning[]): TmdbProvider[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    warnings.push({ code: "malformed-provider-bucket", message: `Skipped malformed ${region} ${bucket} bucket` });
    return [];
  }
  const out: TmdbProvider[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const id = positiveInteger(raw.provider_id);
    const name = stringValue(raw.provider_name);
    if (!id || !name) {
      warnings.push({ code: "malformed-provider", message: `Skipped malformed ${region} provider` });
      continue;
    }
    const logoPath = stringValue(raw.logo_path);
    const displayPriority = finiteNumber(raw.display_priority);
    out.push({
      id,
      name,
      ...(logoPath ? { logoPath } : {}),
      ...(displayPriority !== undefined ? { displayPriority } : {}),
    });
  }
  return out;
}

export function parseTmdbWatchProviders(value: unknown): TmdbWatchProvidersResult {
  if (!isRecord(value) || !isRecord(value.results)) {
    throw new TmdbContractError("TMDB watch-provider response is malformed");
  }
  const id = positiveInteger(value.id);
  if (!id) throw new TmdbContractError("TMDB watch-provider response has no ID");
  const warnings: DiscoveryWarning[] = [];
  const regions: Record<string, TmdbRegionProviders> = {};
  for (const [region, raw] of Object.entries(value.results)) {
    if (!/^[A-Z]{2}$/.test(region) || !isRecord(raw)) {
      warnings.push({ code: "malformed-provider-region", message: "Skipped malformed TMDB provider region" });
      continue;
    }
    const link = stringValue(raw.link);
    regions[region] = {
      ...(link ? { link } : {}),
      ...Object.fromEntries(
        PROVIDER_BUCKETS.map((bucket) => [bucket, providers(raw[bucket], region, bucket, warnings)]),
      ) as Omit<TmdbRegionProviders, "link">,
    };
  }
  return { id, regions, warnings };
}

export function parseTmdbDetails(value: unknown): TmdbDetailsResult {
  if (!isRecord(value)) throw new TmdbContractError("TMDB details response is malformed");
  const id = positiveInteger(value.id);
  const title = stringValue(value.title) ?? stringValue(value.name);
  if (!id || !title) throw new TmdbContractError("TMDB details response lacks identity");
  const originCountries = Array.isArray(value.origin_country)
    ? value.origin_country.filter((country): country is string => typeof country === "string")
    : Array.isArray(value.production_countries)
      ? value.production_countries
          .filter(isRecord)
          .map((country) => stringValue(country.iso_3166_1))
          .filter((country): country is string => !!country)
      : [];
  const genreIds = Array.isArray(value.genres)
    ? value.genres
        .filter(isRecord)
        .map((genre) => positiveInteger(genre.id))
        .filter((id): id is number => id !== undefined)
    : [];
  const originalTitle = stringValue(value.original_title) ?? stringValue(value.original_name);
  const originalLanguage = stringValue(value.original_language);
  const posterPath = stringValue(value.poster_path);
  const popularity = finiteNumber(value.popularity);
  const voteAverage = finiteNumber(value.vote_average);
  const voteCount = Number.isInteger(value.vote_count) && Number(value.vote_count) >= 0
    ? Number(value.vote_count)
    : undefined;
  const date = stringValue(value.release_date) ?? stringValue(value.first_air_date);
  return {
    id,
    title,
    ...(originalTitle ? { originalTitle } : {}),
    ...(originalLanguage ? { originalLanguage } : {}),
    originCountries,
    genreIds,
    ...(posterPath ? { posterPath } : {}),
    ...(popularity !== undefined ? { popularity } : {}),
    ...(voteAverage !== undefined && voteAverage >= 0 && voteAverage <= 10
      ? { voteAverage }
      : {}),
    ...(voteCount !== undefined ? { voteCount } : {}),
    ...(date ? { date } : {}),
  };
}

export function parseTmdbExternalIds(value: unknown): TmdbExternalIdsResult {
  if (!isRecord(value)) throw new TmdbContractError("TMDB external-ID response is malformed");
  const id = positiveInteger(value.id);
  if (!id) throw new TmdbContractError("TMDB external-ID response has no ID");
  const imdbId = stringValue(value.imdb_id);
  return { id, ...(imdbId ? { imdbId } : {}) };
}

export interface TmdbClientOptions {
  token: string;
  fetchImpl: typeof fetch;
  ledger: Pick<RequestLedger, "recordAttempt">;
  retries?: number;
  sleepImpl?: SleepImpl;
}

export interface TmdbClient {
  getJson(
    path: string,
    params: Record<string, string | number | boolean | undefined>,
    endpoint: string,
    signal?: AbortSignal,
  ): Promise<unknown>;
  getListPages(
    path: string,
    params: Record<string, string | number | boolean | undefined>,
    endpoint: string,
    pageLimit: number,
    signal?: AbortSignal,
  ): Promise<TmdbListResult>;
}

export function createTmdbClient(options: TmdbClientOptions): TmdbClient {
  const token = options.token.trim();
  if (!token) throw new TypeError("TMDB token is required");

  async function getJson(
    path: string,
    params: Record<string, string | number | boolean | undefined>,
    endpoint: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = new URL(path.replace(/^\/+/, ""), `${TMDB_API_BASE_URL}/`);
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    const meteredFetch: FetchImpl = async (target, init) => {
      await options.ledger.recordAttempt("tmdb", endpoint);
      return options.fetchImpl(target, init);
    };
    let response: Response;
    try {
      response = await fetchResilient(url.href, {
        fetchImpl: meteredFetch,
        retries: options.retries ?? 2,
        ...(options.sleepImpl ? { sleepImpl: options.sleepImpl } : {}),
        signal,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "user-agent": USER_AGENT,
        },
      });
    } catch (error) {
      if (error instanceof DiscoveryBudgetExceededError) throw error;
      if (error instanceof Error && error.name === "AbortError") {
        throw new HttpError(0, "aborted");
      }
      if (error instanceof HttpError) {
        if (error.status === 0 && error.message === "aborted") throw error;
        throw new HttpError(
          error.status,
          `TMDB request failed (HTTP ${error.status})`,
          error.retryAfterMs,
        );
      }
      if (error instanceof Error) {
        const safe = new Error(
          sanitizeDiscoveryText(error.message, [token]) || "TMDB request failed (network)",
        );
        safe.name = sanitizeDiscoveryText(error.name) || "Error";
        throw safe;
      }
      throw new HttpError(0, "TMDB request failed (network)");
    }
    if (!response.ok) {
      await disposeResponse(response);
      throw new HttpError(response.status, `TMDB request failed (HTTP ${response.status})`);
    }
    try {
      return await response.json() as unknown;
    } catch {
      throw new TmdbContractError("TMDB response was not valid JSON");
    }
  }

  async function getListPages(
    path: string,
    params: Record<string, string | number | boolean | undefined>,
    endpoint: string,
    pageLimit: number,
    signal?: AbortSignal,
  ): Promise<TmdbListResult> {
    if (!Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > 4) {
      throw new RangeError("TMDB page limit must be between 1 and 4");
    }
    const rows: TmdbListRow[] = [];
    const warnings: DiscoveryWarning[] = [];
    let totalPages = 1;
    let totalResults = 0;
    let pages = 0;
    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
      const parsed = parseTmdbListPage(
        await getJson(path, { ...params, page: pageNumber }, endpoint, signal),
      );
      pages += 1;
      totalPages = parsed.totalPages;
      totalResults = parsed.totalResults;
      rows.push(...parsed.rows);
      warnings.push(...parsed.warnings);
      if (pageNumber >= totalPages) break;
    }
    return { pages, totalPages, totalResults, rows, warnings };
  }

  return { getJson, getListPages };
}

export interface TmdbAdapterOptions {
  config: Config;
  ledger: Pick<RequestLedger, "recordAttempt">;
  env?: Record<string, string | undefined>;
  now?: () => number;
  retries?: number;
  sleepImpl?: SleepImpl;
}

export type TmdbEnrichmentField =
  | "metadata"
  | "external_ids"
  | "regional_releases"
  | "watch_providers";

export interface TmdbEnrichmentRequest {
  tmdbId: number;
  mediaType: "movie" | "series";
  missingFields: TmdbEnrichmentField[];
}

export interface TmdbEnrichmentResult {
  tmdbId: number;
  mediaType: "movie" | "series";
  title?: CatalogTitle;
  imdbId?: string;
  releaseDates?: TmdbReleaseDatesResult;
  watchProviders?: TmdbWatchProvidersResult;
  warnings: DiscoveryWarning[];
  fetchedAt: number;
}

export interface TmdbEnricher {
  enrich(
    request: TmdbEnrichmentRequest,
    options: { fetchImpl: typeof fetch; signal?: AbortSignal },
  ): Promise<TmdbEnrichmentResult>;
}

export const TMDB_ENRICHMENT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

interface TmdbEnrichmentCacheEntry {
  expiresAt: number;
  loaded: Set<TmdbEnrichmentField>;
  result: TmdbEnrichmentResult;
}

function titleFromDetails(
  details: TmdbDetailsResult,
  mediaType: "movie" | "series",
  observedAt: number,
  imdbId?: string,
): CatalogTitle {
  const date = parseDateOnly(details.date);
  return {
    id: `tmdb:${mediaType}:${details.id}`,
    title: details.title,
    ...(details.originalTitle ? { originalTitle: details.originalTitle } : {}),
    ...(date ? { year: date.year } : {}),
    mediaType,
    tmdbId: details.id,
    ...(imdbId ? { imdbId } : {}),
    ...(details.originalLanguage ? { originalLanguage: details.originalLanguage } : {}),
    originCountries: details.originCountries,
    genreIds: details.genreIds,
    ...(details.posterPath
      ? { posterUrl: `https://image.tmdb.org/t/p/w500${details.posterPath}` }
      : {}),
    ...(details.popularity !== undefined ? { popularity: details.popularity } : {}),
    ...(details.voteAverage !== undefined
      ? { ratings: [{
          system: "tmdb",
          provider: "tmdb",
          value: details.voteAverage,
          scale: 10,
          ...(details.voteCount !== undefined ? { voteCount: details.voteCount } : {}),
          observedAt,
        }] }
      : {}),
  };
}

export function createTmdbEnricher(options: TmdbAdapterOptions): TmdbEnricher {
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;
  const cache = new Map<string, TmdbEnrichmentCacheEntry>();
  const inflight = new Map<string, Promise<void>>();

  async function enrich(
    request: TmdbEnrichmentRequest,
    fetchOptions: { fetchImpl: typeof fetch; signal?: AbortSignal },
  ): Promise<TmdbEnrichmentResult> {
    if (!Number.isInteger(request.tmdbId) || request.tmdbId < 1) {
      throw new TypeError("TMDB enrichment requires a positive ID");
    }
    if (request.missingFields.length === 0) {
      throw new TypeError("TMDB enrichment requires at least one missing field");
    }
    if (!isDiscoveryAdapterEnabled(options.config, "tmdb")) {
      throw new HttpError(403, "TMDB discovery adapter is disabled");
    }
    const credential = resolveTmdbCredential(options.config, env);
    if (!credential.token) throw new HttpError(401, "TMDB is not configured");
    const token = credential.token;
    const key = `${request.mediaType}:${request.tmdbId}`;
    const currentTime = now();
    let entry = cache.get(key);
    if (!entry || currentTime >= entry.expiresAt) {
      entry = {
        expiresAt: currentTime + TMDB_ENRICHMENT_TTL_MS,
        loaded: new Set(),
        result: {
          tmdbId: request.tmdbId,
          mediaType: request.mediaType,
          warnings: [],
          fetchedAt: currentTime,
        },
      };
      cache.set(key, entry);
    }
    const client = createTmdbClient({
      token,
      fetchImpl: fetchOptions.fetchImpl,
      ledger: options.ledger,
      retries: options.retries,
      sleepImpl: options.sleepImpl,
    });
    const namespace = request.mediaType === "series" ? "tv" : "movie";

    async function loadField(field: TmdbEnrichmentField): Promise<void> {
      if (entry!.loaded.has(field)) return;
      const inflightKey = `${key}:${field}`;
      const existing = inflight.get(inflightKey);
      if (existing) return existing;
      const pending = (async () => {
        if (field === "metadata") {
          const details = parseTmdbDetails(
            await client.getJson(`/${namespace}/${request.tmdbId}`, {}, "title-details", fetchOptions.signal),
          );
          entry!.result.title = titleFromDetails(
            details,
            request.mediaType,
            entry!.result.fetchedAt,
            entry!.result.imdbId,
          );
        } else if (field === "external_ids") {
          const external = parseTmdbExternalIds(
            await client.getJson(
              `/${namespace}/${request.tmdbId}/external_ids`,
              {},
              "external-ids",
              fetchOptions.signal,
            ),
          );
          if (external.imdbId) {
            entry!.result.imdbId = external.imdbId;
            if (entry!.result.title) entry!.result.title.imdbId = external.imdbId;
          }
        } else if (field === "regional_releases") {
          if (request.mediaType === "series") {
            entry!.result.warnings.push({
              code: "unsupported-regional-releases",
              message: "TMDB has no movie-style regional release-date endpoint for series",
              sourceRecordId: String(request.tmdbId),
            });
          } else {
            const releases = parseTmdbReleaseDates(
              await client.getJson(
                `/movie/${request.tmdbId}/release_dates`,
                {},
                "release-dates",
                fetchOptions.signal,
              ),
            );
            entry!.result.releaseDates = releases;
            entry!.result.warnings.push(...releases.warnings);
          }
        } else {
          const providers = parseTmdbWatchProviders(
            await client.getJson(
              `/${namespace}/${request.tmdbId}/watch/providers`,
              {},
              "watch-providers",
              fetchOptions.signal,
            ),
          );
          entry!.result.watchProviders = providers;
          entry!.result.warnings.push(...providers.warnings);
        }
        entry!.loaded.add(field);
      })().finally(() => {
        inflight.delete(inflightKey);
      });
      inflight.set(inflightKey, pending);
      return pending;
    }

    await Promise.all([...new Set(request.missingFields)].map(loadField));
    entry.result = sanitizeDiscoveryData(entry.result, [token]);
    return structuredClone(entry.result);
  }

  return { enrich };
}

function mediaTypeForRow(
  row: TmdbListRow,
  fallback?: MediaType,
): MediaType | undefined {
  if (row.mediaType === "movie") return "movie";
  if (row.mediaType === "tv") return "series";
  if (row.mediaType === "person") return undefined;
  return fallback;
}

function titleFromRow(
  row: TmdbListRow,
  mediaType: MediaType,
  observedAt: number,
): CatalogTitle {
  const parsedDate = parseDateOnly(row.date);
  return {
    id: `tmdb:${mediaType}:${row.id}`,
    title: row.title,
    ...(row.originalTitle ? { originalTitle: row.originalTitle } : {}),
    ...(parsedDate ? { year: parsedDate.year } : {}),
    mediaType,
    tmdbId: row.id,
    ...(row.originalLanguage ? { originalLanguage: row.originalLanguage } : {}),
    originCountries: row.originCountries,
    genreIds: row.genreIds,
    ...(row.posterPath
      ? { posterUrl: `https://image.tmdb.org/t/p/w500${row.posterPath}` }
      : {}),
    ...(row.popularity !== undefined ? { popularity: row.popularity } : {}),
    ...(row.voteAverage !== undefined
      ? { ratings: [{
          system: "tmdb",
          provider: "tmdb",
          value: row.voteAverage,
          scale: 10,
          ...(row.voteCount !== undefined ? { voteCount: row.voteCount } : {}),
          observedAt,
        }] }
      : {}),
  };
}

function mapRows(
  rows: TmdbListRow[],
  request: DiscoveryRequest,
  observedAt: number,
  fallbackMediaType?: MediaType,
  releaseKind?: ReleaseKind,
): Pick<DiscoverySnapshot, "titles" | "events" | "warnings"> {
  const titles: CatalogTitle[] = [];
  const events: ReleaseEvent[] = [];
  const warnings: DiscoveryWarning[] = [];
  for (const row of rows) {
    const mediaType = mediaTypeForRow(row, fallbackMediaType);
    if (!mediaType) {
      if (row.mediaType !== "person") {
        warnings.push({
          code: "missing-media-type",
          message: "Skipped TMDB row without a supported media type",
          sourceRecordId: String(row.id),
        });
      }
      continue;
    }
    if (request.mediaTypes.length > 0 && !request.mediaTypes.includes(mediaType)) continue;
    const title = titleFromRow(row, mediaType, observedAt);
    titles.push(title);
    if (releaseKind) {
      events.push({
        id: `${title.id}:${request.region}:${releaseKind}:unknown`,
        titleId: title.id,
        kind: releaseKind,
        region: request.region,
        datePrecision: "unknown",
        formatLabel: releaseKind === "physical" ? "Physical" : "Digital",
        status: "unknown",
        firstObservedAt: observedAt,
        lastObservedAt: observedAt,
        evidence: [{
          source: "tmdb",
          sourceId: String(row.id),
          sourceUrl: tmdbTitleUrl(mediaType === "series" ? "series" : "movie", row.id),
          observedAt,
          confidence: "inferred",
        }],
      });
    }
  }
  return { titles, events, warnings };
}

export function createTmdbAdapter(options: TmdbAdapterOptions): DiscoveryAdapter {
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;
  return {
    id: "tmdb",
    label: "TMDB",
    capabilities: {
      features: ["trending", "regional_release", "watch_providers"],
      mediaTypes: ["movie", "series"],
      regions: ["IN"],
    },
    isEnabled: () => isDiscoveryAdapterEnabled(options.config, "tmdb"),
    isConfigured: () =>
      isDiscoveryAdapterEnabled(options.config, "tmdb") &&
      resolveTmdbCredential(options.config, env).source !== "none",
    fetch: async (request, fetchOptions) => {
      validateDiscoveryRequest(request);
      if (!isDiscoveryAdapterEnabled(options.config, "tmdb")) {
        throw new HttpError(403, "TMDB discovery adapter is disabled");
      }
      const credential = resolveTmdbCredential(options.config, env);
      if (!credential.token) throw new HttpError(401, "TMDB is not configured");
      const token = credential.token;
      const client = createTmdbClient({
        token,
        fetchImpl: fetchOptions.fetchImpl,
        ledger: options.ledger,
        retries: options.retries,
        sleepImpl: options.sleepImpl,
      });
      const fetchedAt = now();
      let page: TmdbListResult;
      let mapped: Pick<DiscoverySnapshot, "titles" | "events" | "warnings">;

      if (request.feedKind === "trending") {
        page = await client.getListPages(
          "/trending/all/week",
          { language: "en-US" },
          "trending-week",
          1,
          fetchOptions.signal,
        );
        mapped = mapRows(page.rows, request, fetchedAt);
      } else if (request.feedKind === "digital" || request.feedKind === "physical") {
        if (!request.dateRange) {
          throw new TmdbContractError(`${request.feedKind} feed requires a date range`);
        }
        if (request.mediaTypes.length > 0 && !request.mediaTypes.includes("movie")) {
          return sanitizeDiscoverySnapshot({
            source: "tmdb",
            feedKind: request.feedKind,
            titles: [],
            events: [],
            fetchedAt,
            warnings: [],
            attribution: TMDB_ATTRIBUTION,
          }, [token]);
        }
        const releaseType = request.feedKind === "digital" ? 4 : 5;
        const sortBy = request.dateRange.direction === "upcoming"
          ? "primary_release_date.asc"
          : "primary_release_date.desc";
        page = await client.getListPages(
          "/discover/movie",
          {
            region: request.region,
            "release_date.gte": request.dateRange.start,
            "release_date.lte": request.dateRange.end,
            with_release_type: releaseType,
            sort_by: sortBy,
            include_adult: false,
            language: "en-US",
          },
          `discover-${request.feedKind}`,
          1,
          fetchOptions.signal,
        );
        mapped = mapRows(
          page.rows,
          request,
          fetchedAt,
          "movie",
          request.feedKind,
        );
      } else {
        throw new TmdbContractError(`TMDB does not support ${request.feedKind} feeds`);
      }

      return sanitizeDiscoverySnapshot({
        source: "tmdb",
        feedKind: request.feedKind,
        titles: mapped.titles,
        events: mapped.events,
        fetchedAt,
        warnings: [...page.warnings, ...mapped.warnings],
        attribution: TMDB_ATTRIBUTION,
      }, [token]);
    },
  };
}
