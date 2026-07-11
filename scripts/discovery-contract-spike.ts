import { pathToFileURL } from "node:url";

const TMDB_BASE_URL = "https://api.themoviedb.org";
const STREAMING_DIRECT_BASE_URL = "https://api.movieofthenight.com/v4";
const REQUEST_TIMEOUT_MS = 15_000;
const DAY_MS = 86_400_000;
const MAX_TMDB_CANDIDATES = 3;
const STREAMING_MONTHLY_ALLOWANCE = 500;
const STREAMING_SOFT_WARNING = 350;
const STREAMING_HARD_STOP = 450;

type FetchLike = typeof fetch;
type Environment = Record<string, string | undefined>;

export type StreamingConfig =
  | { status: "unconfigured" }
  | {
      status: "configured";
      key: string;
      baseUrl: typeof STREAMING_DIRECT_BASE_URL;
      headerName: "X-API-Key";
    };

interface ProbeContext {
  fetchImpl: FetchLike;
  now: Date;
  requests: number;
}

export interface ContractSpikeOptions {
  tmdb?: boolean;
  streamingAvailability?: boolean;
}

interface SourceFailure {
  status: "failed";
  requestCount: number;
  error: string;
  retryAfter?: string;
}

class HttpStatusError extends Error {
  readonly retryAfter?: string;

