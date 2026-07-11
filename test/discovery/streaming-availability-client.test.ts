import { describe, expect, it, vi } from "vitest";
import type { BudgetStatus, RequestLedger } from "../../src/discovery/budget";
import { DiscoveryBudgetExceededError } from "../../src/discovery/budget";
import {
  createStreamingAvailabilityClient,
  StreamingAvailabilityContractError,
} from "../../src/discovery/sources/streaming-availability";

function ledger() {
  const status: BudgetStatus = {
    source: "streaming-availability",
    endpoint: "countries",
    month: "2026-07",
    used: 1,
    endpointUsed: 1,
    allowed: true,
    warning: false,
    softWarning: 350,
    hardCap: 450,
    remaining: 449,
  };
  return {
    recordAttempt: vi.fn<Pick<RequestLedger, "recordAttempt">["recordAttempt"]>(
      async () => status,
    ),
  };
}

describe("fixed direct Streaming Availability client", () => {
  it("uses only the direct host and X-API-Key without leaking the key into URLs/results", async () => {
    const calls: { url: URL; headers: Headers }[] = [];
    const attempts = ledger();
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      calls.push({ url: new URL(String(input)), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify({ countryCode: "in", name: "India", services: [] }), {
        status: 200,
      });
    });
    const client = createStreamingAvailabilityClient({
      apiKey: "direct-secret-key",
      fetchImpl,
      ledger: attempts,
      retries: 0,
    });

    const result = await client.getJson(
      "/countries/in",
      { output_language: "en" },
      "countries",
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.origin).toBe("https://api.movieofthenight.com");
    expect(calls[0]!.url.pathname).toBe("/v4/countries/in");
    expect(calls[0]!.url.searchParams.get("output_language")).toBe("en");
    expect(calls[0]!.url.href).not.toContain("direct-secret-key");
    expect(calls[0]!.headers.get("x-api-key")).toBe("direct-secret-key");
    expect(calls[0]!.headers.has("x-rapidapi-key")).toBe(false);
    expect(attempts.recordAttempt).toHaveBeenCalledWith(
      "streaming-availability",
      "countries",
    );
    expect(JSON.stringify(result)).not.toContain("direct-secret-key");
  });

  it("meters every retry attempt", async () => {
    const attempts = ledger();
    let call = 0;
    const client = createStreamingAvailabilityClient({
      apiKey: "key",
      fetchImpl: async () => {
        call += 1;
        return call === 1
          ? new Response(null, { status: 503 })
          : new Response(JSON.stringify({ changes: [], shows: {}, hasMore: false }), {
              status: 200,
            });
      },
      ledger: attempts,
      retries: 1,
      sleepImpl: async () => {},
    });

    await expect(client.getJson("/changes", {}, "changes")).resolves.toMatchObject({
      hasMore: false,
    });
    expect(attempts.recordAttempt).toHaveBeenCalledTimes(2);
  });

  it("rejects absolute/escaping paths instead of allowing a transport override", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = createStreamingAvailabilityClient({
      apiKey: "key",
      fetchImpl,
      ledger: ledger(),
    });

    await expect(client.getJson("https://marketplace.invalid/changes", {}, "changes"))
      .rejects.toBeInstanceOf(StreamingAvailabilityContractError);
    await expect(client.getJson("/../changes", {}, "changes"))
      .rejects.toBeInstanceOf(StreamingAvailabilityContractError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns token-safe HTTP errors", async () => {
    const client = createStreamingAvailabilityClient({
      apiKey: "secret",
      fetchImpl: async () => new Response("secret echoed", { status: 401 }),
      ledger: ledger(),
      retries: 0,
    });

    await expect(client.getJson("/countries/in", {}, "countries"))
      .rejects.toMatchObject({
        status: 401,
        message: "Streaming Availability request failed (HTTP 401)",
      });
  });

  it("replaces transport errors with a key-safe network failure", async () => {
    const client = createStreamingAvailabilityClient({
      apiKey: "streaming-transport-secret",
      fetchImpl: async () => {
        throw new Error("socket failed for streaming-transport-secret\u001b[31m");
      },
      ledger: ledger(),
      retries: 0,
    });

    let caught: unknown;
    try {
      await client.getJson("/changes", {}, "changes");
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      name: "Error",
      message: "socket failed for [redacted][31m",
    });
    expect((caught as Error).message).not.toContain("streaming-transport-secret");
  });

  it("preserves Retry-After timing on a terminal 429", async () => {
    const client = createStreamingAvailabilityClient({
      apiKey: "key",
      fetchImpl: async () => new Response(null, {
        status: 429,
        headers: { "retry-after": "120" },
      }),
      ledger: ledger(),
      retries: 0,
    });

    await expect(client.getJson("/changes", {}, "changes")).rejects.toMatchObject({
      status: 429,
      retryAfterMs: 120_000,
    });
  });

  it("does not start a network call after the local hard cap", async () => {
    const attempts = ledger();
    attempts.recordAttempt.mockRejectedValue(new DiscoveryBudgetExceededError({
      source: "streaming-availability",
      endpoint: "changes",
      month: "2026-07",
      used: 450,
      endpointUsed: 450,
      allowed: false,
      warning: true,
      softWarning: 350,
      hardCap: 450,
      remaining: 0,
    }));
    const fetchImpl = vi.fn<typeof fetch>();
    const client = createStreamingAvailabilityClient({
      apiKey: "key",
      fetchImpl,
      ledger: attempts,
      retries: 0,
    });

    await expect(client.getJson("/changes", {}, "changes"))
      .rejects.toBeInstanceOf(DiscoveryBudgetExceededError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
