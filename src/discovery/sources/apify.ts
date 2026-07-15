import type { Config } from "../../config/config";
import type {
  DiscoveryAdapter,
  DiscoveryAttribution,
  DiscoveryWarning,
} from "../adapter";
import { DiscoveryBudgetExceededError, type RequestLedger } from "../budget";
import {
  APIFY_API_BASE_URL,
  isDiscoveryAdapterEnabled,
  resolveApifyCredential,
} from "../config";
import { validateDiscoveryRequest } from "../request";
import { normalizeLanguage, normalizeProvider, type NormalizedProvider } from "../normalize";
import { sanitizeDiscoverySnapshot, sanitizeDiscoveryText } from "../security";
import type { CatalogTitle } from "../types";
import { disposeResponse, fetchResilient, HttpError, USER_AGENT, type FetchImpl, type SleepImpl } from "../../util/net";

export const APIFY_STREAMING_CATALOG_ACTOR = "moving_beacon-owner1/streaming-catalog-scraper";
export const APIFY_FLIXPATROL_ACTOR = "crawlerbros/flixpatrol-streaming-charts-scraper";
export const APIFY_LETTERBOXD_ACTOR = "zhorex/letterboxd-scraper";
export const APIFY_FLIXPATROL_MAX_CHARGE_USD = 0.35;
export const APIFY_LETTERBOXD_MAX_CHARGE_USD = 0.25;

export const APIFY_ATTRIBUTION: DiscoveryAttribution = {
  source: "apify",
  sourceLabel: "Apify Streaming Catalog Scraper",
  sourceUrl: `https://apify.com/${APIFY_STREAMING_CATALOG_ACTOR}`,
  notice: "Streaming catalog data collected by an Apify Actor; source coverage and freshness may vary.",
};

export const APIFY_FLIXPATROL_ATTRIBUTION: DiscoveryAttribution = {
  source: "apify",
  sourceLabel: "FlixPatrol Streaming Charts Scraper",
  sourceUrl: `https://apify.com/${APIFY_FLIXPATROL_ACTOR}`,
  notice: "Streaming chart data collected from FlixPatrol by an Apify Actor; rankings and coverage may vary.",
};

export const APIFY_LETTERBOXD_ATTRIBUTION: DiscoveryAttribution = {
  source: "apify",
  sourceLabel: "Letterboxd Community Popularity Scraper",
  sourceUrl: `https://apify.com/${APIFY_LETTERBOXD_ACTOR}`,
  notice: "Weekly popular films collected from Letterboxd by an Apify Actor; this is a global community signal, not an India viewership chart.",
};

export class ApifyContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApifyContractError";
  }
}

export interface ApifyPopularRow {
  title: string;
  year?: number;
  type: "MOVIE" | "SHOW";
  imdbId?: string;
  tmdbId?: number;
  imdbScore?: number;
  imdbVotes?: number;
  tmdbScore?: number;
  jwRating?: number;
  genres: string[];
  originalLanguage?: string;
  streamingOn: string[];
  rentOn: string[];
  buyOn: string[];
  freeOn: string[];
  url?: string;
  poster?: string;
}

export interface ApifyPopularResult {
  rows: ApifyPopularRow[];
  warnings: DiscoveryWarning[];
}

export interface ApifyChartRow {
  title: string;
  titleSlug?: string;
  type: "MOVIE" | "SHOW";
  platform: string;
  rank: number;
  points?: number;
  genres: string[];
  sourceUrl?: string;
  poster?: string;
}

export interface ApifyChartResult {
  rows: ApifyChartRow[];
  warnings: DiscoveryWarning[];
}

export interface ApifyCommunityRow {
  title: string;
  year?: number;
  url?: string;
  poster?: string;
  averageRating?: number;
}

export interface ApifyCommunityResult {
  rows: ApifyCommunityRow[];
  warnings: DiscoveryWarning[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = sanitizeDiscoveryText(value);
  return cleaned || undefined;
}

function number(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function strings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((item) => {
    const value = text(item);
    return value ? [value] : [];
  }))];
}

function providerNames(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return [...new Set(values.flatMap((item) => {
    if (typeof item === "string") return text(item) ? [text(item)!] : [];
    if (!isRecord(item)) return [];
    const label = text(item.name) ?? text(item.provider) ?? text(item.service);
    return label ? [label] : [];
  }))];
}

