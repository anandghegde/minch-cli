import type { CatalogRating, CatalogTitle } from "../types";
import {
  createCachedRating,
  POSITIVE_IDENTITY_TTL_MS,
  tmdbIdentityKey,
} from "./cache";
import type { RatingsCacheRepository } from "./cache-repository";
import type { RatingsUsageLedger } from "./usage";

export const MDBLIST_API_BASE_URL = "https://api.mdblist.com";
export const MDBLIST_MAX_BATCH = 10;

export interface MdblistBackendOptions {
  apiKey: string;
  repository: RatingsCacheRepository;
  usage: RatingsUsageLedger;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface MdblistBackend {
  lookup(titles: readonly CatalogTitle[], signal?: AbortSignal): Promise<ReadonlyMap<string, CatalogRating>>;
}

interface RequestItem { title: CatalogTitle; provider: "tmdb" | "imdb"; id: string }

function recordArray(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((entry): entry is Record<string, unknown> =>
    !!entry && typeof entry === "object" && !Array.isArray(entry));
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  if (record.provider_id !== undefined || record.provider_rating !== undefined) return [record];
  for (const key of ["ratings", "results", "data"]) {
    if (Array.isArray(record[key])) return recordArray(record[key]);
  }
  return [];
}

function parsedRating(value: Record<string, unknown>, observedAt: number): CatalogRating | undefined {
  const score = value.provider_rating ?? value.rating ?? value.value ?? value.imdb_rating;
  if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > 10) return undefined;
  const nestedImdb = Array.isArray(value.ratings)
    ? value.ratings.find((entry) => entry && typeof entry === "object" &&
        ["imdb", "IMDb"].includes(String((entry as Record<string, unknown>).source ??
          (entry as Record<string, unknown>).name))) as Record<string, unknown> | undefined
    : undefined;
  const rawVotes = value.votes ?? value.vote_count ?? value.imdb_votes ??
    nestedImdb?.votes ?? nestedImdb?.vote_count;
  const voteCount = rawVotes === undefined ? undefined
    : Number.isInteger(rawVotes) && Number(rawVotes) >= 0 ? Number(rawVotes) : undefined;
  if (rawVotes !== undefined && voteCount === undefined) return undefined;
  return { system: "imdb", provider: "mdblist", value: score,
    scale: 10, ...(voteCount !== undefined ? { voteCount } : {}), observedAt };
}

function identifiers(value: Record<string, unknown>): string[] {
  return [value.id, value.provider_id, value.tmdb_id, value.imdb_id, value.imdbid]
    .filter((id): id is string | number => typeof id === "string" || typeof id === "number")
    .map(String);
}

function imdbIdentity(value: Record<string, unknown>): string | undefined {
  const candidate = [value.imdb_id, value.imdbid, value.imdb]
    .find((id) => typeof id === "string" && /^tt\d+$/.test(id));
  return typeof candidate === "string" ? candidate : undefined;
}

function retryDelay(response: Response): number {
  const header = response.headers.get("retry-after");
  if (!header) return 1_000;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 60_000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, Math.min(date - Date.now(), 60_000)) : 1_000;
}

