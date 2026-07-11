import { describe, expect, it, vi } from "vitest";
import type { DiscoveryAdapter, DiscoverySnapshot } from "../../src/discovery/adapter";
import { DiscoveryBudgetExceededError } from "../../src/discovery/budget";
import type { DiscoveryRequest } from "../../src/discovery/request";
import type {
  DiscoveryLoadResult,
  DiscoveryRefreshResult,
  DiscoveryService,
} from "../../src/discovery/service";
import {
  aggregateDiscoveryStates,
  loadDiscoverySourceState,
  loadDiscoverySources,
} from "../../src/discovery/state";
import type { DiscoverySource } from "../../src/discovery/types";
import { HttpError } from "../../src/util/net";

function request(): DiscoveryRequest {
  return {
    region: "IN",
    feedKind: "digital",
    mediaTypes: ["movie"],
    providerIds: [],
    pageLimit: 1,
  };
}

function snapshot(source: DiscoverySource, id: string): DiscoverySnapshot {
  return {
    source,
    titles: [{ id, title: id, mediaType: "movie", originCountries: [], genreIds: [] }],
    events: [],
    fetchedAt: 1,
    warnings: [{ code: "fixture", message: `${id} warning` }],
  };
}

function adapter(source: DiscoverySource, configured = true): DiscoveryAdapter {
  return {
    id: source,
    label: source,
    capabilities: { features: [], mediaTypes: ["movie"], regions: ["IN"] },
    isConfigured: () => configured,
    fetch: vi.fn(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("partial discovery source states", () => {
  it("distinguishes an explicit user disable from missing configuration", async () => {
    const service: DiscoveryService = { load: vi.fn() };
    const source = adapter("bluray");
    source.isEnabled = () => false;

    await expect(loadDiscoverySourceState(service, source, request())).resolves.toEqual({
      source: "bluray",
      label: "bluray",
      status: "disabled",
      warnings: [],
    });
    expect(service.load).not.toHaveBeenCalled();
  });

  it("does not call the service for an unconfigured adapter", async () => {
    const service: DiscoveryService = { load: vi.fn() };
    const state = await loadDiscoverySourceState(service, adapter("trakt", false), request());
    expect(state).toEqual({
      source: "trakt",
      label: "trakt",
      status: "unconfigured",
      warnings: [],
    });
    expect(service.load).not.toHaveBeenCalled();
  });

  it("keeps a ready peer visible when another source fails", async () => {
    const ready = snapshot("tmdb", "ready-title");
    const service: DiscoveryService = {
      load: vi.fn(async (sourceAdapter): Promise<DiscoveryLoadResult> => {
        if (sourceAdapter.id === "tmdb") {
          return { cacheState: "fresh", snapshot: ready, refreshing: false };
        }
        throw new Error("feed down");
      }),
    };
    const states = await loadDiscoverySources(service, [
      { adapter: adapter("tmdb"), request: request() },
      { adapter: adapter("bluray"), request: { ...request(), region: "ZZ", feedKind: "bluray" } },
    ]);
    const aggregate = aggregateDiscoveryStates(states);

    expect(states.map((state) => state.status)).toEqual(["ready", "failed"]);
    expect(aggregate.titles.map((title) => title.id)).toEqual(["ready-title"]);
    expect(aggregate.usableSources).toBe(1);
    expect(aggregate.warnings.map((warning) => warning.code)).toEqual([
      "fixture",
      "refresh-failed",
    ]);
  });

  it("keeps independent failures when every adapter is unavailable", async () => {
    const service: DiscoveryService = {
      load: vi.fn(async (sourceAdapter): Promise<DiscoveryLoadResult> => ({
        cacheState: "miss",
        refreshing: false,
        error: new Error(`${sourceAdapter.id} offline`),
      })),
    };
    const states = await loadDiscoverySources(service, [
      { adapter: adapter("tmdb"), request: request() },
      { adapter: adapter("bluray"), request: { ...request(), region: "ZZ", feedKind: "bluray" } },
    ]);
    const aggregate = aggregateDiscoveryStates(states);

    expect(states.map((state) => state.status)).toEqual(["failed", "failed"]);
    expect(states.map((state) => state.error?.message)).toEqual([
      "tmdb offline",
      "bluray offline",
    ]);
    expect(aggregate).toMatchObject({ titles: [], events: [], usableSources: 0 });
    expect(aggregate.warnings.map((warning) => warning.code)).toEqual([
      "refresh-failed",
      "refresh-failed",
    ]);
  });

  it("strips terminal controls from public error and warning text", async () => {
    const service: DiscoveryService = {
      load: vi.fn(async (): Promise<DiscoveryLoadResult> => ({
        cacheState: "miss",
        refreshing: false,
        error: new Error("offline\u001b[31m\u009b31m\u2066"),
      })),
    };

    const state = await loadDiscoverySourceState(service, adapter("bluray"), request());
    expect(state.error?.message).toBe("offline[31m31m");
    expect(state.warnings[0]?.message).toBe("offline[31m31m");
    expect(state.error?.message).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2066-\u2069]/u);
  });

  it("transitions a stale background refresh from refreshing to stale on failure", async () => {
    const pending = deferred<DiscoveryRefreshResult>();
    const cached = snapshot("tmdb", "cached");
    const service: DiscoveryService = {
      load: vi.fn(async (): Promise<DiscoveryLoadResult> => ({
        cacheState: "stale",
        snapshot: cached,
        refreshing: true,
        refresh: pending.promise,
      })),
    };
    const state = await loadDiscoverySourceState(service, adapter("tmdb"), request());
    expect(state.status).toBe("refreshing");

    pending.resolve({
      status: "failed",
      snapshot: cached,
      error: new Error("offline"),
      retained: true,
    });
    await expect(state.refresh).resolves.toMatchObject({
      status: "stale",
      snapshot: cached,
      warnings: [{ code: "fixture" }, { code: "refresh-failed" }],
    });
  });

  it("classifies local hard-cap failures as quota-paused", async () => {
    const quota = new DiscoveryBudgetExceededError({
      source: "streaming-availability",
      endpoint: "changes",
      month: "2026-07",
      used: 450,
      endpointUsed: 449,
      allowed: false,
      warning: true,
      softWarning: 350,
      hardCap: 450,
      remaining: 0,
    });
    const service: DiscoveryService = {
      load: vi.fn(async (): Promise<DiscoveryLoadResult> => ({
        cacheState: "miss",
        refreshing: false,
        error: quota,
      })),
    };

    await expect(
      loadDiscoverySourceState(service, adapter("streaming-availability"), request()),
    ).resolves.toMatchObject({
      status: "quota-paused",
      warnings: [{ code: "quota-paused" }],
    });
  });

  it.each([401, 403])("marks HTTP %s as auth-failed while retaining cache", async (status) => {
    const cached = snapshot("streaming-availability", "cached-streaming");
    const service: DiscoveryService = {
      load: vi.fn(async (): Promise<DiscoveryLoadResult> => ({
        cacheState: "stale",
        snapshot: cached,
        refreshing: false,
        error: new HttpError(status, `HTTP ${status}`),
      })),
    };

    await expect(
      loadDiscoverySourceState(service, adapter("streaming-availability"), request()),
    ).resolves.toMatchObject({
      status: "auth-failed",
      snapshot: cached,
      warnings: [{ code: "fixture" }, { code: "auth-failed" }],
    });
  });

  it("records Retry-After timing on a quota-paused state", async () => {
    const error = new HttpError(429, "HTTP 429", 120_000);
    const service: DiscoveryService = {
      load: vi.fn(async (): Promise<DiscoveryLoadResult> => ({
        cacheState: "miss",
        refreshing: false,
        error,
      })),
    };

    await expect(
      loadDiscoverySourceState(service, adapter("streaming-availability"), request()),
    ).resolves.toMatchObject({
      status: "quota-paused",
      retryAfterMs: 120_000,
      warnings: [{ code: "quota-paused" }],
    });
  });

  it("surfaces contract drift while retaining the last valid snapshot", async () => {
    const cached = snapshot("streaming-availability", "cached-streaming");
    const error = new Error("changes response is malformed");
    error.name = "StreamingAvailabilityContractError";
    const service: DiscoveryService = {
      load: vi.fn(async (): Promise<DiscoveryLoadResult> => ({
        cacheState: "stale",
        snapshot: cached,
        refreshing: false,
        error,
      })),
    };

    await expect(
      loadDiscoverySourceState(service, adapter("streaming-availability"), request()),
    ).resolves.toMatchObject({
      status: "stale",
      snapshot: cached,
      warnings: [{ code: "fixture" }, { code: "contract-drift" }],
    });
  });
});