function row(value: unknown, index: number, warnings: DiscoveryWarning[]): ApifyPopularRow | undefined {
  if (!isRecord(value)) {
    warnings.push({ code: "malformed-row", message: `Skipped malformed Apify row ${index}` });
    return undefined;
  }
  const title = text(value.title) ?? text(value.name);
  const type = value.type === "MOVIE" || value.type === "SHOW" ? value.type : undefined;
  if (!title || !type) {
    warnings.push({ code: "malformed-row", message: `Skipped Apify row ${index} without title/type` });
    return undefined;
  }
  const tmdbId = number(value.tmdb_id ?? value.tmdbId);
  const year = number(value.year ?? value.releaseYear);
  return {
    title,
    ...(year !== undefined ? { year: Math.trunc(year) } : {}),
    type,
    ...(text(value.imdb_id ?? value.imdbId) ? { imdbId: text(value.imdb_id ?? value.imdbId) } : {}),
    ...(tmdbId !== undefined ? { tmdbId: Math.trunc(tmdbId) } : {}),
    ...(number(value.imdb_score) !== undefined ? { imdbScore: number(value.imdb_score) } : {}),
    ...(number(value.imdb_votes) !== undefined ? { imdbVotes: number(value.imdb_votes) } : {}),
    ...(number(value.tmdb_score) !== undefined ? { tmdbScore: number(value.tmdb_score) } : {}),
    ...(number(value.jw_rating) !== undefined ? { jwRating: number(value.jw_rating) } : {}),
    genres: strings(value.genres),
    ...(normalizeLanguage(text(value.originalLanguage))?.code
      ? { originalLanguage: normalizeLanguage(text(value.originalLanguage))!.code }
      : {}),
    streamingOn: providerNames(value.streaming_on ?? value.streamingOn),
    rentOn: providerNames(value.rent_on ?? value.rentOn),
    buyOn: providerNames(value.buy_on ?? value.buyOn),
    freeOn: providerNames(value.free_on ?? value.freeOn),
    ...(text(value.url) ? { url: text(value.url) } : {}),
    ...(text(value.poster) ? { poster: text(value.poster) } : {}),
  };
}

export function parseApifyPopularResponse(value: unknown): ApifyPopularResult {
  const values = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.results)
      ? value.results
      : isRecord(value) && Array.isArray(value.items)
        ? value.items
        : undefined;
  if (!values) throw new ApifyContractError("Apify response did not contain result rows");
  const warnings: DiscoveryWarning[] = [];
  const rows = values.flatMap((item, index) => {
    const parsed = row(item, index, warnings);
    return parsed ? [parsed] : [];
  });
  return { rows, warnings };
}

export function parseApifyChartResponse(value: unknown): ApifyChartResult {
  const values = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.results)
      ? value.results
      : isRecord(value) && Array.isArray(value.items)
        ? value.items
        : undefined;
  if (!values) throw new ApifyContractError("Apify FlixPatrol response did not contain chart rows");
  const warnings: DiscoveryWarning[] = [];
  const rows = values.flatMap((value, index): ApifyChartRow[] => {
    if (!isRecord(value)) {
      warnings.push({ code: "malformed-row", message: `Skipped malformed FlixPatrol row ${index}` });
      return [];
    }
    const title = text(value.title);
    const platform = text(value.platform);
    const rank = number(value.rank);
    const category = text(value.category)?.toLowerCase();
    const titleType = text(value.title_type ?? value.contentType)?.toLowerCase();
    const type = titleType === "movie" || category?.includes("movie")
      ? "MOVIE"
      : titleType === "tv" || titleType === "show" || category?.includes("tv")
        ? "SHOW"
        : undefined;
    if (!title || !platform || rank === undefined || !type) {
      warnings.push({ code: "malformed-row", message: `Skipped FlixPatrol row ${index} without title/platform/rank/type` });
      return [];
    }
    const rawGenres = Array.isArray(value.genres)
      ? strings(value.genres)
      : (text(value.genres)?.split(",").map((genre) => genre.trim()).filter(Boolean) ?? []);
    const points = number(value.points);
    return [{
      title,
      ...(text(value.title_slug) ? { titleSlug: text(value.title_slug) } : {}),
      type,
      platform,
      rank: Math.max(1, Math.trunc(rank)),
      ...(points !== undefined ? { points } : {}),
      genres: [...new Set(rawGenres)],
      ...(text(value.sourceUrl) ? { sourceUrl: text(value.sourceUrl) } : {}),
      ...(text(value.posterUrl) ? { poster: text(value.posterUrl) } : {}),
    }];
  });
  return { rows, warnings };
}

