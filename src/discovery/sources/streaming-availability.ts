import type { Config } from "../../config/config";
import type {
  DiscoveryAdapter,
  DiscoveryAttribution,
  DiscoverySnapshot,
  DiscoveryWarning,
} from "../adapter";
import {
  DiscoveryBudgetExceededError,
  type RequestLedger,
} from "../budget";
import {
  isDiscoveryAdapterEnabled,
  resolveStreamingAvailabilityCredential,
  STREAMING_AVAILABILITY_API_BASE_URL,
} from "../config";
import {
  normalizeLanguage,
  normalizeProvider,
  type NormalizedProvider,
} from "../normalize";
import { validateDiscoveryRequest } from "../request";
import { sanitizeDiscoverySnapshot, sanitizeDiscoveryText } from "../security";
import { indiaToday, parseDateOnly, statusForDate } from "../dates";
import type { CatalogTitle, MediaType, ReleaseEvent } from "../types";
import {
  disposeResponse,
  fetchResilient,
  HttpError,
  USER_AGENT,
  type FetchImpl,
  type SleepImpl,
} from "../../util/net";

export class StreamingAvailabilityContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamingAvailabilityContractError";
  }
}

export const STREAMING_AVAILABILITY_ATTRIBUTION: DiscoveryAttribution = {
  source: "streaming-availability",
  sourceLabel: "Streaming Availability API by Movie of the Night",
  sourceUrl: "https://www.movieofthenight.com/about/api",
  notice: "Streaming availability data by Movie of the Night.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export interface StreamingCountryResult {
  countryCode: string;
  name: string;
  providers: NormalizedProvider[];
  warnings: DiscoveryWarning[];
}

export interface StreamingChange {
  changeType: "new" | "updated" | "removed" | "expiring" | "upcoming";
  itemType: "show" | "season" | "episode";
  showId: string;
  showType?: "movie" | "series";
  serviceId: string;
  serviceName: string;
  timestamp?: number;
  streamingOptionType?: string;
  link?: string;
  audioLanguages?: string[];
  subtitleLanguages?: string[];
}

export interface StreamingShow {
  id: string;
  title: string;
  showType: "movie" | "series";
  releaseYear?: number;
  firstAirYear?: number;
  imdbId?: string;
  tmdbId?: string;
  originalTitle?: string;
  originalLanguage?: string;
  originCountries: string[];
  genreIds: number[];
  genreLabels: string[];
  images?: NonNullable<CatalogTitle["images"]>;
  rating?: number;
}

export interface StreamingChangesPage {
  changes: StreamingChange[];
  shows: Record<string, StreamingShow>;
  hasMore: boolean;
  nextCursor?: string;
  warnings: DiscoveryWarning[];
}

export function parseStreamingCountry(value: unknown): StreamingCountryResult {
  if (!isRecord(value) || !Array.isArray(value.services)) {
    throw new StreamingAvailabilityContractError("country response is malformed");
  }
  const countryCode = typeof value.countryCode === "string" ? value.countryCode.toLowerCase() : "";
  const name = typeof value.name === "string" ? sanitizeDiscoveryText(value.name) : "";
  if (!/^[a-z]{2}$/.test(countryCode) || !name) {
    throw new StreamingAvailabilityContractError("country response lacks identity");
  }
  const providers: NormalizedProvider[] = [];
  const warnings: DiscoveryWarning[] = [];
  for (const [index, service] of value.services.entries()) {
    if (!isRecord(service)) {
      warnings.push({ code: "malformed-provider", message: `Skipped malformed service ${index}` });
      continue;
    }
    const id = typeof service.id === "string" || typeof service.id === "number"
      ? service.id
      : undefined;
    const label = typeof service.name === "string" ? service.name : undefined;
    const provider = normalizeProvider(id, label);
    if (provider) providers.push(provider);
    else warnings.push({ code: "malformed-provider", message: `Skipped malformed service ${index}` });
  }
  return { countryCode, name, providers, warnings };
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = sanitizeDiscoveryText(value);
  return cleaned || undefined;
}

