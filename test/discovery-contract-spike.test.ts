import { describe, expect, it } from "vitest";
import {
  resolveStreamingConfig,
  runContractSpike,
} from "../scripts/discovery-contract-spike";

const NOW = new Date("2026-07-10T06:20:00.000Z");

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("discovery contract spike configuration", () => {
  it("makes no requests when credentials are absent", async () => {
    let calls = 0;
    const report = await runContractSpike(
      {},
      async () => {
        calls += 1;
        throw new Error("unexpected request");
      },
      NOW,
    );

    expect(calls).toBe(0);
    expect(report).toMatchObject({
      complete: false,
      totalRequestCount: 0,
      tmdb: { status: "unconfigured" },
      streamingAvailability: { status: "unconfigured" },
      trakt: { status: "skipped-terms", requestCount: 0 },
    });
  });

  it("treats a missing or blank streaming key as unconfigured", () => {
    expect(resolveStreamingConfig({})).toEqual({ status: "unconfigured" });
    expect(resolveStreamingConfig({ STREAMING_AVAILABILITY_API_KEY: "   " })).toEqual({
      status: "unconfigured",
    });
  });

  it("maps every configured key to the fixed direct host and header", () => {
    expect(
      resolveStreamingConfig({
        STREAMING_AVAILABILITY_API_KEY: "secret",
      }),
    ).toMatchObject({
      status: "configured",
      baseUrl: "https://api.movieofthenight.com/v4",
      headerName: "X-API-Key",
    });
  });
});

describe("discovery contract spike sanitization and bounds", () => {
  it("redacts a credential even if a transport error echoes it", async () => {
    const report = await runContractSpike(
      { TMDB_READ_TOKEN: "test-only-token" },
      async () => {
        throw new Error("transport rejected test-only-token");
      },
      NOW,
    );

    expect(report).toMatchObject({
      tmdb: { status: "failed", requestCount: 1, error: "transport rejected [redacted]" },
    });
    expect(JSON.stringify(report)).not.toContain("test-only-token");
  });

  it("summarizes seven bounded calls without leaking either credential", async () => {
    const calls: { url: URL; headers: Headers }[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url, headers: new Headers(init?.headers) });

      if (url.hostname === "api.themoviedb.org" && url.pathname === "/3/discover/movie") {
        return json({
          page: 1,
          total_pages: 1,
          total_results: 1,
          results: [
            {
              id: url.searchParams.get("with_release_type") === "5" ? 43 : 42,
              title: "Example",
              release_date: "2026-07-01",
            },
          ],
        });
      }
      if (url.pathname.endsWith("/release_dates")) {
        return json({
          id: url.pathname.includes("/43/") ? 43 : 42,
          results: [
            {
              iso_3166_1: "IN",
              release_dates: [
                {
                  release_date: "2026-07-01T00:00:00.000Z",
                  type: url.pathname.includes("/43/") ? 5 : 4,
                },
              ],
            },
          ],
        });
      }
      if (url.pathname.endsWith("/watch/providers")) {
        return json({
          id: 42,
          results: {
            IN: {
              link: "https://www.themoviedb.org/movie/42/watch?locale=IN",
              flatrate: [{ provider_id: 8, provider_name: "Netflix" }],
            },
          },
        });
      }
      if (url.pathname.endsWith("/countries/in")) {
        return json({
          countryCode: "in",
          name: "India",
          services: [{ id: "netflix", name: "Netflix" }],
        });
      }
      if (url.pathname.endsWith("/changes")) {
        return json({
          changes: [
            {
              changeType: "new",
              itemType: "show",
              showId: "show-1",
              timestamp: 1_783_660_000,
              catalogId: "netflix",
              service: { id: "netflix", name: "Netflix" },
            },
          ],
          shows: {
            "show-1": {
              id: "show-1",
              title: "Example",
              showType: "movie",
              imdbId: "tt0000001",
              tmdbId: "movie/42",
            },
          },
          hasMore: false,
          nextCursor: null,
        });
      }
      return new Response(null, { status: 404 });
    };

    const report = await runContractSpike(
      {
        TMDB_READ_TOKEN: "tmdb-super-secret",
        STREAMING_AVAILABILITY_API_KEY: "streaming-super-secret",
      },
      fakeFetch,
      NOW,
    );

    expect(calls).toHaveLength(8);
    expect(report).toMatchObject({
      complete: true,
      totalRequestCount: 8,
      tmdb: {
        status: "ready",
        evidenceComplete: true,
        requestCount: 6,
        digitalReleaseEvidence: {
          evidenceComplete: true,
          releaseDates: { indiaPresent: true, indiaReleaseTypes: [4] },
        },
        physicalReleaseEvidence: {
          evidenceComplete: true,
          releaseDates: { indiaPresent: true, indiaReleaseTypes: [5] },
        },
        watchProviderEvidence: {
          evidenceComplete: true,
          watchProviders: { indiaPresent: true },
        },
      },
      streamingAvailability: {
        status: "ready",
        evidenceComplete: true,
        transport: "direct",
        requestCount: 2,
        localMonthlyBudget: {
          allowance: 500,
          softWarning: 350,
          hardStop: 450,
          safetyMargin: 50,
        },
        country: { countryCode: "in", serviceCount: 1 },
        changes: {
          changeCount: 1,
          joinableChangeCount: 1,
          firstChange: { timestamp: { unit: "seconds" } },
        },
      },
      trakt: { status: "skipped-terms", requestCount: 0 },
    });

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("tmdb-super-secret");
    expect(serialized).not.toContain("streaming-super-secret");
    expect(calls.every(({ url }) => !url.href.includes("secret"))).toBe(true);

    const tmdbCalls = calls.filter(({ url }) => url.hostname === "api.themoviedb.org");
    expect(tmdbCalls).toHaveLength(6);
    expect(tmdbCalls.every(({ headers }) => headers.get("authorization") === "Bearer tmdb-super-secret")).toBe(true);

    const streamingCalls = calls.filter(
      ({ url }) => url.hostname === "api.movieofthenight.com",
    );
    expect(streamingCalls).toHaveLength(2);
    expect(streamingCalls.map(({ url }) => url.pathname).sort()).toEqual([
      "/v4/changes",
      "/v4/countries/in",
    ]);
    expect(
      streamingCalls.every(
        ({ headers }) => headers.get("x-api-key") === "streaming-super-secret",
      ),
    ).toBe(true);
    expect(calls.every(({ url }) => url.hostname !== "api.trakt.tv")).toBe(true);

    calls.length = 0;
    const tmdbOnly = await runContractSpike(
      {
        TMDB_READ_TOKEN: "tmdb-super-secret",
        STREAMING_AVAILABILITY_API_KEY: "streaming-super-secret",
      },
      fakeFetch,
      NOW,
      { tmdb: true, streamingAvailability: false },
    );
    expect(tmdbOnly).toMatchObject({
      complete: true,
      totalRequestCount: 6,
      requestedSources: { tmdb: true, streamingAvailability: false },
      streamingAvailability: { status: "skipped-option", requestCount: 0 },
    });
    expect(calls).toHaveLength(6);
    expect(calls.every(({ url }) => url.hostname === "api.themoviedb.org")).toBe(true);
  });
});