export function parseApifyCommunityResponse(value: unknown): ApifyCommunityResult {
  const values = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.results)
      ? value.results
      : isRecord(value) && Array.isArray(value.items)
        ? value.items
        : undefined;
  if (!values) throw new ApifyContractError("Apify Letterboxd response did not contain film rows");
  const warnings: DiscoveryWarning[] = [];
  const rows = values.flatMap((value, index): ApifyCommunityRow[] => {
    if (!isRecord(value)) {
      warnings.push({ code: "malformed-row", message: `Skipped malformed Letterboxd row ${index}` });
      return [];
    }
    const title = text(value.title);
    if (!title) {
      warnings.push({ code: "malformed-row", message: `Skipped Letterboxd row ${index} without a title` });
      return [];
    }
    const year = number(value.year);
    const averageRating = number(value.averageRating);
    return [{
      title,
      ...(year !== undefined ? { year: Math.trunc(year) } : {}),
      ...(text(value.url ?? value.filmUrl) ? { url: text(value.url ?? value.filmUrl) } : {}),
      ...(text(value.posterUrl ?? value.poster) ? { poster: text(value.posterUrl ?? value.poster) } : {}),
      ...(averageRating !== undefined ? { averageRating } : {}),
    }];
  });
  return { rows, warnings };
}

function actorProviderCode(providerId: string): string | undefined {
  return {
    netflix: "nfx",
    prime: "prv",
    disney: "dnp",
    mubi: "mbi",
    crunchyroll: "cru",
    apple: "atp",
  }[providerId];
}

function chartActorPlatform(providerId: string): string | undefined {
  return {
    netflix: "netflix",
    prime: "amazon-prime",
    hotstar: "jiohotstar",
    zee5: "zee5",
  }[providerId];
}

function titleId(row: ApifyPopularRow, index: number): string {
  if (row.tmdbId !== undefined) return `apify:tmdb:${row.tmdbId}`;
  if (row.imdbId) return `apify:imdb:${row.imdbId}`;
  return `apify:popular:${row.type.toLowerCase()}:${row.title.toLowerCase()}:${row.year ?? "unknown"}:${index}`;
}

function normalizedProviders(rows: ApifyPopularRow[]): NormalizedProvider[] {
  return [...new Map([...new Set(rows.flatMap((row) => [
    ...row.streamingOn,
    ...row.freeOn,
  ]))].flatMap((label) => {
    const provider = normalizeProvider(undefined, label);
    return provider ? [[provider.id, provider] as const] : [];
  })).values()];
}

function mappedTitles(rows: ApifyPopularRow[]): CatalogTitle[] {
  return rows.map((item, index) => {
    const providers = [...new Set([...item.streamingOn, ...item.freeOn].flatMap((label) => {
      const provider = normalizeProvider(undefined, label);
      return provider ? [provider] : [];
    }))];
    const popularity = Math.max(0, rows.length - index);
    return {
      id: titleId(item, index),
      title: item.title,
      ...(item.year !== undefined ? { year: item.year } : {}),
      mediaType: item.type === "MOVIE" ? "movie" : "series",
      ...(item.tmdbId !== undefined ? { tmdbId: item.tmdbId } : {}),
      ...(item.imdbId ? { imdbId: item.imdbId } : {}),
      ...(item.originalLanguage ? { originalLanguage: item.originalLanguage } : {}),
      originCountries: [],
      genreIds: [],
      ...(item.genres.length > 0 ? { genreLabels: item.genres } : {}),
      ...(item.poster ? { posterUrl: item.poster } : {}),
      popularity,
      ...(providers.length > 0 ? { providerIds: providers.map((provider) => provider.id) } : {}),
      ...(providers.length > 0 ? { providerLabels: providers.map((provider) => provider.label) } : {}),
    } satisfies CatalogTitle;
  });
}