function safeHttps(value: unknown): string | undefined {
  const raw = nonEmptyString(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function distinct<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function languageCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return distinct(value.flatMap((entry) => {
    const raw = typeof entry === "string"
      ? entry
      : isRecord(entry)
        ? nonEmptyString(entry.language) ??
          nonEmptyString(entry.code) ??
          nonEmptyString(entry.iso_639_1)
        : undefined;
    const normalized = normalizeLanguage(raw);
    return normalized ? [normalized.code] : [];
  }));
}

function countryCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return distinct(value.flatMap((entry) => {
    const raw = typeof entry === "string"
      ? entry
      : isRecord(entry)
        ? nonEmptyString(entry.countryCode) ?? nonEmptyString(entry.iso_3166_1)
        : undefined;
    const code = raw?.toUpperCase();
    return code && /^[A-Z]{2}$/.test(code) ? [code] : [];
  }));
}

function genres(value: unknown): { ids: number[]; labels: string[] } {
  if (!Array.isArray(value)) return { ids: [], labels: [] };
  const ids: number[] = [];
  const labels: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const label = nonEmptyString(entry);
      if (label) labels.push(label);
      continue;
    }
    if (!isRecord(entry)) continue;
    if (typeof entry.id === "number" && Number.isInteger(entry.id)) ids.push(entry.id);
    const label = nonEmptyString(entry.name);
    if (label) labels.push(label);
  }
  return { ids: distinct(ids), labels: distinct(labels) };
}

function imageUrl(value: unknown): string | undefined {
  const direct = safeHttps(value);
  if (direct) return direct;
  if (!isRecord(value)) return undefined;
  const candidates = Object.values(value).flatMap((entry) => {
    const url = safeHttps(entry);
    return url ? [url] : [];
  });
  return candidates.at(-1);
}

function showImages(value: unknown): NonNullable<CatalogTitle["images"]> | undefined {
  if (!isRecord(value)) return undefined;
  const images = {
    verticalPoster: imageUrl(value.verticalPoster),
    horizontalPoster: imageUrl(value.horizontalPoster),
    horizontalBackdrop: imageUrl(value.horizontalBackdrop),
    verticalBackdrop: imageUrl(value.verticalBackdrop),
  };
  const present = Object.entries(images).filter(
    (entry): entry is [keyof typeof images, string] => entry[1] !== undefined,
  );
  return present.length > 0 ? Object.fromEntries(present) : undefined;
}

