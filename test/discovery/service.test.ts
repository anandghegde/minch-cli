import { describe, expect, it, vi } from "vitest";
import type { DiscoveryAdapter, DiscoverySnapshot } from "../../src/discovery/adapter";
import {
  createDiscoveryCacheRepository,
  type DiscoveryCacheRepository,
} from "../../src/discovery/cache-repository";
import {
  createDiscoveryCacheEntry,
  discoveryRequestKey,
  type DiscoveryCacheEntry,
} from "../../src/discovery/cache";
import type { DiscoveryRequest } from "../../src/discovery/request";
import { createDiscoveryService } from "../../src/discovery/service";

const NOW = 1_783_665_832_000;

function request(): DiscoveryRequest {
  return {
    region: "IN",
    feedKind: "digital",
    dateRange: { start: "2026-06-09", end: "2026-07-10", direction: "past" },
    mediaTypes: ["movie"],
    providerIds: [],
    pageLimit: 1,
  };
}

function snapshot(label: string, fetchedAt = NOW): DiscoverySnapshot {
  return {
    source: "tmdb",
    titles: [{
      id: label,
      title: label,
      mediaType: "movie",
      originCountries: [],
      genreIds: [],
    }],
    events: [],
    fetchedAt,
    warnings: [],
  };
}

class MemoryCache implements DiscoveryCacheRepository {
  entries = new Map<string, DiscoveryCacheEntry>();
  writes = 0;

  async load() {
    return { document: { version: 1 as const, entries: {} }, rejectedEntries: [] };
  }

  async get(source: DiscoverySnapshot["source"], req: DiscoveryRequest) {
    return this.entries.get(discoveryRequestKey(source, req));
  }

  async put(entry: DiscoveryCacheEntry) {
    this.entries.set(discoveryRequestKey(entry.source, entry.request), entry);
    this.writes += 1;
  }

  async putSnapshot(
    req: DiscoveryRequest,
    value: DiscoverySnapshot,
    expiresAt: number,
    staleUntil: number,
  ) {
    await this.put(createDiscoveryCacheEntry(req, value, expiresAt, staleUntil));
  }

  async remove(source: DiscoverySnapshot["source"], req: DiscoveryRequest) {
    this.entries.delete(discoveryRequestKey(source, req));
  }

  async flush() {}
}

