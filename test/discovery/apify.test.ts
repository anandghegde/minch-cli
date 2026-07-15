import { describe, expect, it } from "vitest";
import {
  APIFY_FLIXPATROL_ACTOR,
  APIFY_FLIXPATROL_MAX_CHARGE_USD,
  APIFY_LETTERBOXD_ACTOR,
  APIFY_LETTERBOXD_MAX_CHARGE_USD,
  APIFY_STREAMING_CATALOG_ACTOR,
  createApifyAdapter,
  parseApifyChartResponse,
  parseApifyCommunityResponse,
  parseApifyPopularResponse,
} from "../../src/discovery/sources/apify";
import { defaultConfig } from "../../src/config/config";

describe("Apify streaming catalog adapter", () => {
  it("parses popular movie and series rows while preserving optional IDs", () => {
    const parsed = parseApifyPopularResponse([
      {
        title: "A Movie",
        type: "MOVIE",
        year: 2025,
        tmdb_id: "10",
        imdb_id: "tt10",
        genres: ["Drama"],
        streaming_on: "Netflix",
      },
      {
        title: "A Series",
        type: "SHOW",
        imdbId: "tt20",
        streamingOn: ["Prime Video"],
      },
    ]);

    expect(parsed.warnings).toEqual([]);
    expect(parsed.rows).toMatchObject([
      { title: "A Movie", type: "MOVIE", tmdbId: 10, imdbId: "tt10" },
      { title: "A Series", type: "SHOW", imdbId: "tt20" },
    ]);
  });

  it("skips malformed rows with a source warning", () => {
    const parsed = parseApifyPopularResponse([{ title: "Missing type" }, "bad"]);
    expect(parsed.rows).toEqual([]);
    expect(parsed.warnings).toHaveLength(2);
  });

  it("parses FlixPatrol chart rows and infers media type from category", () => {
    const parsed = parseApifyChartResponse([
      {
        platform: "Netflix",
        category: "TV Shows",
        rank: 1,
        title: "A Series",
        title_slug: "a-series",
        points: 4200,
        genres: "Crime, Drama",
      },
      {
        platform: "Disney+",
        category: "Movies",
        rank: 2,
        title: "A Movie",
      },
      { title: "Missing chart metadata" },
    ]);

    expect(parsed.rows).toEqual([
      {
        title: "A Series",
        titleSlug: "a-series",
        type: "SHOW",
        platform: "Netflix",
        rank: 1,
        points: 4200,
        genres: ["Crime", "Drama"],
      },
      {
        title: "A Movie",
        type: "MOVIE",
        platform: "Disney+",
        rank: 2,
        genres: [],
      },
    ]);
    expect(parsed.warnings).toHaveLength(1);
  });

  it("parses bounded Letterboxd weekly-popular rows", () => {
    const parsed = parseApifyCommunityResponse([
      {
        title: "A Film",
        year: 2026,
        url: "https://letterboxd.com/film/a-film/",
        posterUrl: "https://example.com/poster.jpg",
        averageRating: 4.2,
      },
      { year: 2025 },
    ]);

    expect(parsed.rows).toEqual([{
      title: "A Film",
      year: 2026,
      url: "https://letterboxd.com/film/a-film/",
      poster: "https://example.com/poster.jpg",
      averageRating: 4.2,
    }]);
    expect(parsed.warnings).toHaveLength(1);
  });

  it("calls the documented popular Actor in India", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify([
        { title: "A Movie", type: "MOVIE", streaming_on: ["Netflix"] },
      ]), { status: 200, headers: { "content-type": "application/json" } });
    };
    const adapter = createApifyAdapter({
      config: defaultConfig,
      env: { APIFY_API_TOKEN: "test-token" },
      ledger: {
        canSpend: async () => ({ source: "apify", endpoint: "provider-popular", month: "2026-07", used: 0, endpointUsed: 0, allowed: true, warning: false }),
        recordAttempt: async () => ({ source: "apify", endpoint: "provider-popular", month: "2026-07", used: 1, endpointUsed: 1, allowed: true, warning: false }),
      },
    });

    const snapshot = await adapter.fetch({
      region: "IN",
      feedKind: "provider_popular",
      mediaTypes: ["movie", "series"],
      providerIds: ["netflix"],
      pageLimit: 1,
    }, { fetchImpl });

    expect(calls[0]?.url).toContain(`${APIFY_STREAMING_CATALOG_ACTOR.replace("/", "~")}/run-sync-get-dataset-items`);
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: "Bearer test-token" });
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      mode: "popular",
      country: "IN",
      providers: ["nfx"],
    });
    expect(snapshot.source).toBe("apify");
    expect(snapshot.feedKind).toBe("provider_popular");
    expect(snapshot.titles[0]).toMatchObject({ title: "A Movie" });
    expect(snapshot.providers?.map((provider) => provider.id)).toEqual(["netflix"]);
  });

  it("calls the FlixPatrol Actor for India with enrichment disabled", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify([
        { platform: "Netflix", category: "TV Shows", rank: 1, title: "A Series", points: 100 },
        { platform: "Prime Video", category: "Movies", rank: 2, title: "A Movie", points: 80 },
      ]), { status: 200, headers: { "content-type": "application/json" } });
    };
    const adapter = createApifyAdapter({
      config: defaultConfig,
      env: { APIFY_API_TOKEN: "test-token" },
      ledger: {
        canSpend: async () => ({ source: "apify", endpoint: "streaming-charts", month: "2026-07", used: 0, endpointUsed: 0, allowed: true, warning: false }),
        recordAttempt: async () => ({ source: "apify", endpoint: "streaming-charts", month: "2026-07", used: 1, endpointUsed: 1, allowed: true, warning: false }),
      },
    });

    const snapshot = await adapter.fetch({
      region: "IN",
      feedKind: "streaming_charts",
      mediaTypes: ["movie", "series"],
      providerIds: ["netflix"],
      pageLimit: 1,
    }, { fetchImpl });

    expect(calls[0]?.url).toContain(`${APIFY_FLIXPATROL_ACTOR.replace("/", "~")}/run-sync-get-dataset-items`);
    expect(calls[0]?.url).toContain("maxItems=20");
    expect(calls[0]?.url).toContain(`maxTotalChargeUsd=${APIFY_FLIXPATROL_MAX_CHARGE_USD}`);
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      platform: "netflix",
      country: "india",
      contentType: "both",
      date: "today",
      maxItems: 20,
    });
    expect(snapshot).toMatchObject({
      source: "apify",
      feedKind: "streaming_charts",
      titles: [
        { title: "A Series", mediaType: "series", providerIds: ["netflix"], popularity: 100 },
        { title: "A Movie", mediaType: "movie", providerIds: ["prime"], popularity: 80 },
      ],
    });
    expect(snapshot.providers?.map((provider) => provider.id)).toEqual(["netflix", "prime"]);
  });

  it("calls the Letterboxd Actor for global weekly community popularity", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(input), init });
      return new Response(JSON.stringify([
        { title: "A Film", year: 2026, url: "https://letterboxd.com/film/a-film/" },
      ]), { status: 200, headers: { "content-type": "application/json" } });
    };
    const adapter = createApifyAdapter({
      config: defaultConfig,
      env: { APIFY_API_TOKEN: "test-token" },
      ledger: {
        canSpend: async () => ({ source: "apify", endpoint: "community-popular", month: "2026-07", used: 0, endpointUsed: 0, allowed: true, warning: false }),
        recordAttempt: async () => ({ source: "apify", endpoint: "community-popular", month: "2026-07", used: 1, endpointUsed: 1, allowed: true, warning: false }),
      },
    });

    const snapshot = await adapter.fetch({
      region: "ZZ",
      feedKind: "community_popular",
      mediaTypes: ["movie"],
      providerIds: [],
      pageLimit: 1,
    }, { fetchImpl });

    expect(calls[0]?.url).toContain(`${APIFY_LETTERBOXD_ACTOR.replace("/", "~")}/run-sync-get-dataset-items`);
    expect(calls[0]?.url).toContain(`maxTotalChargeUsd=${APIFY_LETTERBOXD_MAX_CHARGE_USD}`);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      mode: "popular_films",
      category: "this-week",
      maxResults: 40,
    });
    expect(snapshot).toMatchObject({
      source: "apify",
      feedKind: "community_popular",
      titles: [{ title: "A Film", mediaType: "movie" }],
    });
    expect(snapshot.attribution?.sourceLabel).toContain("Letterboxd");
  });

  it("preserves sanitized Apify billing errors without retrying the paid Actor", async () => {
    let calls = 0;
    const adapter = createApifyAdapter({
      config: defaultConfig,
      env: { APIFY_API_TOKEN: "secret-token" },
      ledger: {
        canSpend: async () => ({ source: "apify", endpoint: "streaming-charts", month: "2026-07", used: 0, endpointUsed: 0, allowed: true, warning: false }),
        recordAttempt: async () => ({ source: "apify", endpoint: "streaming-charts", month: "2026-07", used: 1, endpointUsed: 1, allowed: true, warning: false }),
      },
    });

    await expect(adapter.fetch({
      region: "IN",
      feedKind: "streaming_charts",
      mediaTypes: ["movie", "series"],
      providerIds: ["netflix"],
      pageLimit: 1,
    }, {
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify({
          error: {
            type: "not-enough-usage-to-run-paid-actor",
            message: "Add billing for secret-token",
          },
        }), { status: 402, headers: { "content-type": "application/json" } });
      },
    })).rejects.toMatchObject({
      status: 402,
      message: expect.stringContaining("not-enough-usage-to-run-paid-actor"),
    });
    await expect(adapter.fetch({
      region: "IN",
      feedKind: "streaming_charts",
      mediaTypes: ["movie", "series"],
      providerIds: ["netflix"],
      pageLimit: 1,
    }, {
      fetchImpl: async () => new Response(JSON.stringify({
        error: { type: "billing", message: "secret-token" },
      }), { status: 402, headers: { "content-type": "application/json" } }),
    })).rejects.not.toThrow(/secret-token/);
    expect(calls).toBe(1);
  });
});