  constructor(status: number, retryAfter?: string | null) {
    super(`HTTP ${status}`);
    this.name = "HttpStatusError";
    if (retryAfter) this.retryAfter = retryAfter;
  }
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveStreamingConfig(env: Environment): StreamingConfig {
  const key = clean(env.STREAMING_AVAILABILITY_API_KEY);
  if (!key) return { status: "unconfigured" };
  return {
    status: "configured",
    key,
    baseUrl: STREAMING_DIRECT_BASE_URL,
    headerName: "X-API-Key",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function scalar(value: unknown): string | number | boolean | null | undefined {
  return value === null || ["string", "number", "boolean"].includes(typeof value)
    ? (value as string | number | boolean | null)
    : undefined;
}

function stringId(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function buildUrl(
  baseUrl: string,
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
): URL {
  const url = new URL(path.replace(/^\/+/, ""), `${baseUrl.replace(/\/+$/, "")}/`);
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(name, String(value));
  }
  return url;
}

async function requestJson(
  context: ProbeContext,
  url: URL,
  headers: Record<string, string>,
): Promise<unknown> {
  context.requests += 1;
  const response = await context.fetchImpl(url, {
    headers: {
      accept: "application/json",
      "user-agent": "minch-cli-contract-spike/0.1",
      ...headers,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new HttpStatusError(response.status, response.headers.get("retry-after"));
  }
  return response.json() as Promise<unknown>;
}

function redact(message: string, secrets: string[]): string {
  return secrets.reduce(
    (safe, secret) => (secret ? safe.split(secret).join("[redacted]") : safe),
    message,
  );
}

function safeError(
  error: unknown,
  secrets: string[] = [],
): Pick<SourceFailure, "error" | "retryAfter"> {
  if (error instanceof HttpStatusError) {
    return {
      error: error.message,
      ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    error: redact(message, secrets)
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
      .slice(0, 200),
  };
}

function summarizeDiscover(value: unknown): Record<string, unknown> {
  const root = isRecord(value) ? value : {};
  const results = records(root.results);
  const first = results[0];
  return {
    topLevelKeys: Object.keys(root).sort(),
    page: scalar(root.page),
    totalPages: scalar(root.total_pages),
    totalResults: scalar(root.total_results),
    resultCount: results.length,
    ...(first
      ? {
          firstResultKeys: Object.keys(first).sort(),
          firstResult: {
            id: scalar(first.id),
            title: scalar(first.title),
            releaseDate: scalar(first.release_date),
          },
        }
      : {}),
  };
}

function summarizeReleaseDates(value: unknown): Record<string, unknown> {
  const root = isRecord(value) ? value : {};
  const countries = records(root.results);
  const india = countries.find((entry) => entry.iso_3166_1 === "IN");
  const releaseDates = records(india?.release_dates);
  return {
    topLevelKeys: Object.keys(root).sort(),
    countryCodes: countries
      .map((entry) => (typeof entry.iso_3166_1 === "string" ? entry.iso_3166_1 : undefined))
      .filter((entry): entry is string => !!entry),
    indiaPresent: !!india,
    indiaReleaseCount: releaseDates.length,
    indiaReleaseTypes: [
      ...new Set(
        releaseDates
          .map((entry) => (typeof entry.type === "number" ? entry.type : undefined))
          .filter((entry): entry is number => entry !== undefined),
      ),
    ].sort((a, b) => a - b),
    indiaDates: releaseDates
      .map((entry) => (typeof entry.release_date === "string" ? entry.release_date : undefined))
      .filter((entry): entry is string => !!entry)
      .slice(0, 5),
  };
}

function linkShape(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return { present: false };
  try {
    const url = new URL(value);
    return { present: true, origin: url.origin, path: url.pathname };
  } catch {
    return { present: true, validUrl: false };
  }
}

function summarizeWatchProviders(value: unknown): Record<string, unknown> {
  const root = isRecord(value) ? value : {};
  const resultMap = isRecord(root.results) ? root.results : {};
  const india = isRecord(resultMap.IN) ? resultMap.IN : undefined;
  const bucketNames = ["flatrate", "free", "ads", "rent", "buy"] as const;
  const buckets = Object.fromEntries(
    bucketNames
      .filter((name) => Array.isArray(india?.[name]))
      .map((name) => [name, records(india?.[name]).length]),
  );
  const providers = bucketNames
    .flatMap((name) => records(india?.[name]))
    .map((provider) => ({
      id: scalar(provider.provider_id),
      name: scalar(provider.provider_name),
    }))
    .filter((provider) => provider.id !== undefined || provider.name !== undefined)
    .slice(0, 12);

  return {
    topLevelKeys: Object.keys(root).sort(),
    countryCodes: Object.keys(resultMap).sort(),
    indiaPresent: !!india,
    indiaKeys: india ? Object.keys(india).sort() : [],
    indiaLink: linkShape(india?.link),
    buckets,
    providers,
  };
}

function unwrapCountry(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  if (typeof value.countryCode === "string") return value;
  if (isRecord(value.result) && typeof value.result.countryCode === "string") {
    return value.result;
  }
  if (isRecord(value.in)) return value.in;
  return value;
}

function summarizeCountry(value: unknown): Record<string, unknown> {
  const root = isRecord(value) ? value : {};
  const country = unwrapCountry(value);
  const services = records(country.services);
  return {
    topLevelKeys: Object.keys(root).sort(),
    countryKeys: Object.keys(country).sort(),
    countryCode: scalar(country.countryCode),
    countryName: scalar(country.name),
    serviceCount: services.length,
    services: services.map((service) => ({
      id: scalar(service.id),
      name: scalar(service.name),
    })),
  };
}

function valueShape(value: unknown): string | number | boolean | null | Record<string, unknown> {
  const primitive = scalar(value);
  if (primitive !== undefined) return primitive;
  if (Array.isArray(value)) return { kind: "array", length: value.length };
  if (isRecord(value)) return { kind: "object", keys: Object.keys(value).sort() };
  return { kind: typeof value };
}

function timestampSummary(value: unknown): Record<string, unknown> {
  if (typeof value !== "number" || !Number.isFinite(value)) return { present: false };
  const unit = value >= 1_000_000_000_000 ? "milliseconds" : "seconds";
  const date = new Date(unit === "milliseconds" ? value : value * 1_000);
  return {
    present: true,
    value,
    unit,
    iso: Number.isNaN(date.getTime()) ? null : date.toISOString(),
  };
}

function summarizeChanges(value: unknown): Record<string, unknown> {
  const root = isRecord(value) ? value : {};
  const changes = records(root.changes);
  const shows = isRecord(root.shows) ? root.shows : {};
  const showIds = new Set(Object.keys(shows));
  const first = changes[0];
  const firstShowId = stringId(first?.showId);
  const firstShow = firstShowId && isRecord(shows[firstShowId]) ? shows[firstShowId] : undefined;
  const providerFields = first
    ? Object.fromEntries(
        Object.entries(first)
          .filter(([key]) => /catalog|provider|service/i.test(key))
          .map(([key, fieldValue]) => [key, valueShape(fieldValue)]),
      )
    : {};

  return {
    topLevelKeys: Object.keys(root).sort(),
    changeCount: changes.length,
    showDictionaryKind: isRecord(root.shows) ? "object" : typeof root.shows,
    showCount: showIds.size,
    hasMore: scalar(root.hasMore),
    nextCursor: valueShape(root.nextCursor),
    joinableChangeCount: changes.filter((change) => {
      const id = stringId(change.showId);
      return !!id && showIds.has(id);
    }).length,
    ...(first
      ? {
          firstChangeKeys: Object.keys(first).sort(),
          firstChange: {
            changeType: scalar(first.changeType),
            itemType: scalar(first.itemType),
            showId: firstShowId,
            timestamp: timestampSummary(first.timestamp),
            providerFields,
            service: isRecord(first.service)
              ? { id: scalar(first.service.id), name: scalar(first.service.name) }
              : null,
            streamingOptionType: scalar(first.streamingOptionType),
            link: linkShape(first.link),
          },
        }
      : {}),
    ...(firstShow
      ? {
          firstJoinedShowKeys: Object.keys(firstShow).sort(),
          firstJoinedShow: {
            id: scalar(firstShow.id),
            title: scalar(firstShow.title),
            showType: scalar(firstShow.showType),
            imdbId: scalar(firstShow.imdbId),
            tmdbId: scalar(firstShow.tmdbId),
          },
        }
      : {}),
  };
}

function releaseTitle(entry: Record<string, unknown>): Record<string, unknown> {
  return {
    id: scalar(entry.id),
    title: scalar(entry.title),
    releaseDate: scalar(entry.release_date),
  };
}

async function findIndiaReleaseEvidence(
  context: ProbeContext,
  results: Record<string, unknown>[],
  releaseType: 4 | 5,
  headers: Record<string, string>,
): Promise<Record<string, unknown>> {
  const checkedCandidates: Record<string, unknown>[] = [];
  for (const candidate of results.slice(0, MAX_TMDB_CANDIDATES)) {
    const id = stringId(candidate.id);
    if (!id) continue;
    const raw = await requestJson(
      context,
      buildUrl(TMDB_BASE_URL, `/3/movie/${encodeURIComponent(id)}/release_dates`),
      headers,
    );
    const summary = summarizeReleaseDates(raw);
    const indiaReleaseTypes = Array.isArray(summary.indiaReleaseTypes)
      ? summary.indiaReleaseTypes
      : [];
    const matched = summary.indiaPresent === true && indiaReleaseTypes.includes(releaseType);
    checkedCandidates.push({
      ...releaseTitle(candidate),
      indiaPresent: summary.indiaPresent,
      indiaReleaseTypes,
      matched,
    });
    if (matched) {
      return {
        evidenceComplete: true,
        checkedCandidates,
        selectedTitle: releaseTitle(candidate),
        releaseDates: summary,
      };
    }
  }

  return {
    evidenceComplete: false,
    checkedCandidates,
    selectedTitle: null,
    releaseDates: null,
  };
}

async function findIndiaWatchProviderEvidence(
  context: ProbeContext,
  headers: Record<string, string>,
): Promise<Record<string, unknown>> {
  const discoverRaw = await requestJson(
    context,
    buildUrl(TMDB_BASE_URL, "/3/discover/movie", {
      watch_region: "IN",
      with_watch_monetization_types: "flatrate|free|ads|rent|buy",
      sort_by: "popularity.desc",
      include_adult: false,
      language: "en-US",
      page: 1,
    }),
    headers,
  );
  const results = records(isRecord(discoverRaw) ? discoverRaw.results : undefined);
  const checkedCandidates: Record<string, unknown>[] = [];
  for (const candidate of results.slice(0, MAX_TMDB_CANDIDATES)) {
    const id = stringId(candidate.id);
    if (!id) continue;
    const raw = await requestJson(
      context,
      buildUrl(TMDB_BASE_URL, `/3/movie/${encodeURIComponent(id)}/watch/providers`),
      headers,
    );
    const summary = summarizeWatchProviders(raw);
    const matched = summary.indiaPresent === true;
    checkedCandidates.push({ ...releaseTitle(candidate), indiaPresent: matched });
    if (matched) {
      return {
        evidenceComplete: true,
        discover: summarizeDiscover(discoverRaw),
        checkedCandidates,
        selectedTitle: releaseTitle(candidate),
        watchProviders: summary,
      };
    }
  }

  return {
    evidenceComplete: false,
    discover: summarizeDiscover(discoverRaw),
    checkedCandidates,
    selectedTitle: null,
    watchProviders: null,
  };
}

async function probeTmdb(
  context: ProbeContext,
  token: string,
): Promise<Record<string, unknown> | SourceFailure> {
  const startRequests = context.requests;
  const digitalEnd = formatDate(context.now);
  const digitalStart = formatDate(new Date(context.now.getTime() - 31 * DAY_MS));
  const physicalStart = formatDate(new Date(context.now.getTime() - 730 * DAY_MS));
  const physicalEnd = formatDate(new Date(context.now.getTime() + 365 * DAY_MS));
  const headers = { Authorization: `Bearer ${token}` };

  try {
    const common = {
      region: "IN",
      sort_by: "primary_release_date.desc",
      include_adult: false,
      language: "en-US",
      page: 1,
    };
    const digitalRaw = await requestJson(
      context,
      buildUrl(TMDB_BASE_URL, "/3/discover/movie", {
        ...common,
        "release_date.gte": digitalStart,
        "release_date.lte": digitalEnd,
        with_release_type: 4,
      }),
      headers,
    );
    const physicalRaw = await requestJson(
      context,
      buildUrl(TMDB_BASE_URL, "/3/discover/movie", {
        ...common,
        "release_date.gte": physicalStart,
        "release_date.lte": physicalEnd,
        with_release_type: 5,
      }),
      headers,
    );

    const digitalResults = records(isRecord(digitalRaw) ? digitalRaw.results : undefined);
    const physicalResults = records(isRecord(physicalRaw) ? physicalRaw.results : undefined);
    const digitalReleaseEvidence = await findIndiaReleaseEvidence(
      context,
      digitalResults,
      4,
      headers,
    );
    const physicalReleaseEvidence = await findIndiaReleaseEvidence(
      context,
      physicalResults,
      5,
      headers,
    );
    const watchProviderEvidence = await findIndiaWatchProviderEvidence(context, headers);
    const evidenceComplete =
      digitalReleaseEvidence.evidenceComplete === true &&
      physicalReleaseEvidence.evidenceComplete === true &&
      watchProviderEvidence.evidenceComplete === true;

    return {
      status: "ready",
      evidenceComplete,
      requestCount: context.requests - startRequests,
      windows: {
        digital: { start: digitalStart, end: digitalEnd, inclusive: true },
        physical: { start: physicalStart, end: physicalEnd, inclusive: true },
      },
      digital: summarizeDiscover(digitalRaw),
      physical: summarizeDiscover(physicalRaw),
      digitalReleaseEvidence,
      physicalReleaseEvidence,
      watchProviderEvidence,
      semantics: {
        releaseType4: "digital",
        releaseType5: "physical-not-bluray",
        watchProviders: "current-availability-not-arrival",
      },
    };
  } catch (error) {
    return {
      status: "failed",
      requestCount: context.requests - startRequests,
      ...safeError(error, [token]),
    };
  }
}

async function probeStreamingAvailability(
  context: ProbeContext,
  config: Extract<StreamingConfig, { status: "configured" }>,
): Promise<Record<string, unknown> | SourceFailure> {
  const startRequests = context.requests;
  const headers = { [config.headerName]: config.key };
  const from = Math.floor((context.now.getTime() - 7 * DAY_MS) / 1_000);

  try {
    const countryRaw = await requestJson(
      context,
      buildUrl(config.baseUrl, "/countries/in", { output_language: "en" }),
      headers,
    );
    const changesRaw = await requestJson(
      context,
      buildUrl(config.baseUrl, "/changes", {
        country: "in",
        change_type: "new",
        item_type: "show",
        from,
        output_language: "en",
        order_direction: "desc",
      }),
      headers,
    );
    const country = summarizeCountry(countryRaw);
    const changes = summarizeChanges(changesRaw);
    const changesRoot = isRecord(changesRaw) ? changesRaw : {};
    const firstChange = records(changesRoot.changes)[0];
    const firstService = isRecord(firstChange?.service) ? firstChange.service : undefined;
    const timestamp = firstChange?.timestamp;
    const evidenceComplete =
      country.countryCode === "in" &&
      typeof country.serviceCount === "number" &&
      country.serviceCount > 0 &&
      typeof changes.changeCount === "number" &&
      changes.changeCount > 0 &&
      changes.joinableChangeCount === changes.changeCount &&
      Object.hasOwn(changesRoot, "hasMore") &&
      Object.hasOwn(changesRoot, "nextCursor") &&
      typeof timestamp === "number" &&
      Number.isFinite(timestamp) &&
      firstChange?.changeType === "new" &&
      firstChange.itemType === "show" &&
      (typeof firstService?.id === "string" || typeof firstService?.id === "number");

    return {
      status: "ready",
      evidenceComplete,
      transport: "direct",
      requestCount: context.requests - startRequests,
      country,
      changes,
      from,
      automaticPageLimitForProduction: 4,
      localMonthlyBudget: {
        allowance: STREAMING_MONTHLY_ALLOWANCE,
        softWarning: STREAMING_SOFT_WARNING,
        hardStop: STREAMING_HARD_STOP,
        safetyMargin: STREAMING_MONTHLY_ALLOWANCE - STREAMING_HARD_STOP,
        source: "user-confirmed-local-policy",
      },
      providerPublishedAllowance: "not-exposed-in-response-headers",
    };
  } catch (error) {
    return {
      status: "failed",
      requestCount: context.requests - startRequests,
      ...safeError(error, [config.key]),
    };
  }
}

export async function runContractSpike(
  env: Environment = process.env,
  fetchImpl: FetchLike = fetch,
  now: Date = new Date(),
  options: ContractSpikeOptions = {},
): Promise<Record<string, unknown>> {
  const context: ProbeContext = { fetchImpl, now, requests: 0 };
  const tmdbToken = clean(env.TMDB_READ_TOKEN);
  const streamingConfig = resolveStreamingConfig(env);
  const runTmdb = options.tmdb !== false;
  const runStreaming = options.streamingAvailability !== false;

  const tmdb = !runTmdb
    ? { status: "skipped-option", requestCount: 0 }
    : tmdbToken
      ? await probeTmdb(context, tmdbToken)
      : { status: "unconfigured", requestCount: 0 };

  const streamingAvailability = !runStreaming
    ? { status: "skipped-option", requestCount: 0 }
    : streamingConfig.status === "configured"
      ? await probeStreamingAvailability(context, streamingConfig)
      : { status: "unconfigured", requestCount: 0 };

  const tmdbReady =
    !runTmdb || (isRecord(tmdb) && tmdb.status === "ready" && tmdb.evidenceComplete === true);
  const streamingReady =
    !runStreaming ||
    (isRecord(streamingAvailability) &&
      streamingAvailability.status === "ready" &&
      streamingAvailability.evidenceComplete === true);
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    region: "IN",
    complete: tmdbReady && streamingReady,
    requestedSources: { tmdb: runTmdb, streamingAvailability: runStreaming },
    totalRequestCount: context.requests,
    policy: {
      retries: 0,
      timeoutMs: REQUEST_TIMEOUT_MS,
      rawPayloadsIncluded: false,
      secretsIncluded: false,
    },
    tmdb,
    streamingAvailability,
    trakt: {
      status: "skipped-terms",
      requestCount: 0,
      reason: "ADR 001 requires written approval before any Trakt request.",
    },
    bluray: {
      status: "not-run-by-script",
      requestCount: 0,
      reason: "The one-request-per-24-hours RSS observation is scheduled and recorded separately.",
    },
  };
}

function commandOptions(args: string[]): ContractSpikeOptions {
  if (args.length === 0) return {};
  if (args.length === 1 && args[0] === "--tmdb-only") {
    return { tmdb: true, streamingAvailability: false };
  }
  if (args.length === 1 && args[0] === "--streaming-only") {
    return { tmdb: false, streamingAvailability: true };
  }
  throw new Error("Usage: npm run spike:discovery -- [--tmdb-only|--streaming-only]");
}

async function main(): Promise<void> {
  const report = await runContractSpike(process.env, fetch, new Date(), commandOptions(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  void main().catch((error: unknown) => {
    const safe = safeError(error);
    process.stderr.write(`Discovery contract spike failed: ${safe.error}\n`);
    process.exitCode = 1;
  });
}
