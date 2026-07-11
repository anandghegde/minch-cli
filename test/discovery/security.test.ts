import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/config/config";
import type { DiscoverySnapshot } from "../../src/discovery/adapter";
import type { BudgetStatus, RequestLedger } from "../../src/discovery/budget";
import { createDiscoveryCacheRepository } from "../../src/discovery/cache-repository";
import type { DiscoveryRequest } from "../../src/discovery/request";
import { sanitizeDiscoverySnapshot } from "../../src/discovery/security";
import { createDiscoveryService } from "../../src/discovery/service";
import { createStreamingAvailabilityAdapter } from "../../src/discovery/sources/streaming-availability";
import { createTmdbAdapter } from "../../src/discovery/sources/tmdb";

const NOW = 1_783_665_832_000;

function ledger(): Pick<RequestLedger, "recordAttempt" | "canSpend"> {
  const status = (
    source: BudgetStatus["source"],
    endpoint: string,
  ): BudgetStatus => ({
    source,
    endpoint,
    month: "2026-07",
    used: 1,
    endpointUsed: 1,
    allowed: true,
    warning: false,
    ...(source === "streaming-availability"
      ? { softWarning: 350, hardCap: 450, remaining: 449 }
      : {}),
  });
  return {
    recordAttempt: vi.fn(async (source, endpoint) => status(source, endpoint)),
    canSpend: vi.fn(async (source, endpoint) => status(source, endpoint)),
  };
}

function missingFile(): NodeJS.ErrnoException {
  const error = new Error("missing") as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
}

async function loadAndCapture(
  adapter: ReturnType<typeof createTmdbAdapter> | ReturnType<typeof createStreamingAvailabilityAdapter>,
  request: DiscoveryRequest,
  fetchImpl: typeof fetch,
): Promise<{ result: DiscoverySnapshot; persisted: string }> {
  let persisted = "";
  const cache = createDiscoveryCacheRepository({
    readFile: async () => {
      throw missingFile();
    },
    writeJson: async (_file, value) => {
      persisted = JSON.stringify(value);
    },
  });
  const service = createDiscoveryService({ cache, fetchImpl, now: () => NOW });
  const loaded = await service.load(adapter, request);
  await cache.flush();
  return { result: loaded.snapshot!, persisted };
}

describe("discovery security boundary", () => {
  it("removes C0/C1/bidi controls and credentials from normalized snapshots", () => {
    const secret = "key with/slash";
    const snapshot: DiscoverySnapshot = {
      source: "streaming-availability",
      titles: [{
        id: "title-1",
        title: `Safe\u001b[31m\u009b31m\u2066 ${secret}`,
        mediaType: "movie",
        originCountries: [],
        genreIds: [],
      }],
      events: [{
        id: "event-1",
        titleId: "title-1",
        kind: "streaming_added",
        region: "IN",
        datePrecision: "unknown",
        status: "unknown",
        firstObservedAt: NOW,
        lastObservedAt: NOW,
        evidence: [{
          source: "streaming-availability",
          sourceId: "1",
          sourceUrl: `https://example.test/watch?key=${encodeURIComponent(secret)}`,
          observedAt: NOW,
          confidence: "exact",
        }],
      }],
      fetchedAt: NOW,
      warnings: [{ code: "echo", message: `echo ${secret}\u0007` }],
    };

    const sanitized = sanitizeDiscoverySnapshot(snapshot, [secret]);
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(encodeURIComponent(secret));
    expect(serialized).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2066-\u2069]/u);
    expect(sanitized.events[0]?.evidence[0]).not.toHaveProperty("sourceUrl");
    expect(sanitized.titles[0]?.title).toContain("[redacted]");
  });

  it("keeps a TMDB bearer token out of URLs, normalized results, and persistent cache", async () => {
    const token = "tmdb-secret/cache-token";
    const calls: { url: string; headers: Headers }[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({
        page: 1,
        total_pages: 1,
        total_results: 1,
        results: [{
          id: 1,
          title: `Echo ${token}\u001b[31m`,
          original_title: token,
          media_type: "movie",
          release_date: "2026-07-10",
        }],
      }), { status: 200 });
    });
    const adapter = createTmdbAdapter({
      config: {
        ...defaultConfig,
        discovery: { tmdb: { readToken: token } },
      },
      ledger: ledger(),
      env: {},
      retries: 0,
      now: () => NOW,
    });
    const request: DiscoveryRequest = {
      region: "IN",
      feedKind: "trending",
      mediaTypes: ["movie", "series"],
      providerIds: [],
      pageLimit: 1,
    };

    const { result, persisted } = await loadAndCapture(adapter, request, fetchImpl);
    expect(calls[0]?.url).not.toContain(token);
    expect(calls[0]?.headers.get("authorization")).toBe(`Bearer ${token}`);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(persisted).not.toContain(token);
    expect(persisted).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/u);
  });

  it("keeps an OTT key out of URLs, source links, normalized results, and cache", async () => {
    const apiKey = "ott-secret/cache-key";
    const calls: { url: string; headers: Headers }[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({
        changes: [{
          changeType: "new",
          itemType: "show",
          showId: "show-1",
          showType: "movie",
          timestamp: 1_783_665_832,
          link: `https://example.test/watch?key=${encodeURIComponent(apiKey)}`,
          service: { id: "echo", name: `Provider ${apiKey}\u009b31m` },
        }],
        shows: {
          "show-1": {
            id: "show-1",
            title: `Echo ${apiKey}\u001b[31m`,
            originalTitle: apiKey,
            showType: "movie",
            genres: [{ id: 18, name: `Drama\u2066${apiKey}` }],
          },
        },
        hasMore: false,
      }), { status: 200 });
    });
    const adapter = createStreamingAvailabilityAdapter({
      config: {
        ...defaultConfig,
        discovery: { streamingAvailability: { apiKey } },
      },
      ledger: ledger(),
      env: {},
      retries: 0,
      now: () => NOW,
    });
    const request: DiscoveryRequest = {
      region: "IN",
      feedKind: "streaming_added",
      dateRange: { start: "2026-07-04", end: "2026-07-10", direction: "past" },
      mediaTypes: ["movie", "series"],
      providerIds: [],
      pageLimit: 1,
    };

    const { result, persisted } = await loadAndCapture(adapter, request, fetchImpl);
    expect(calls[0]?.url).not.toContain(apiKey);
    expect(calls[0]?.headers.get("x-api-key")).toBe(apiKey);
    expect(JSON.stringify(result)).not.toContain(apiKey);
    expect(result.events[0]?.evidence[0]).not.toHaveProperty("sourceUrl");
    expect(persisted).not.toContain(apiKey);
    expect(persisted).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2066-\u2069]/u);
  });
});