export function parseStreamingChangesPage(value: unknown): StreamingChangesPage {
  if (
    !isRecord(value) ||
    !Array.isArray(value.changes) ||
    !isRecord(value.shows) ||
    typeof value.hasMore !== "boolean"
  ) {
    throw new StreamingAvailabilityContractError("changes response is malformed");
  }
  const warnings: DiscoveryWarning[] = [];
  const shows: Record<string, StreamingShow> = {};
  for (const [key, raw] of Object.entries(value.shows)) {
    const dictionaryKey = nonEmptyString(key) ?? "unknown";
    if (!isRecord(raw)) {
      warnings.push({ code: "malformed-show", message: `Skipped malformed show ${dictionaryKey}` });
      continue;
    }
    const id = nonEmptyString(raw.id) ?? dictionaryKey;
    const title = nonEmptyString(raw.title);
    const showType = raw.showType === "movie" || raw.showType === "series"
      ? raw.showType
      : undefined;
    if (!id || !title || !showType) {
      warnings.push({ code: "malformed-show", message: `Skipped malformed show ${dictionaryKey}` });
      continue;
    }
    const releaseYear = Number.isInteger(raw.releaseYear) ? Number(raw.releaseYear) : undefined;
    const firstAirYear = Number.isInteger(raw.firstAirYear) ? Number(raw.firstAirYear) : undefined;
    const imdbId = nonEmptyString(raw.imdbId);
    const tmdbId = nonEmptyString(raw.tmdbId);
    const originalTitle = nonEmptyString(raw.originalTitle);
    const originalLanguage = normalizeLanguage(nonEmptyString(raw.originalLanguage))?.code;
    const originCountries = countryCodes(raw.countries ?? raw.originCountries);
    const parsedGenres = genres(raw.genres);
    const images = showImages(raw.imageSet);
    const rating = typeof raw.rating === "number" && Number.isFinite(raw.rating) &&
      raw.rating >= 0 && raw.rating <= 100 ? raw.rating : undefined;
    shows[dictionaryKey] = {
      id,
      title,
      showType,
      ...(releaseYear ? { releaseYear } : {}),
      ...(firstAirYear ? { firstAirYear } : {}),
      ...(imdbId ? { imdbId } : {}),
      ...(tmdbId ? { tmdbId } : {}),
      ...(originalTitle ? { originalTitle } : {}),
      ...(originalLanguage ? { originalLanguage } : {}),
      originCountries,
      genreIds: parsedGenres.ids,
      genreLabels: parsedGenres.labels,
      ...(images ? { images } : {}),
      ...(rating !== undefined ? { rating } : {}),
    };
  }

  const changes: StreamingChange[] = [];
  for (const [index, raw] of value.changes.entries()) {
    if (!isRecord(raw) || !isRecord(raw.service)) {
      warnings.push({ code: "malformed-change", message: `Skipped malformed change ${index}` });
      continue;
    }
    const changeType = ["new", "updated", "removed", "expiring", "upcoming"].includes(String(raw.changeType))
      ? raw.changeType as StreamingChange["changeType"]
      : undefined;
    const itemType = ["show", "season", "episode"].includes(String(raw.itemType))
      ? raw.itemType as StreamingChange["itemType"]
      : undefined;
    const showId = typeof raw.showId === "string" || typeof raw.showId === "number"
      ? nonEmptyString(String(raw.showId))
      : undefined;
    const serviceId = typeof raw.service.id === "string" || typeof raw.service.id === "number"
      ? nonEmptyString(String(raw.service.id))
      : undefined;
    const serviceName = nonEmptyString(raw.service.name);
    const timestamp = typeof raw.timestamp === "number" && Number.isFinite(raw.timestamp)
      && raw.timestamp >= 1_000_000_000 && raw.timestamp < 100_000_000_000
      ? Math.floor(raw.timestamp)
      : undefined;
    const pastChange = changeType === "new" || changeType === "updated" || changeType === "removed";
    if (
      !changeType ||
      !itemType ||
      !showId ||
      !serviceId ||
      !serviceName ||
      (pastChange && timestamp === undefined)
    ) {
      warnings.push({ code: "malformed-change", message: `Skipped malformed change ${index}` });
      continue;
    }
    const showType = raw.showType === "movie" || raw.showType === "series"
      ? raw.showType
      : undefined;
    const streamingOptionType = nonEmptyString(raw.streamingOptionType);
    const link = safeHttps(raw.link);
    const audioLanguages = languageCodes(raw.audios ?? raw.audioLanguages);
    const subtitleLanguages = languageCodes(raw.subtitles ?? raw.subtitleLanguages);
    changes.push({
      changeType,
      itemType,
      showId,
      ...(showType ? { showType } : {}),
      serviceId,
      serviceName,
      ...(timestamp !== undefined ? { timestamp } : {}),
      ...(streamingOptionType ? { streamingOptionType } : {}),
      ...(link ? { link } : {}),
      ...(audioLanguages.length > 0 ? { audioLanguages } : {}),
      ...(subtitleLanguages.length > 0 ? { subtitleLanguages } : {}),
    });
  }
  const nextCursor = nonEmptyString(value.nextCursor);
  return {
    changes,
    shows,
    hasMore: value.hasMore,
    ...(nextCursor ? { nextCursor } : {}),
    warnings,
  };
}

export function indiaDateStartUnixSeconds(date: string): number {
  const parsed = parseDateOnly(date);
  if (!parsed) throw new StreamingAvailabilityContractError("invalid India start date");
  return Math.floor(
    (Date.UTC(parsed.year, parsed.month - 1, parsed.day, 0, 0, 0) - 5.5 * 60 * 60 * 1_000) /
      1_000,
  );
}

export interface StreamingAvailabilityClientOptions {
  apiKey: string;
  fetchImpl: typeof fetch;
  ledger: Pick<RequestLedger, "recordAttempt">;
  retries?: number;
  sleepImpl?: SleepImpl;
}

export interface StreamingAvailabilityClient {
  getJson(
    path: string,
    params: Record<string, string | number | boolean | undefined>,
    endpoint: string,
    signal?: AbortSignal,
  ): Promise<unknown>;
}

