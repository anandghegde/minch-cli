import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { BudgetStatus, RequestLedger } from "../../src/discovery/budget";
import {
  createTmdbClient,
  parseTmdbListPage,
  parseTmdbReleaseDates,
  parseTmdbWatchProviders,
  TmdbContractError,
} from "../../src/discovery/sources/tmdb";
import { HttpError } from "../../src/util/net";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as T;
}

function budgetStatus(): BudgetStatus {
  return {
    source: "tmdb",
    endpoint: "list",
    month: "2026-07",
    used: 1,
    endpointUsed: 1,
    allowed: true,
    warning: false,
  };
}

function ledger() {
  return {
    recordAttempt: vi.fn<Pick<RequestLedger, "recordAttempt">["recordAttempt"]>(
      async () => budgetStatus(),
    ),
  };
}

describe("TMDB response guards", () => {
  it("keeps valid list rows and turns malformed rows into warnings", () => {
    const raw = fixture<{ results: unknown[] }>("tmdb-discover-movie.json");
    raw.results.push({ id: "bad", title: "Malformed" }, null);
    const parsed = parseTmdbListPage(raw);

    expect(parsed.rows).toHaveLength(5);
    expect(parsed.rows[0]).toMatchObject({
      id: 1001,
      title: "Sample Indian Film",
      originalLanguage: "hi",
      genreIds: [18],
    });
    expect(parsed.warnings).toHaveLength(2);
    expect(() => parseTmdbListPage({ page: 1 })).toThrow(TmdbContractError);
  });

  it("parses regional type-4/type-5 releases and India watch providers", () => {
    const digital = parseTmdbReleaseDates(
      fixture("tmdb-movie-release-dates-digital.json"),
    );
    const physical = parseTmdbReleaseDates(
      fixture("tmdb-movie-release-dates-physical.json"),
    );
    const providers = parseTmdbWatchProviders(
      fixture("tmdb-movie-watch-providers.json"),
    );

    expect(digital.countries.find((country) => country.region === "IN")?.releases)
      .toEqual([expect.objectContaining({ type: 4 })]);
    expect(physical.countries[0]?.releases)
      .toEqual([expect.objectContaining({ type: 5 })]);
    expect(providers.regions.IN).toMatchObject({
      link: expect.stringContaining("locale=IN"),
      rent: [{ id: 101, name: "Example Store" }],
      buy: [{ id: 101, name: "Example Store" }],
    });
  });
});

describe("typed TMDB client", () => {
  it("uses bearer auth, forwards abort, retries resiliently, and counts every attempt", async () => {
    const attempts = ledger();
    const calls: { url: string; init?: RequestInit }[] = [];
    let responseNumber = 0;
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      calls.push({ url: String(input), init });
      responseNumber += 1;
      if (responseNumber === 1) return new Response(null, { status: 503 });
      return new Response(
        JSON.stringify(fixture("tmdb-discover-movie.json")),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const client = createTmdbClient({
      token: "tmdb-secret-token",
      fetchImpl,
      ledger: attempts,
      retries: 1,
      sleepImpl: async () => {},
    });

    const result = await client.getListPages(
      "/discover/movie",
      { region: "IN", with_release_type: 4 },
      "discover-digital",
      1,
      controller.signal,
    );

    expect(result.rows).toHaveLength(5);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(attempts.recordAttempt).toHaveBeenCalledTimes(2);
    expect(calls.every((call) => !call.url.includes("tmdb-secret-token"))).toBe(true);
    expect(new Headers(calls[0]!.init?.headers).get("authorization"))
      .toBe("Bearer tmdb-secret-token");
    expect(calls[0]!.init?.signal).toBe(controller.signal);
    expect(JSON.stringify(result)).not.toContain("tmdb-secret-token");
  });

  it("honors the page limit even when TMDB advertises more pages", async () => {
    const attempts = ledger();
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const page = Number(new URL(String(input)).searchParams.get("page"));
      return new Response(JSON.stringify({
        page,
        total_pages: 9,
        total_results: 9,
        results: [{ id: page, title: `Page ${page}` }],
      }), { status: 200 });
    });
    const client = createTmdbClient({
      token: "token",
      fetchImpl,
      ledger: attempts,
      retries: 0,
    });

    await expect(client.getListPages("/trending/all/week", {}, "trending", 2))
      .resolves.toMatchObject({ pages: 2, totalPages: 9, rows: [{ id: 1 }, { id: 2 }] });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(client.getListPages("/trending/all/week", {}, "trending", 5))
      .rejects.toThrow("between 1 and 4");
  });

  it("surfaces 401 without retrying and never leaks its body", async () => {
    const attempts = ledger();
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response("credential detail must stay private", { status: 401 }));
    const client = createTmdbClient({
      token: "token",
      fetchImpl,
      ledger: attempts,
      retries: 2,
    });

    let caught: unknown;
    try {
      await client.getJson("/trending/all/week", {}, "trending");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect(caught).toMatchObject({ status: 401, message: "TMDB request failed (HTTP 401)" });
    expect(JSON.stringify(caught)).not.toContain("credential detail");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(attempts.recordAttempt).toHaveBeenCalledTimes(1);
  });

  it("replaces transport errors with a token-safe network failure", async () => {
    const client = createTmdbClient({
      token: "tmdb-transport-secret",
      fetchImpl: async () => {
        throw new Error("socket failed for tmdb-transport-secret\u001b[31m");
      },
      ledger: ledger(),
      retries: 0,
    });

    let caught: unknown;
    try {
      await client.getJson("/trending/all/week", {}, "trending");
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      name: "Error",
      message: "socket failed for [redacted][31m",
    });
    expect((caught as Error).message).not.toContain("tmdb-transport-secret");
  });

  it("honors Retry-After on 429, meters the retry, and forwards aborts", async () => {
    const attempts = ledger();
    const delays: number[] = [];
    let call = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      call += 1;
      if (call === 1) {
        return new Response(null, { status: 429, headers: { "retry-after": "3" } });
      }
      return new Response(JSON.stringify({ page: 1, total_pages: 1, total_results: 0, results: [] }), {
        status: 200,
      });
    });
    const client = createTmdbClient({
      token: "token",
      fetchImpl,
      ledger: attempts,
      retries: 1,
      sleepImpl: async (ms) => void delays.push(ms),
    });

    await expect(client.getListPages("/trending/all/week", {}, "trending", 1))
      .resolves.toMatchObject({ rows: [] });
    expect(delays).toEqual([expect.any(Number)]);
    expect(delays[0]).toBeGreaterThanOrEqual(3_000);
    expect(attempts.recordAttempt).toHaveBeenCalledTimes(2);

    const controller = new AbortController();
    controller.abort();
    await expect(
      client.getJson("/trending/all/week", {}, "trending", controller.signal),
    ).rejects.toMatchObject({ status: 0, message: "aborted" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