function mappedChartTitles(rows: ApifyChartRow[]): CatalogTitle[] {
  return rows.map((item) => {
    const provider = normalizeProvider(undefined, item.platform);
    const slug = item.titleSlug ?? item.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return {
      id: `apify:flixpatrol:${provider?.id ?? "unknown"}:${item.type.toLowerCase()}:${slug}`,
      title: item.title,
      mediaType: item.type === "MOVIE" ? "movie" : "series",
      originCountries: [],
      genreIds: [],
      ...(item.genres.length > 0 ? { genreLabels: item.genres } : {}),
      ...(item.poster ? { posterUrl: item.poster } : {}),
      popularity: item.points ?? Math.max(1, rows.length - item.rank + 1),
      ...(provider ? { providerIds: [provider.id], providerLabels: [provider.label] } : {}),
    } satisfies CatalogTitle;
  });
}

function normalizedChartProviders(rows: ApifyChartRow[]): NormalizedProvider[] {
  return [...new Map(rows.flatMap((row) => {
    const provider = normalizeProvider(undefined, row.platform);
    return provider ? [[provider.id, provider] as const] : [];
  })).values()];
}

function mappedCommunityTitles(rows: ApifyCommunityRow[]): CatalogTitle[] {
  return rows.map((item, index) => {
    const slug = item.url?.match(/\/film\/([^/]+)/)?.[1] ??
      item.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    return {
      id: `apify:letterboxd:movie:${slug}:${item.year ?? "unknown"}:${index}`,
      title: item.title,
      ...(item.year !== undefined ? { year: item.year } : {}),
      mediaType: "movie",
      originCountries: [],
      genreIds: [],
      ...(item.poster ? { posterUrl: item.poster } : {}),
      popularity: Math.max(1, rows.length - index),
    } satisfies CatalogTitle;
  });
}

export interface ApifyAdapterOptions {
  config: Config;
  ledger: Pick<RequestLedger, "recordAttempt" | "canSpend">;
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchImpl;
  now?: () => number;
  retries?: number;
  sleepImpl?: SleepImpl;
}

async function apifyResponseError(response: Response, apiToken: string): Promise<HttpError> {
  const status = response.status;
  let detail: string | undefined;
  try {
    const payload: unknown = await response.json();
    const error = isRecord(payload) && isRecord(payload.error) ? payload.error : undefined;
    const type = error ? text(error.type) : undefined;
    const message = error ? text(error.message) : isRecord(payload) ? text(payload.message) : undefined;
    detail = [type, message].filter(Boolean).join(": ");
  } catch {
    await disposeResponse(response);
  }
  const safeDetail = detail ? sanitizeDiscoveryText(detail, [apiToken]).slice(0, 500) : undefined;
  return new HttpError(
    status,
    `Apify Actor request failed (HTTP ${status})${safeDetail ? `: ${safeDetail}` : ""}`,
  );
}