/** Fixed developer-platform transport; no host/header selector or marketplace fallback exists. */
export function createStreamingAvailabilityClient(
  options: StreamingAvailabilityClientOptions,
): StreamingAvailabilityClient {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new TypeError("Streaming Availability API key is required");

  async function getJson(
    path: string,
    params: Record<string, string | number | boolean | undefined>,
    endpoint: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!/^\/[a-z0-9/-]+$/i.test(path) || path.includes("..")) {
      throw new StreamingAvailabilityContractError("invalid direct API path");
    }
    const url = new URL(path.slice(1), `${STREAMING_AVAILABILITY_API_BASE_URL}/`);
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(name, String(value));
    }
    const meteredFetch: FetchImpl = async (target, init) => {
      await options.ledger.recordAttempt("streaming-availability", endpoint);
      return options.fetchImpl(target, init);
    };
    let response: Response;
    try {
      response = await fetchResilient(url.href, {
        fetchImpl: meteredFetch,
        retries: options.retries ?? 1,
        ...(options.sleepImpl ? { sleepImpl: options.sleepImpl } : {}),
        signal,
        headers: {
          accept: "application/json",
          "user-agent": USER_AGENT,
          "x-api-key": apiKey,
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
          `Streaming Availability request failed (HTTP ${error.status})`,
          error.retryAfterMs,
        );
      }
      if (error instanceof Error) {
        const safe = new Error(
          sanitizeDiscoveryText(error.message, [apiKey]) ||
            "Streaming Availability request failed (network)",
        );
        safe.name = sanitizeDiscoveryText(error.name) || "Error";
        throw safe;
      }
      throw new HttpError(0, "Streaming Availability request failed (network)");
    }
    if (!response.ok) {
      await disposeResponse(response);
      throw new HttpError(
        response.status,
        `Streaming Availability request failed (HTTP ${response.status})`,
      );
    }
    try {
      return await response.json() as unknown;
    } catch {
      throw new StreamingAvailabilityContractError(
        "Streaming Availability response was not valid JSON",
      );
    }
  }

  return { getJson };
}

export interface StreamingAvailabilityAdapterOptions {
  config: Config;
  ledger: Pick<RequestLedger, "recordAttempt" | "canSpend">;
  env?: Record<string, string | undefined>;
  now?: () => number;
  retries?: number;
  sleepImpl?: SleepImpl;
}

export const UPCOMING_SUPPORTED_PROVIDER_IDS = new Set([
  "apple",
  "disney",
  "hbo",
  "mubi",
  "netflix",
  "prime",
]);

export const STREAMING_RESUME_OVERLAP_SECONDS = 60 * 60;

export function streamingResumeFromUnixSeconds(
  snapshot: Pick<DiscoverySnapshot, "resume">,
): number | undefined {
  if (!snapshot.resume) return undefined;
  return Math.max(
    0,
    snapshot.resume.newestTimestampUnixSeconds - snapshot.resume.overlapSeconds,
  );
}