function fakeAdapter(fetcher: DiscoveryAdapter["fetch"]): DiscoveryAdapter {
  return {
    id: "tmdb",
    label: "Fake TMDB",
    capabilities: {
      features: ["regional_release"],
      mediaTypes: ["movie"],
      regions: ["IN"],
    },
    isConfigured: () => true,
    fetch: fetcher,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe("discovery stale-while-revalidate service", () => {
  it("returns a fresh cache hit without calling the adapter", async () => {
    const cache = new MemoryCache();
    const req = request();
    const cached = snapshot("fresh");
    cache.entries.set(
      discoveryRequestKey("tmdb", req),
      createDiscoveryCacheEntry(req, cached, NOW + 1, NOW + 2),
    );
    const fetcher = vi.fn<DiscoveryAdapter["fetch"]>();
    const service = createDiscoveryService({ cache, fetchImpl: fetch, now: () => NOW });

    expect(await service.load(fakeAdapter(fetcher), req)).toEqual({
      cacheState: "fresh",
      snapshot: cached,
      refreshing: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns stale data immediately and refreshes it through a lifecycle promise", async () => {
    const cache = new MemoryCache();
    const req = request();
    const cached = snapshot("stale", NOW - 10);
    cache.entries.set(
      discoveryRequestKey("tmdb", req),
      createDiscoveryCacheEntry(req, cached, NOW - 1, NOW + 1_000),
    );
    const next = deferred<DiscoverySnapshot>();
    const fetcher = vi.fn<DiscoveryAdapter["fetch"]>(async () => next.promise);
    const service = createDiscoveryService({ cache, fetchImpl: fetch, now: () => NOW });

    const loaded = await service.load(fakeAdapter(fetcher), req);
    expect(loaded).toMatchObject({ cacheState: "stale", snapshot: cached, refreshing: true });
    expect(cache.writes).toBe(0);
    const refreshed = snapshot("refreshed");
    next.resolve(refreshed);
    await expect(loaded.refresh).resolves.toMatchObject({
      status: "ready",
      snapshot: refreshed,
      retained: false,
    });
    expect(cache.writes).toBe(1);
  });

  it("retains the last good expired snapshot on offline failure", async () => {
    const cache = new MemoryCache();
    const req = request();
    const cached = snapshot("expired", NOW - 10_000);
    cache.entries.set(
      discoveryRequestKey("tmdb", req),
      createDiscoveryCacheEntry(req, cached, NOW - 2_000, NOW - 1_000),
    );
    const fetcher = vi.fn<DiscoveryAdapter["fetch"]>(async () => {
      throw new Error("offline");
    });
    const service = createDiscoveryService({ cache, fetchImpl: fetch, now: () => NOW });

    expect(await service.load(fakeAdapter(fetcher), req)).toMatchObject({
      cacheState: "expired",
      snapshot: cached,
      refreshing: false,
      error: new Error("offline"),
    });
    expect(cache.writes).toBe(0);
  });

  it("reports an honest cache miss when offline without cached data", async () => {
    const cache = new MemoryCache();
    const fetcher = vi.fn<DiscoveryAdapter["fetch"]>(async () => {
      throw new Error("offline");
    });
    const service = createDiscoveryService({ cache, fetchImpl: fetch, now: () => NOW });

    await expect(service.load(fakeAdapter(fetcher), request())).resolves.toMatchObject({
      cacheState: "miss",
      refreshing: false,
      error: new Error("offline"),
    });
    expect(cache.writes).toBe(0);
  });

  it("treats corrupt cache as unavailable data before an offline refresh", async () => {
    const cache = createDiscoveryCacheRepository({
      readFile: async () => "{not-json",
      writeJson: async () => {},
    });
    await expect(cache.load()).resolves.toMatchObject({
      document: { entries: {} },
      documentError: "cache JSON is invalid",
    });
    const fetcher = vi.fn<DiscoveryAdapter["fetch"]>(async () => {
      throw new Error("offline");
    });
    const service = createDiscoveryService({ cache, fetchImpl: fetch, now: () => NOW });

    await expect(service.load(fakeAdapter(fetcher), request())).resolves.toMatchObject({
      cacheState: "miss",
      refreshing: false,
      error: new Error("offline"),
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("deduplicates concurrent identical foreground refreshes", async () => {
    const cache = new MemoryCache();
    const req = request();
    const next = deferred<DiscoverySnapshot>();
    const fetcher = vi.fn<DiscoveryAdapter["fetch"]>(async () => next.promise);
    const service = createDiscoveryService({ cache, fetchImpl: fetch, now: () => NOW });
    const adapter = fakeAdapter(fetcher);

    const first = service.load(adapter, req);
    const second = service.load(adapter, req);
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(1);
    next.resolve(snapshot("shared"));

    await expect(first).resolves.toMatchObject({ cacheState: "refreshed" });
    await expect(second).resolves.toMatchObject({ cacheState: "refreshed" });
    expect(cache.writes).toBe(1);
  });

  it("forwards aborts and never caches an aborted refresh", async () => {
    const cache = new MemoryCache();
    const req = request();
    const controller = new AbortController();
    const fetcher = vi.fn<DiscoveryAdapter["fetch"]>(async (_request, options) =>
      new Promise<DiscoverySnapshot>((_resolve, reject) => {
        if (options.signal?.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        options.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      }));
    const service = createDiscoveryService({ cache, fetchImpl: fetch, now: () => NOW });

    const loading = service.load(fakeAdapter(fetcher), req, { signal: controller.signal });
    controller.abort();

    await expect(loading).resolves.toMatchObject({
      cacheState: "miss",
      refreshing: false,
      error: { name: "AbortError" },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![1].signal).toBe(controller.signal);
    expect(cache.writes).toBe(0);
  });
});
