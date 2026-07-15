import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { imdbRatingsDatasetFile } from "../../config/paths";
import { USER_AGENT } from "../../util/net";
import type { CatalogRating } from "../types";
import {
  catalogRatingCacheKey,
  createCachedRating,
  MISSING_RATING_TTL_MS,
  type RatingsDatasetMetadata,
} from "./cache";
import type { RatingsCacheRepository } from "./cache-repository";

export const IMDB_RATINGS_DATASET_URL = "https://datasets.imdbws.com/title.ratings.tsv.gz";
export const IMDB_DATASET_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000;
export const IMDB_DATASET_MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;
const HEADER = "tconst\taverageRating\tnumVotes";

export async function parseImdbRatings(
  lines: AsyncIterable<string>,
  wantedIds: ReadonlySet<string>,
): Promise<Map<string, CatalogRating>> {
  const found = new Map<string, CatalogRating>();
  let header = true;
  for await (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, "");
    if (header) {
      header = false;
      if (line !== HEADER) throw new TypeError("IMDb ratings dataset has an invalid header");
      if (wantedIds.size === 0) break;
      continue;
    }
    const [imdbId, rawRating, rawVotes, extra] = line.split("\t");
    if (extra !== undefined || !imdbId || !wantedIds.has(imdbId) || found.has(imdbId)) continue;
    if (!/^tt\d+$/.test(imdbId)) continue;
    const value = Number(rawRating);
    const voteCount = Number(rawVotes);
    if (!Number.isFinite(value) || value < 0 || value > 10 ||
        !Number.isInteger(voteCount) || voteCount < 0) continue;
    found.set(imdbId, {
      system: "imdb",
      provider: "imdb-dataset",
      value,
      scale: 10,
      voteCount,
      // The transport/backend stamps the actual observation; keep the parser
      // deterministic and side-effect free.
      observedAt: 0,
    });
    if (found.size === wantedIds.size) break;
  }
  if (header) throw new TypeError("IMDb ratings dataset is empty");
  return found;
}

export interface EnsureImdbDatasetOptions {
  repository: RatingsCacheRepository;
  file?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  maxCompressedBytes?: number;
}

export interface EnsuredImdbDataset {
  file: string;
  etag?: string;
  changed: boolean;
  stale: boolean;
}

async function exists(file: string): Promise<boolean> {
  try { await fs.access(file); return true; } catch { return false; }
}

async function validateDownloadedDataset(file: string): Promise<void> {
  const input = createReadStream(file);
  const gunzip = createGunzip();
  const lines = createInterface({ input: input.pipe(gunzip), crlfDelay: Infinity });
  try {
    const first = await lines[Symbol.asyncIterator]().next();
    if (first.done || first.value.replace(/\r$/, "") !== HEADER) {
      throw new Error("IMDb ratings dataset has an invalid header");
    }
  } finally {
    lines.close();
    input.destroy();
    gunzip.destroy();
  }
}

async function fetchDataset(
  fetchImpl: typeof fetch,
  url: URL,
  init: RequestInit,
): Promise<Response> {
  const response = await fetchImpl(url, { ...init, redirect: "manual" });
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => {});
    if (!location) throw new Error("IMDb dataset redirect had no location");
    const redirected = new URL(location, url);
    if (redirected.protocol !== "https:" || redirected.hostname !== url.hostname) {
      throw new Error("IMDb dataset redirect was rejected");
    }
    return fetchImpl(redirected, { ...init, redirect: "manual" });
  }
  const finalUrl = response.url ? new URL(response.url) : url;
  if (finalUrl.protocol !== "https:" || finalUrl.hostname !== url.hostname) {
    await response.body?.cancel().catch(() => {});
    throw new Error("IMDb dataset response host was rejected");
  }
  return response;
}