export function createStreamingAvailabilityAdapter(
  options: StreamingAvailabilityAdapterOptions,
): DiscoveryAdapter {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  return {
    id: "streaming-availability",
    label: "Streaming Availability",
    capabilities: {
      features: [
        "provider_dictionary",
        "streaming_changes",
        "streaming_upcoming",
        "cursor_pagination",
      ],
      mediaTypes: ["movie", "series", "season", "episode"],
      regions: ["IN"],
    },
    isEnabled: () =>
      isDiscoveryAdapterEnabled(options.config, "streaming-availability"),
    isConfigured: () =>
      isDiscoveryAdapterEnabled(options.config, "streaming-availability") &&
      resolveStreamingAvailabilityCredential(options.config, env).source !== "none",
    fetch: async (request, fetchOptions) => {
      validateDiscoveryRequest(request);
      if (!isDiscoveryAdapterEnabled(options.config, "streaming-availability")) {
        throw new HttpError(403, "Streaming Availability discovery adapter is disabled");
      }
      if (request.region !== "IN") {
        throw new StreamingAvailabilityContractError("Streaming Availability adapter is restricted to IN");
      }
      const credential = resolveStreamingAvailabilityCredential(options.config, env);
      if (!credential.apiKey) {
        throw new HttpError(401, "Streaming Availability is not configured");
      }
      const apiKey = credential.apiKey;
      const client = createStreamingAvailabilityClient({
        apiKey,
        fetchImpl: fetchOptions.fetchImpl,
        ledger: options.ledger,
        retries: options.retries,
        sleepImpl: options.sleepImpl,
      });
      if (request.feedKind === "provider_dictionary") {
        const country = parseStreamingCountry(
          await client.getJson(
            "/countries/in",
            { output_language: "en" },
            "countries",
            fetchOptions.signal,
          ),
        );
        if (country.countryCode !== "in") {
          throw new StreamingAvailabilityContractError("country response did not describe India");
        }
        return sanitizeDiscoverySnapshot({
          source: "streaming-availability",
          feedKind: request.feedKind,
          titles: [],
          events: [],
          fetchedAt: now(),
          warnings: country.warnings,
          attribution: STREAMING_AVAILABILITY_ATTRIBUTION,
          providers: country.providers,
        } satisfies DiscoverySnapshot, [apiKey]);
      }
      if (
        (request.feedKind !== "streaming_added" && request.feedKind !== "streaming_upcoming") ||
        !request.dateRange
      ) {
        throw new StreamingAvailabilityContractError(
          `Streaming Availability does not support ${request.feedKind} yet`,
        );
      }

      const upcoming = request.feedKind === "streaming_upcoming";
      const upcomingProviders = upcoming
        ? request.providerIds.filter((id) => UPCOMING_SUPPORTED_PROVIDER_IDS.has(id))
        : request.providerIds;
      if (upcoming) {
        const budget = await options.ledger.canSpend(
          "streaming-availability",
          "changes-upcoming",
        );
        if (budget.warning) {
          throw new DiscoveryBudgetExceededError({ ...budget, allowed: false });
        }
        if (upcomingProviders.length === 0) {
          throw new StreamingAvailabilityContractError(
            "upcoming feed requires at least one documented supported provider",
          );
        }
      }

      const observedAt = now();
      const titlesById = new Map<string, CatalogTitle>();
      const events: ReleaseEvent[] = [];
      const eventIds = new Set<string>();
      const warnings: DiscoveryWarning[] = [];
      let cursor = request.cursor;
      let lastCursor: string | undefined;
      let newestTimestampUnixSeconds: number | undefined;
      const seenCursors = new Set<string>(cursor ? [cursor] : []);
      const pageLimit = upcoming ? 1 : request.pageLimit;
      for (let page = 0; page < pageLimit; page += 1) {
        const parsed = parseStreamingChangesPage(
          await client.getJson(
            "/changes",
            {
              country: "in",
              change_type: upcoming ? "upcoming" : "new",
              item_type: "show",
              from: indiaDateStartUnixSeconds(request.dateRange.start),
              ...(upcoming
                ? { to: indiaDateStartUnixSeconds(request.dateRange.end) + 86_399 }
                : {}),
              ...(upcoming ? { include_unknown_dates: true } : {}),
              output_language: "en",
              order_direction: "desc",
              ...(upcomingProviders.length > 0
                ? { catalogs: upcomingProviders.join(",") }
                : {}),
              cursor,
            },
            upcoming ? "changes-upcoming" : "changes",
            fetchOptions.signal,
          ),
        );
        warnings.push(...parsed.warnings);
        for (const change of parsed.changes) {
          if (
            change.changeType !== (upcoming ? "upcoming" : "new") ||
            change.itemType !== "show" ||
            (!upcoming && change.timestamp === undefined)
          ) {
            continue;
          }
          const show = parsed.shows[change.showId];
          if (!show) {
            warnings.push({
              code: "missing-show",
              message: "Skipped change whose show dictionary entry is missing",
              sourceRecordId: change.showId,
            });
            continue;
          }
          const mediaType: MediaType = show.showType === "series" ? "series" : "movie";
          if (request.mediaTypes.length > 0 && !request.mediaTypes.includes(mediaType)) continue;
          const titleId = `streaming-availability:${show.id}`;
          const tmdbIdParts = show.tmdbId?.split("/");
          const tmdbId = tmdbIdParts && Number.isInteger(Number(tmdbIdParts[1]))
            ? Number(tmdbIdParts[1])
            : undefined;
          titlesById.set(titleId, {
            id: titleId,
            title: show.title,
            ...(show.originalTitle ? { originalTitle: show.originalTitle } : {}),
            ...(show.releaseYear ?? show.firstAirYear
              ? { year: show.releaseYear ?? show.firstAirYear }
              : {}),
            mediaType,
            ...(tmdbId ? { tmdbId } : {}),
            ...(show.imdbId ? { imdbId: show.imdbId } : {}),
            ...(show.originalLanguage ? { originalLanguage: show.originalLanguage } : {}),
            originCountries: show.originCountries,
            genreIds: show.genreIds,
            ...(show.genreLabels.length > 0 ? { genreLabels: show.genreLabels } : {}),
            ...(show.images?.verticalPoster ? { posterUrl: show.images.verticalPoster } : {}),
            ...(show.images ? { images: show.images } : {}),
            ...(show.rating !== undefined
              ? { ratings: [{
                  system: "aggregate",
                  provider: "streaming-availability",
                  value: show.rating,
                  scale: 100,
                  observedAt,
                }] }
              : {}),
          });
          const provider = normalizeProvider(change.serviceId, change.serviceName)!;
          const date = change.timestamp === undefined
            ? undefined
            : indiaToday(change.timestamp * 1_000);
          const eventId = [
            "in",
            provider.id,
            change.changeType,
            change.itemType,
            change.showId,
            change.timestamp ?? "unknown",
          ].join(":");
          const normalizedEventId = `streaming-availability:${eventId}`;
          if (eventIds.has(normalizedEventId)) {
            warnings.push({
              code: "duplicate-event",
              message: "Skipped duplicate change event",
              sourceRecordId: eventId,
            });
            continue;
          }
          eventIds.add(normalizedEventId);
          if (
            change.timestamp !== undefined &&
            (newestTimestampUnixSeconds === undefined ||
              change.timestamp > newestTimestampUnixSeconds)
          ) {
            newestTimestampUnixSeconds = change.timestamp;
          }
          events.push({
            id: normalizedEventId,
            titleId,
            kind: upcoming ? "streaming_upcoming" : "streaming_added",
            region: "IN",
            ...(date ? { date } : {}),
            datePrecision: date ? "day" : "unknown",
            providerId: provider.id,
            providerLabel: provider.label,
            ...(change.streamingOptionType ? { accessType: change.streamingOptionType } : {}),
            ...(change.audioLanguages ? { audioLanguages: change.audioLanguages } : {}),
            ...(change.subtitleLanguages ? { subtitleLanguages: change.subtitleLanguages } : {}),
            status: statusForDate(date, indiaToday(observedAt)),
            firstObservedAt: observedAt,
            lastObservedAt: observedAt,
            evidence: [{
              source: "streaming-availability",
              sourceId: eventId,
              ...(change.link ? { sourceUrl: change.link } : {}),
              observedAt,
              confidence: "exact",
            }],
          });
        }
        lastCursor = parsed.hasMore ? parsed.nextCursor : undefined;
        if (!parsed.hasMore || !parsed.nextCursor) break;
        if (seenCursors.has(parsed.nextCursor)) {
          warnings.push({
            code: "repeated-cursor",
            message: "Stopped pagination after the source repeated a cursor",
            sourceRecordId: parsed.nextCursor,
          });
          lastCursor = undefined;
          break;
        }
        seenCursors.add(parsed.nextCursor);
        cursor = parsed.nextCursor;
      }
      return sanitizeDiscoverySnapshot({
        source: "streaming-availability",
        feedKind: request.feedKind,
        titles: [...titlesById.values()],
        events,
        fetchedAt: observedAt,
        ...(lastCursor ? { cursor: lastCursor } : {}),
        ...(newestTimestampUnixSeconds !== undefined
          ? {
              resume: {
                newestTimestampUnixSeconds,
                overlapSeconds: STREAMING_RESUME_OVERLAP_SECONDS,
              },
            }
          : {}),
        warnings,
        attribution: STREAMING_AVAILABILITY_ATTRIBUTION,
      } satisfies DiscoverySnapshot, [apiKey]);
    },
  };
}
