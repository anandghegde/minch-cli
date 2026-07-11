import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/config/config";
import type { BudgetStatus, RequestLedger } from "../../src/discovery/budget";
import {
  createTmdbEnricher,
  TMDB_ENRICHMENT_TTL_MS,
} from "../../src/discovery/sources/tmdb";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const START = 1_783_665_832_000;

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

describe("lazy TMDB enrichment", () => {
  it("fetches only explicitly missing fields and caches them by media type + ID", async () => {
    const paths: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path.endsWith("/external_ids")) {
        return new Response(JSON.stringify({ id: 1001, imdb_id: "tt9001001" }), { status: 200 });
      }
      if (path.endsWith("/watch/providers")) {
        return new Response(JSON.stringify(fixture("tmdb-movie-watch-providers.json")), { status: 200 });
      }
      return new Response(null, { status: 404 });
    });
    const enricher = createTmdbEnricher({
      config: defaultConfig,
      env: { TMDB_READ_TOKEN: "token" },
      ledger: ledger(),
      now: () => START,
      retries: 0,
    });

    const identity = await enricher.enrich(
      { tmdbId: 1001, mediaType: "movie", missingFields: ["external_ids"] },
      { fetchImpl },
    );
    await enricher.enrich(
      { tmdbId: 1001, mediaType: "movie", missingFields: ["external_ids"] },
      { fetchImpl },
    );
    const offers = await enricher.enrich(
      { tmdbId: 1001, mediaType: "movie", missingFields: ["watch_providers"] },
      { fetchImpl },
    );

    expect(identity.imdbId).toBe("tt9001001");
    expect(paths).toEqual([
      "/3/movie/1001/external_ids",
      "/3/movie/1001/watch/providers",
    ]);
    expect(offers.watchProviders?.regions.IN).toMatchObject({
      rent: [{ id: 101, name: "Example Store" }],
    });
    expect("events" in offers).toBe(false);
  });

  it("maps requested details and exact regional releases without row-wide enrichment", async () => {
    const paths: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      if (path.endsWith("/release_dates")) {
        return new Response(
          JSON.stringify(fixture("tmdb-movie-release-dates-digital.json")),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({
        id: 1001,
        title: "Sample Indian Film",
        original_title: "Sample Indian Film",
        original_language: "hi",
        production_countries: [{ iso_3166_1: "IN", name: "India" }],
        genres: [{ id: 18, name: "Drama" }],
        release_date: "2026-07-10",
        poster_path: "/fixture.jpg",
        popularity: 42,
      }), { status: 200 });
    });
    const enricher = createTmdbEnricher({
      config: defaultConfig,
      env: { TMDB_READ_TOKEN: "token" },
      ledger: ledger(),
      now: () => START,
      retries: 0,
    });

    const result = await enricher.enrich(
      {
        tmdbId: 1001,
        mediaType: "movie",
        missingFields: ["metadata", "regional_releases"],
      },
      { fetchImpl },
    );

    expect(paths.sort()).toEqual([
      "/3/movie/1001",
      "/3/movie/1001/release_dates",
    ]);
    expect(result.title).toMatchObject({
      tmdbId: 1001,
      mediaType: "movie",
      year: 2026,
      originalLanguage: "hi",
      originCountries: ["IN"],
      genreIds: [18],
    });
    expect(result.releaseDates?.countries[0]?.releases[0]).toMatchObject({ type: 4 });
  });

  it("expires enrichment fields after seven days and avoids unsupported series release calls", async () => {
    let now = START;
    const paths: string[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      paths.push(new URL(String(input)).pathname);
      return new Response(JSON.stringify({ id: 1001, imdb_id: "tt9001001" }), { status: 200 });
    });
    const enricher = createTmdbEnricher({
      config: defaultConfig,
      env: { TMDB_READ_TOKEN: "token" },
      ledger: ledger(),
      now: () => now,
      retries: 0,
    });
    const identityRequest = {
      tmdbId: 1001,
      mediaType: "movie" as const,
      missingFields: ["external_ids" as const],
    };

    await enricher.enrich(identityRequest, { fetchImpl });
    now += TMDB_ENRICHMENT_TTL_MS;
    await enricher.enrich(identityRequest, { fetchImpl });
    const series = await enricher.enrich(
      { tmdbId: 2002, mediaType: "series", missingFields: ["regional_releases"] },
      { fetchImpl },
    );

    expect(paths).toEqual([
      "/3/movie/1001/external_ids",
      "/3/movie/1001/external_ids",
    ]);
    expect(series.warnings).toEqual([
      expect.objectContaining({ code: "unsupported-regional-releases" }),
    ]);
  });
});