export async function ensureImdbDataset(
  options: EnsureImdbDatasetOptions,
): Promise<EnsuredImdbDataset> {
  const file = options.file ?? imdbRatingsDatasetFile;
  const now = options.now ?? Date.now;
  const currentTime = now();
  const metadata = await options.repository.getDataset();
  const localExists = await exists(file);
  if (localExists && metadata.checkedAt !== undefined &&
      currentTime - metadata.checkedAt < IMDB_DATASET_CHECK_INTERVAL_MS) {
    return { file, ...(metadata.etag ? { etag: metadata.etag } : {}), changed: false,
      stale: metadata.failedAt !== undefined && metadata.failedAt >= metadata.checkedAt };
  }
  const headers = new Headers({ "user-agent": USER_AGENT, accept: "application/gzip" });
  if (metadata.etag) headers.set("if-none-match", metadata.etag);
  if (metadata.lastModified) headers.set("if-modified-since", metadata.lastModified);
  let response: Response;
  try {
    response = await fetchDataset(options.fetchImpl ?? fetch, new URL(IMDB_RATINGS_DATASET_URL), { headers });
    if (response.status === 304) {
      if (!localExists) throw new Error("IMDb dataset returned 304 without a local file");
      const next = { ...metadata, checkedAt: currentTime };
      delete next.failedAt;
      await options.repository.setDataset(next);
      return { file, ...(metadata.etag ? { etag: metadata.etag } : {}), changed: false, stale: false };
    }
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`IMDb dataset request failed (HTTP ${response.status})`);
    }
    const length = Number(response.headers.get("content-length"));
    const ceiling = options.maxCompressedBytes ?? IMDB_DATASET_MAX_COMPRESSED_BYTES;
    if (Number.isFinite(length) && length > ceiling) {
      await response.body.cancel().catch(() => {});
      throw new Error("IMDb dataset response exceeded the size limit");
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${currentTime}.tmp`;
    let bytes = 0;
    const source = Readable.fromWeb(response.body as never);
    source.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > ceiling) source.destroy(new Error("IMDb dataset response exceeded the size limit"));
    });
    try {
      await pipeline(source, createWriteStream(temporary, { mode: 0o600 }));
      await validateDownloadedDataset(temporary);
      await fs.rename(temporary, file);
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    const next: RatingsDatasetMetadata = {
      ...(response.headers.get("etag") ? { etag: response.headers.get("etag")! } : {}),
      ...(response.headers.get("last-modified")
        ? { lastModified: response.headers.get("last-modified")! } : {}),
      downloadedAt: currentTime,
      checkedAt: currentTime,
    };
    await options.repository.setDataset(next);
    return { file, ...(next.etag ? { etag: next.etag } : {}), changed: true, stale: false };
  } catch (error) {
    if (!localExists) throw error;
    await options.repository.setDataset({ ...metadata, checkedAt: currentTime, failedAt: currentTime });
    return { file, ...(metadata.etag ? { etag: metadata.etag } : {}), changed: false, stale: true };
  }
}

export interface ImdbDatasetBackend {
  lookup(imdbIds: readonly string[], signal?: AbortSignal): Promise<Map<string, CatalogRating>>;
}

export interface ImdbDatasetBackendOptions extends EnsureImdbDatasetOptions {}

export function createImdbDatasetBackend(options: ImdbDatasetBackendOptions): ImdbDatasetBackend {
  const now = options.now ?? Date.now;
  interface Waiter {
    ids: string[];
    signal?: AbortSignal;
    resolve(value: Map<string, CatalogRating>): void;
    reject(error: unknown): void;
  }
  let running = false;
  let scheduled = false;
  let waiting: Waiter[] = [];

  async function scan(ids: readonly string[], signal?: AbortSignal): Promise<Map<string, CatalogRating>> {
    const result = new Map<string, CatalogRating>();
    const uncached = new Set<string>();
    const currentTime = now();
    const metadata = await options.repository.getDataset();
    for (const imdbId of new Set(ids)) {
      if (!/^tt\d+$/.test(imdbId)) continue;
      const key = `${imdbId}:imdb:imdb-dataset`;
      const cached = await options.repository.getRating(key);
      if (cached && cached.expiresAt > currentTime) {
        result.set(imdbId, cached.rating);
        continue;
      }
      if (cached && cached.staleUntil > currentTime) result.set(imdbId, cached.rating);
      const missing = await options.repository.getMissing(imdbId);
      if (missing && missing.expiresAt > currentTime && missing.datasetEtag === metadata.etag) continue;
      uncached.add(imdbId);
    }
    if (uncached.size === 0) return result;
    if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
    const ensured = await ensureImdbDataset(options);
    const input = createReadStream(ensured.file);
    const gunzip = createGunzip();
    const lines = createInterface({ input: input.pipe(gunzip), crlfDelay: Infinity });
    const abort = () => {
      lines.close();
      gunzip.destroy();
      input.destroy();
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const found = await parseImdbRatings(lines, uncached);
      if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
      const observedAt = now();
      for (const [imdbId, raw] of found) {
        if (ensured.stale && result.has(imdbId)) continue;
        const effectiveObservedAt = ensured.stale
          ? (await options.repository.getDataset()).downloadedAt ?? raw.observedAt
          : observedAt;
        if (ensured.stale && observedAt - effectiveObservedAt > 30 * 24 * 60 * 60 * 1_000) continue;
        const rating = { ...raw, observedAt: effectiveObservedAt };
        result.set(imdbId, rating);
        if (!ensured.stale) {
          await options.repository.putRating(createCachedRating(
            catalogRatingCacheKey(imdbId, rating), rating, observedAt, ensured.etag,
          ));
        }
        await options.repository.removeMissing(imdbId);
      }
      for (const imdbId of uncached) {
        if (!found.has(imdbId) && !ensured.stale) await options.repository.putMissing(imdbId, {
          checkedAt: observedAt,
          expiresAt: observedAt + MISSING_RATING_TTL_MS,
          ...(ensured.etag ? { datasetEtag: ensured.etag } : {}),
        });
      }
      return result;
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason ?? new DOMException("Aborted", "AbortError");
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      lines.close();
      gunzip.destroy();
      input.destroy();
    }
  }

  async function drain(): Promise<void> {
    if (running) return;
    scheduled = false;
    running = true;
    try {
      // Requests collected during a scan become exactly one subsequent batch.
      while (waiting.length > 0) {
        const batch = waiting;
        waiting = [];
        const active = batch.filter((waiter) => !waiter.signal?.aborted);
        for (const waiter of batch.filter((item) => item.signal?.aborted)) {
          waiter.reject(waiter.signal?.reason ?? new DOMException("Aborted", "AbortError"));
        }
        if (active.length === 0) continue;
        const ids = [...new Set(active.flatMap((waiter) => waiter.ids))];
        try {
          const found = await scan(ids, active.length === 1 ? active[0]!.signal : undefined);
          for (const waiter of active) {
            if (waiter.signal?.aborted) {
              waiter.reject(waiter.signal.reason ?? new DOMException("Aborted", "AbortError"));
            } else {
              waiter.resolve(new Map(waiter.ids.flatMap((id) => {
                const rating = found.get(id);
                return rating ? [[id, rating] as const] : [];
              })));
            }
          }
        } catch (error) {
          for (const waiter of active) waiter.reject(error);
        }
      }
    } finally {
      running = false;
      if (waiting.length > 0 && !scheduled) {
        scheduled = true;
        queueMicrotask(() => { void drain(); });
      }
    }
  }

  function lookup(imdbIds: readonly string[], signal?: AbortSignal): Promise<Map<string, CatalogRating>> {
    const ids = [...new Set(imdbIds)];
    return new Promise((resolve, reject) => {
      waiting.push({ ids, ...(signal ? { signal } : {}), resolve, reject });
      if (!running && !scheduled) {
        scheduled = true;
        queueMicrotask(() => { void drain(); });
      }
    });
  }
  return { lookup };
}