export function createApifyAdapter(options: ApifyAdapterOptions): DiscoveryAdapter {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  return {
    id: "apify",
    label: "Apify Streaming Catalog",
    capabilities: {
      features: ["provider_popularity", "streaming_charts", "community_popularity"],
      mediaTypes: ["movie", "series"],
      regions: ["IN", "ZZ"],
    },
    isEnabled: () => isDiscoveryAdapterEnabled(options.config, "apify"),
    isConfigured: () => isDiscoveryAdapterEnabled(options.config, "apify") &&
      resolveApifyCredential(options.config, env).source !== "none",
    fetch: async (request, fetchOptions) => {
      validateDiscoveryRequest(request);
      if (!isDiscoveryAdapterEnabled(options.config, "apify")) {
        throw new HttpError(403, "Apify discovery adapter is disabled");
      }
      const community = request.feedKind === "community_popular";
      if (
        (!community && request.region !== "IN") ||
        (community && request.region !== "ZZ") ||
        (request.feedKind !== "provider_popular" &&
          request.feedKind !== "streaming_charts" &&
          !community)
      ) {
        throw new ApifyContractError("Apify adapter supports India streaming signals and global community popularity");
      }
      const credential = resolveApifyCredential(options.config, env);
      if (!credential.apiToken) throw new HttpError(401, "Apify is not configured");
      const charts = request.feedKind === "streaming_charts";
      const endpoint = community ? "community-popular" : charts ? "streaming-charts" : "provider-popular";
      const budget = await options.ledger.canSpend("apify", endpoint);
      if (budget.warning && !budget.allowed) throw new DiscoveryBudgetExceededError(budget);
      await options.ledger.recordAttempt("apify", endpoint);
      const provider = request.providerIds[0]
        ? (charts
            ? chartActorPlatform(request.providerIds[0])
            : actorProviderCode(request.providerIds[0]))
        : undefined;
      if (charts && !provider) {
        throw new ApifyContractError("India charts require one supported provider");
      }
      const actor = community
        ? APIFY_LETTERBOXD_ACTOR
        : charts
          ? APIFY_FLIXPATROL_ACTOR
          : APIFY_STREAMING_CATALOG_ACTOR;
      let response: Response;
      try {
        response = await fetchResilient(
          `${APIFY_API_BASE_URL}/acts/${actor.replace("/", "~")}/run-sync-get-dataset-items?token=${encodeURIComponent(credential.apiToken)}${charts ? `&maxItems=20&maxTotalChargeUsd=${APIFY_FLIXPATROL_MAX_CHARGE_USD}` : community ? `&maxItems=40&maxTotalChargeUsd=${APIFY_LETTERBOXD_MAX_CHARGE_USD}` : ""}`,
          {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              "user-agent": USER_AGENT,
              authorization: `Bearer ${credential.apiToken}`,
            },
            body: JSON.stringify(community
              ? {
                  mode: "popular_films",
                  category: "this-week",
                  maxResults: 40,
                }
              : charts
              ? {
                  platform: provider,
                  country: "india",
                  contentType: "both",
                  date: "today",
                  maxItems: 20,
                }
              : {
                  mode: "popular",
                  country: "IN",
                  count: Math.min(40, Math.max(1, request.pageLimit * 20)),
                  ...(provider ? { providers: [provider] } : {}),
                }),
            fetchImpl: fetchOptions.fetchImpl,
            signal: fetchOptions.signal,
            // Retrying a paid Actor POST can start and charge a duplicate run.
            retries: options.retries ?? 0,
            sleepImpl: options.sleepImpl,
          },
        );
      } catch (error) {
        const message = error instanceof Error
          ? sanitizeDiscoveryText(error.message, [credential.apiToken])
          : "Apify Actor request failed (network)";
        if (error instanceof HttpError) {
          throw new HttpError(error.status, message || "Apify Actor request failed", error.retryAfterMs);
        }
        const safe = new Error(message || "Apify Actor request failed (network)");
        safe.name = error instanceof Error ? sanitizeDiscoveryText(error.name) || "Error" : "Error";
        throw safe;
      }
      if (!response.ok) {
        throw await apifyResponseError(response, credential.apiToken);
      }
      const payload = await response.json();
      const parsed = community
        ? parseApifyCommunityResponse(payload)
        : charts
          ? parseApifyChartResponse(payload)
          : parseApifyPopularResponse(payload);
      const titles = community
        ? mappedCommunityTitles(parsed.rows as ApifyCommunityRow[])
        : charts
          ? mappedChartTitles(parsed.rows as ApifyChartRow[])
          : mappedTitles(parsed.rows as ApifyPopularRow[]);
      const providers = community
        ? []
        : charts
          ? normalizedChartProviders(parsed.rows as ApifyChartRow[])
          : normalizedProviders(parsed.rows as ApifyPopularRow[]);
      const warnings = [...parsed.warnings];
      if (!charts && request.providerIds.length > 0 && !provider) {
        warnings.push({
          code: "unsupported-provider-filter",
          message: `Apify popular mode does not have a mapped provider code for ${request.providerIds[0]}`,
        });
      }
      return sanitizeDiscoverySnapshot({
        source: "apify",
        feedKind: request.feedKind,
        titles,
        events: [],
        fetchedAt: now(),
        warnings,
        attribution: community
          ? APIFY_LETTERBOXD_ATTRIBUTION
          : charts
            ? APIFY_FLIXPATROL_ATTRIBUTION
            : APIFY_ATTRIBUTION,
        providers,
      }, [credential.apiToken]);
    },
  };
}
