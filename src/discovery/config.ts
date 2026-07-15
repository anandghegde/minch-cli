import type { Config, DiscoveryAdapterId, ImdbRatingProvider } from "../config/config";

export const TMDB_READ_TOKEN_ENV = "TMDB_READ_TOKEN";
export const TMDB_API_BASE_URL = "https://api.themoviedb.org/3";
export const STREAMING_AVAILABILITY_API_KEY_ENV = "STREAMING_AVAILABILITY_API_KEY";
export const STREAMING_AVAILABILITY_API_BASE_URL = "https://api.movieofthenight.com/v4";
export const MDBLIST_API_KEY_ENV = "MDBLIST_API_KEY";
export const APIFY_API_TOKEN_ENV = "APIFY_API_TOKEN";
export const APIFY_API_BASE_URL = "https://api.apify.com/v2";
export const FIRECRAWL_API_KEY_ENV = "FIRECRAWL_API_KEY";
export const FIRECRAWL_API_BASE_URL = "https://api.firecrawl.dev";
export const TAMILMV_DEFAULT_BASE_URL = "https://www.1tamilmv.reisen/";

export const TMDB_CONFIG_DESCRIPTOR = {
  id: "tmdb",
  label: "TMDB",
  envVar: TMDB_READ_TOKEN_ENV,
  configPath: "discovery.tmdb.readToken",
  probeUrl: `${TMDB_API_BASE_URL}/authentication`,
} as const;

export const STREAMING_AVAILABILITY_CONFIG_DESCRIPTOR = {
  id: "streaming-availability",
  label: "Streaming Availability API by Movie of the Night",
  envVar: STREAMING_AVAILABILITY_API_KEY_ENV,
  configPath: "discovery.streamingAvailability.apiKey",
  baseUrl: STREAMING_AVAILABILITY_API_BASE_URL,
  headerName: "X-API-Key",
} as const;

export type DiscoveryCredentialSource = "env" | "config" | "none";

export interface ResolvedTmdbCredential {
  token?: string;
  source: DiscoveryCredentialSource;
}

export interface ResolvedStreamingAvailabilityCredential {
  apiKey?: string;
  source: DiscoveryCredentialSource;
}

export interface ResolvedMdblistCredential {
  apiKey?: string;
  source: DiscoveryCredentialSource;
}

export interface ResolvedApifyCredential {
  apiToken?: string;
  source: DiscoveryCredentialSource;
}

export interface ResolvedFirecrawlCredential {
  apiKey?: string;
  source: DiscoveryCredentialSource;
}

export interface TmdbCredentialProbe {
  ok: boolean;
  code: "ok" | "unauthorized" | "http" | "network";
  status?: number;
}

export function isDiscoveryAdapterEnabled(
  config: Config,
  source: DiscoveryAdapterId,
): boolean {
  return !config.discovery?.disabledSources?.includes(source);
}

