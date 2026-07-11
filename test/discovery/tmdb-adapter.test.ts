import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/config/config";
import type { BudgetStatus, RequestLedger } from "../../src/discovery/budget";
import type { DiscoveryRequest } from "../../src/discovery/request";
import { createDiscoveryCacheRepository } from "../../src/discovery/cache-repository";
import { createDiscoveryService } from "../../src/discovery/service";
import {
  createTmdbAdapter,
  TMDB_ATTRIBUTION,
  tmdbTitleUrl,
} from "../../src/discovery/sources/tmdb";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const NOW = 1_783_665_832_000;

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as unknown;
}

function ledger() {
  const status: BudgetStatus = {
    source: "tmdb",
    endpoint: "fixture",
    month: "2026-07",
    used: 1,
    endpointUsed: 1,
    allowed: true,
    warning: false,
  };
  return {
    recordAttempt: vi.fn<Pick<RequestLedger, "recordAttempt">["recordAttempt"]>(
      async () => status,
    ),
  };
}

function request(overrides: Partial<DiscoveryRequest>): DiscoveryRequest {
  return {
    region: "IN",
    feedKind: "trending",
    mediaTypes: ["movie", "series"],
    providerIds: [],
    pageLimit: 4,
    ...overrides,
  };
}

describe("TMDB discovery adapter feeds", () => {
  it("fetches weekly trending once and excludes people", async () => {
    const calls: URL[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      calls.push(new URL(String(input)));
      return new Response(JSON.stringify({
        page: 1,
        total_pages: 3,
        total_results: 3,
        results: [
          {
            id: 1,
            media_type: "movie",
            title: "Movie",
            release_date: "2026-07-01",
            genre_ids: [18],
            popularity: 10,
          },
          {
            id: 2,
            media_type: "tv",
            name: "Series",
            first_air_date: "2025-01-02",
            origin_country: ["IN"],
            genre_ids: [18],
            popularity: 20,
          },
          { id: 3, media_type: "person", name: "Person", popularity: 30 },
        ],
      }), { status: 200 });
    });
    const attempts = ledger();
    const adapter = createTmdbAdapter({
      config: defaultConfig,
      env: { TMDB_READ_TOKEN: "token" },
      ledger: attempts,
      now: () => NOW,
      retries: 0,
    });

    const snapshot = await adapter.fetch(request({}), { fetchImpl });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.pathname).toBe("/3/trending/all/week");
    expect(calls[0]!.searchParams.get("page")).toBe("1");
    expect(snapshot.titles.map((title) => [title.title, title.mediaType])).toEqual([
      ["Movie", "movie"],
      ["Series", "series"],
    ]);
    expect(snapshot.titles[1]).toMatchObject({ year: 2025, originCountries: ["IN"] });
    expect(snapshot.events).toEqual([]);
    expect(snapshot.attribution).toEqual(TMDB_ATTRIBUTION);
    expect(attempts.recordAttempt).toHaveBeenCalledWith("tmdb", "trending-week");
  });

  it("uses explicit deterministic India digital/physical queries and honest unknown dates", async () => {
    const calls: URL[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      calls.push(new URL(String(input)));
      return new Response(JSON.stringify(fixture("tmdb-discover-movie.json")), {
        status: 200,
      });
    });
    const adapter = createTmdbAdapter({
      config: defaultConfig,
      env: { TMDB_READ_TOKEN: "token" },
      ledger: ledger(),
      now: () => NOW,
      retries: 0,
    });
    const range = { start: "2026-06-09", end: "2026-07-10", direction: "past" as const };

    const digital = await adapter.fetch(
      request({ feedKind: "digital", mediaTypes: ["movie"], dateRange: range }),
      { fetchImpl },
    );
    const physical = await adapter.fetch(
      request({
        feedKind: "physical",
        mediaTypes: ["movie"],
        dateRange: { ...range, direction: "upcoming" },
      }),
      { fetchImpl },
    );

    expect(calls).toHaveLength(2);
    expect(calls.every((url) => url.pathname === "/3/discover/movie")).toBe(true);
    expect(calls[0]!.searchParams.get("region")).toBe("IN");
    expect(calls[0]!.searchParams.get("with_release_type")).toBe("4");
    expect(calls[0]!.searchParams.get("release_date.gte")).toBe(range.start);
    expect(calls[0]!.searchParams.get("release_date.lte")).toBe(range.end);
    expect(calls[0]!.searchParams.get("sort_by")).toBe("primary_release_date.desc");
    expect(calls[1]!.searchParams.get("with_release_type")).toBe("5");
    expect(calls[1]!.searchParams.get("sort_by")).toBe("primary_release_date.asc");
    expect(calls.every((url) => url.searchParams.get("page") === "1")).toBe(true);

    expect(digital.events).toHaveLength(5);
    expect(digital.events[0]).toMatchObject({
      kind: "digital",
      region: "IN",
      datePrecision: "unknown",
      status: "unknown",
      formatLabel: "Digital",
      evidence: [{ source: "tmdb", confidence: "inferred" }],
    });
    expect(digital.events[0]!.evidence[0]!.sourceUrl).toBe(
      "https://www.themoviedb.org/movie/1001",
    );
    expect(digital.events.every((event) => event.date === undefined)).toBe(true);
    expect(physical.events[0]).toMatchObject({
      kind: "physical",
      formatLabel: "Physical",
    });
    expect(physical.events.every((event) => event.kind !== "bluray")).toBe(true);
  });

  it("reports unconfigured state without probing", () => {
    const adapter = createTmdbAdapter({
      config: defaultConfig,
      env: {},
      ledger: ledger(),
    });
    expect(adapter.isConfigured()).toBe(false);
  });

  it("serves a normalized attributed feed from cache after the first token-backed fetch", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(fixture("tmdb-discover-movie.json")), { status: 200 }));
    const repository = createDiscoveryCacheRepository({
      readFile: async () => {
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
      writeJson: async () => {},
    });
    const service = createDiscoveryService({
      cache: repository,
      fetchImpl,
      now: () => NOW,
    });
    const adapter = createTmdbAdapter({
      config: defaultConfig,
      env: { TMDB_READ_TOKEN: "token" },
      ledger: ledger(),
      now: () => NOW,
      retries: 0,
    });
    const req = request({
      feedKind: "digital",
      mediaTypes: ["movie"],
      dateRange: { start: "2026-06-09", end: "2026-07-10", direction: "past" },
    });

    const first = await service.load(adapter, req);
    const second = await service.load(adapter, req);

    expect(first).toMatchObject({
      cacheState: "refreshed",
      snapshot: {
        source: "tmdb",
        titles: expect.any(Array),
        events: expect.any(Array),
        attribution: { sourceLabel: "TMDB" },
      },
    });
    expect(second).toMatchObject({ cacheState: "fresh" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("exposes canonical title URLs and required notice/logo guidance", () => {
    expect(tmdbTitleUrl("movie", 1001)).toBe("https://www.themoviedb.org/movie/1001");
    expect(tmdbTitleUrl("series", 2002)).toBe("https://www.themoviedb.org/tv/2002");
    expect(TMDB_ATTRIBUTION).toMatchObject({
      sourceLabel: "TMDB",
      sourceUrl: "https://www.themoviedb.org",
      notice: "This product uses the TMDB API but is not endorsed or certified by TMDB.",
      logoGuidanceUrl: "https://www.themoviedb.org/about/logos-attribution",
      additionalNotices: [expect.stringContaining("JustWatch")],
    });
  });
});