export function createMdblistBackend(options: MdblistBackendOptions): MdblistBackend {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new TypeError("MDBList API key is required");
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleepImpl ?? ((ms, signal) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  }));

  async function request(
    mediaType: "movie" | "show",
    provider: "tmdb" | "imdb",
    ids: readonly string[],
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>[]> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await options.usage.recordAttempt(now());
      const url = new URL(`/rating/${mediaType}/imdb`, MDBLIST_API_BASE_URL);
      url.searchParams.set("apikey", apiKey);
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: "POST",
          redirect: "error",
          headers: { accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ provider, ids }),
          ...(signal ? { signal } : {}),
        });
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
        throw new Error("MDBList request failed (network)");
      }
      if (response.status === 429 && attempt === 0) {
        await response.body?.cancel().catch(() => {});
        await sleep(retryDelay(response), signal);
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`MDBList authentication failed (HTTP ${response.status})`);
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`MDBList request failed (HTTP ${response.status})`);
      }
      try { return recordArray(await response.json() as unknown); }
      catch { throw new Error("MDBList response was not valid JSON"); }
    }
    throw new Error("MDBList request was rate limited");
  }

  async function lookup(titles: readonly CatalogTitle[], signal?: AbortSignal) {
    const result = new Map<string, CatalogRating>();
    const items: RequestItem[] = [];
    for (const title of titles) {
      if (title.mediaType !== "movie" && title.mediaType !== "series") continue;
      if (title.tmdbId !== undefined) items.push({ title, provider: "tmdb", id: String(title.tmdbId) });
      else if (/^tt\d+$/.test(title.imdbId ?? "")) items.push({ title, provider: "imdb", id: title.imdbId! });
    }
    const currentTime = now();
    const uncached: RequestItem[] = [];
    for (const item of items) {
      let imdbId = item.title.imdbId;
      if (!imdbId && item.title.tmdbId !== undefined) {
        const mediaType = item.title.mediaType === "series" ? "series" : "movie";
        const identity = await options.repository.getIdentity(tmdbIdentityKey(mediaType, item.title.tmdbId));
        if (identity && identity.expiresAt > currentTime) imdbId = identity.imdbId;
      }
      const imdbKey = item.title.tmdbId !== undefined
        ? `tmdb:${item.title.mediaType === "series" ? "series" : "movie"}:${item.title.tmdbId}:imdb:mdblist`
        : imdbId ? `${imdbId}:imdb:mdblist` : undefined;
      const cached = imdbKey ? await options.repository.getRating(imdbKey) : undefined;
      if (cached && cached.expiresAt > currentTime) result.set(item.title.id, cached.rating);
      else {
        if (cached && cached.staleUntil > currentTime) result.set(item.title.id, cached.rating);
        uncached.push(item);
      }
    }
    let firstError: unknown;
    for (const mediaType of ["movie", "show"] as const) {
      for (const provider of ["tmdb", "imdb"] as const) {
        const group = uncached.filter((item) =>
          (item.title.mediaType === "series" ? "show" : "movie") === mediaType && item.provider === provider);
        for (let index = 0; index < group.length; index += MDBLIST_MAX_BATCH) {
          if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
          const batch = group.slice(index, index + MDBLIST_MAX_BATCH);
          let records: Record<string, unknown>[];
          try {
            records = await request(mediaType, provider, batch.map((item) => item.id), signal);
          } catch (error) {
            if (signal?.aborted) throw error;
            firstError ??= error;
            continue;
          }
          for (const [itemIndex, item] of batch.entries()) {
            const record = records.find((candidate) => identifiers(candidate).includes(item.id)) ??
              (records.length === batch.length ? records[itemIndex] : undefined);
            const rating = record ? parsedRating(record, now()) : undefined;
            if (!rating) continue;
            result.set(item.title.id, rating);
            const identity = item.title.imdbId ?? (record ? imdbIdentity(record) : undefined);
            if (identity && item.title.tmdbId !== undefined) {
              const media = item.title.mediaType === "series" ? "series" : "movie";
              await options.repository.putIdentity({
                key: tmdbIdentityKey(media, item.title.tmdbId),
                imdbId: identity,
                resolvedAt: rating.observedAt,
                expiresAt: rating.observedAt + POSITIVE_IDENTITY_TTL_MS,
              });
            }
            if (item.title.tmdbId === undefined && /^tt\d+$/.test(identity ?? "")) {
              await options.repository.putRating(createCachedRating(`${identity}:imdb:mdblist`, rating, rating.observedAt));
            }
            if (item.title.tmdbId !== undefined) {
              await options.repository.putRating(createCachedRating(
                `tmdb:${item.title.mediaType === "series" ? "series" : "movie"}:${item.title.tmdbId}:imdb:mdblist`,
                rating,
                rating.observedAt,
              ));
            }
          }
        }
      }
    }
    if (firstError && result.size === 0) throw firstError;
    return result;
  }
  return { lookup };
}