export function withDiscoveryAdapterEnabled(
  config: Config,
  source: DiscoveryAdapterId,
  enabled: boolean,
): Config {
  const discovery = { ...(config.discovery ?? {}) };
  const disabled = new Set(discovery.disabledSources ?? []);
  if (enabled) disabled.delete(source);
  else disabled.add(source);
  if (disabled.size > 0) discovery.disabledSources = [...disabled];
  else delete discovery.disabledSources;
  return {
    ...config,
    discovery: Object.keys(discovery).length > 0 ? discovery : undefined,
  };
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

export function resolveTmdbCredential(
  config: Config,
  env: Record<string, string | undefined> = process.env,
): ResolvedTmdbCredential {
  const fromEnv = clean(env[TMDB_READ_TOKEN_ENV]);
  if (fromEnv) return { token: fromEnv, source: "env" };
  const fromConfig = clean(config.discovery?.tmdb?.readToken);
  if (fromConfig) return { token: fromConfig, source: "config" };
  return { source: "none" };
}

export function withTmdbReadToken(config: Config, token: string | undefined): Config {
  const readToken = clean(token);
  if (readToken) {
    return {
      ...config,
      discovery: {
        ...(config.discovery ?? {}),
        tmdb: { readToken },
      },
    };
  }
  const discovery = { ...(config.discovery ?? {}) };
  delete discovery.tmdb;
  return {
    ...config,
    discovery: Object.keys(discovery).length > 0 ? discovery : undefined,
  };
}

export function resolveStreamingAvailabilityCredential(
  config: Config,
  env: Record<string, string | undefined> = process.env,
): ResolvedStreamingAvailabilityCredential {
  const fromEnv = clean(env[STREAMING_AVAILABILITY_API_KEY_ENV]);
  if (fromEnv) return { apiKey: fromEnv, source: "env" };
  const fromConfig = clean(config.discovery?.streamingAvailability?.apiKey);
  if (fromConfig) return { apiKey: fromConfig, source: "config" };
  return { source: "none" };
}

export function withStreamingAvailabilityApiKey(
  config: Config,
  apiKey: string | undefined,
): Config {
  const cleaned = clean(apiKey);
  if (cleaned) {
    return {
      ...config,
      discovery: {
        ...(config.discovery ?? {}),
        streamingAvailability: { apiKey: cleaned },
      },
    };
  }
  const discovery = { ...(config.discovery ?? {}) };
  delete discovery.streamingAvailability;
  return {
    ...config,
    discovery: Object.keys(discovery).length > 0 ? discovery : undefined,
  };
}

export function resolveApifyCredential(
  config: Config,
  env: Record<string, string | undefined> = process.env,
): ResolvedApifyCredential {
  const fromEnv = clean(env[APIFY_API_TOKEN_ENV]);
  if (fromEnv) return { apiToken: fromEnv, source: "env" };
  const fromConfig = clean(config.discovery?.apify?.apiToken);
  if (fromConfig) return { apiToken: fromConfig, source: "config" };
  return { source: "none" };
}

export function withApifyApiToken(config: Config, apiToken: string | undefined): Config {
  const cleaned = clean(apiToken);
  if (cleaned) {
    return {
      ...config,
      discovery: { ...(config.discovery ?? {}), apify: { apiToken: cleaned } },
    };
  }
  const discovery = { ...(config.discovery ?? {}) };
  delete discovery.apify;
  return {
    ...config,
    discovery: Object.keys(discovery).length > 0 ? discovery : undefined,
  };
}

export function resolveFirecrawlCredential(
  config: Config,
  env: Record<string, string | undefined> = process.env,
): ResolvedFirecrawlCredential {
  const fromEnv = clean(env[FIRECRAWL_API_KEY_ENV]);
  if (fromEnv) return { apiKey: fromEnv, source: "env" };
  const fromConfig = clean(config.discovery?.firecrawl?.apiKey);
  if (fromConfig) return { apiKey: fromConfig, source: "config" };
  return { source: "none" };
}

export function withFirecrawlApiKey(config: Config, apiKey: string | undefined): Config {
  const cleaned = clean(apiKey);
  if (cleaned) {
    return {
      ...config,
      discovery: { ...(config.discovery ?? {}), firecrawl: { apiKey: cleaned } },
    };
  }
  const discovery = { ...(config.discovery ?? {}) };
  delete discovery.firecrawl;
  return {
    ...config,
    discovery: Object.keys(discovery).length > 0 ? discovery : undefined,
  };
}

export function resolveTamilmvBaseUrl(config: Config): string {
  const configured = clean(config.discovery?.tamilmv?.baseUrl);
  if (configured) {
    try {
      const url = new URL(configured);
      if (url.protocol === "https:") return url.href;
    } catch {
      // fall through to default
    }
  }
  return TAMILMV_DEFAULT_BASE_URL;
}

export function resolveMdblistCredential(
  config: Config,
  env: Record<string, string | undefined> = process.env,
): ResolvedMdblistCredential {
  const fromEnv = clean(env[MDBLIST_API_KEY_ENV]);
  if (fromEnv) return { apiKey: fromEnv, source: "env" };
  const fromConfig = clean(config.discovery?.mdblist?.apiKey);
  if (fromConfig) return { apiKey: fromConfig, source: "config" };
  return { source: "none" };
}

export function withMdblistApiKey(config: Config, apiKey: string | undefined): Config {
  const cleaned = clean(apiKey);
  if (cleaned) return { ...config, discovery: { ...(config.discovery ?? {}), mdblist: { apiKey: cleaned } } };
  const discovery = { ...(config.discovery ?? {}) };
  delete discovery.mdblist;
  return { ...config, discovery: Object.keys(discovery).length > 0 ? discovery : undefined };
}

export function withDiscoveryRatingProvider(
  config: Config,
  ratingProvider: ImdbRatingProvider,
): Config {
  const discovery = { ...(config.discovery ?? {}) };
  if (ratingProvider === "off") delete discovery.ratingProvider;
  else discovery.ratingProvider = ratingProvider;
  return { ...config, discovery: Object.keys(discovery).length > 0 ? discovery : undefined };
}

/** One body-free authenticated request; response/error text is never exposed. */
export async function probeTmdbCredential(
  token: string,
  options: { fetchImpl: typeof fetch; signal?: AbortSignal },
): Promise<TmdbCredentialProbe> {
  const cleaned = clean(token);
  if (!cleaned) return { ok: false, code: "unauthorized" };
  try {
    const response = await options.fetchImpl(TMDB_CONFIG_DESCRIPTOR.probeUrl, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${cleaned}`,
      },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    await response.body?.cancel().catch(() => {});
    if (response.ok) return { ok: true, code: "ok", status: response.status };
    return {
      ok: false,
      code: response.status === 401 ? "unauthorized" : "http",
      status: response.status,
    };
  } catch {
    return { ok: false, code: "network" };
  }
}
