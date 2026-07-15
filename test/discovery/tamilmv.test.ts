import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/config/config";
import type { BudgetStatus, RequestLedger } from "../../src/discovery/budget";
import { DiscoveryBudgetExceededError } from "../../src/discovery/budget";
import { aggregateDiscoverySnapshots } from "../../src/discovery/aggregate";
import type { DiscoveryRequest } from "../../src/discovery/request";
import { firecrawlScrape, FirecrawlContractError } from "../../src/discovery/sources/firecrawl";
import {
  cleanTamilmvTitle,
  createTamilmvAdapter,
  parseTamilmvLatestHtml,
  safeTamilmvLink,
} from "../../src/discovery/sources/tamilmv";
import { HttpError } from "../../src/util/net";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/tamilmv-latest.html",
);
const NOW = 1_784_000_000_000;

function ledger(allowed = true) {
  const status: BudgetStatus = {
    source: "tamilmv",
    endpoint: "scrape:homepage",
    month: "2026-07",
    used: 1,
    endpointUsed: 1,
    allowed,
    warning: false,
    hardCap: 60,
  };
  return {
    canSpend: vi.fn<Pick<RequestLedger, "canSpend">["canSpend"]>(async () => status),
    recordAttempt: vi.fn<Pick<RequestLedger, "recordAttempt">["recordAttempt"]>(
      async () => status,
    ),
  };
}

function request(overrides: Partial<DiscoveryRequest> = {}): DiscoveryRequest {
  return {
    region: "IN",
    feedKind: "tamilmv_latest",
    mediaTypes: ["movie", "series"],
    providerIds: [],
    pageLimit: 1,
    ...overrides,
  };
}

describe("TamilMV title cleaning", () => {
  it("strips release noise and keeps the core title", () => {
    expect(cleanTamilmvTitle(
      "Ek Din (2026) Tamil TRUE WEB-DL - [1080p & 720p - AVC - 2.8GB] - ESub",
    )).toEqual({ title: "Ek Din", year: 2026 });
    expect(cleanTamilmvTitle(
      "Gurthukosthunnayi (2026) S01 EP (01-07) Telugu TRUE WEB-DL - [1080p]",
    ).title).toBe("Gurthukosthunnayi");
  });
});

describe("TamilMV HTML parser", () => {
  it("parses latest topic rows and drops unsafe or chrome links", () => {
    const html = readFileSync(FIXTURE, "utf8");
    const parsed = parseTamilmvLatestHtml(html, "https://www.1tamilmv.reisen/");
    expect(parsed.items.map((item) => item.title)).toEqual([
      "Ek Din",
      "Gurthukosthunnayi",
      "Housekeeping",
    ]);
    expect(parsed.items[0]).toMatchObject({
      year: 2026,
      mediaType: "movie",
      formatLabel: "TRUE WEB-DL",
      audioLanguages: ["ta"],
      listedDate: "2026-07-15",
      topicId: "198858",
    });
    expect(parsed.items[1]).toMatchObject({
      mediaType: "series",
      audioLanguages: ["te"],
      listedDate: "2026-07-14",
    });
    expect(parsed.items[2]).toMatchObject({
      year: 1987,
      formatLabel: "BluRay",
      audioLanguages: ["ta", "te", "hi", "en"],
    });
    expect(parsed.warnings.some((warning) => warning.code === "unsafe-link")).toBe(true);
    expect(safeTamilmvLink("https://evil.example/x", "https://www.1tamilmv.reisen/")).toBeUndefined();
  });
});

describe("Firecrawl client", () => {
  it("posts to /v2/scrape and returns html", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("https://api.firecrawl.dev/v2/scrape");
      expect(init?.method).toBe("POST");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fc-test");
      return new Response(JSON.stringify({
        success: true,
        data: { html: "<html>ok</html>" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const result = await firecrawlScrape({
      apiKey: "fc-test",
      url: "https://www.1tamilmv.reisen/",
      fetchImpl,
      retries: 0,
    });
    expect(result.html).toBe("<html>ok</html>");
  });

  it("maps empty content to a contract error", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify({ data: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    await expect(firecrawlScrape({
      apiKey: "fc-test",
      url: "https://www.1tamilmv.reisen/",
      fetchImpl,
      retries: 0,
    })).rejects.toBeInstanceOf(FirecrawlContractError);
  });
});

describe("TamilMV adapter", () => {
  it("requires a Firecrawl key", async () => {
    const adapter = createTamilmvAdapter({
      config: defaultConfig,
      ledger: ledger(),
      now: () => NOW,
      env: {},
    });
    expect(adapter.isConfigured()).toBe(false);
    await expect(adapter.fetch(request(), { fetchImpl: vi.fn() }))
      .rejects.toMatchObject({ status: 401 });
  });

  it("maps scraped HTML into a discovery snapshot", async () => {
    const html = readFileSync(FIXTURE, "utf8");
    const attempts = ledger();
    const adapter = createTamilmvAdapter({
      config: {
        ...defaultConfig,
        discovery: { firecrawl: { apiKey: "fc-test" } },
      },
      ledger: attempts,
      now: () => NOW,
      retries: 0,
      env: {},
      scrapeImpl: async () => ({ html, sourceUrl: "https://www.1tamilmv.reisen/" }),
    });

    const snapshot = await adapter.fetch(request(), {
      fetchImpl: vi.fn(async () => new Response("unused")),
    });

    expect(attempts.canSpend).toHaveBeenCalledWith("tamilmv", "scrape:homepage");
    expect(attempts.recordAttempt).toHaveBeenCalledWith("tamilmv", "scrape:homepage");
    expect(snapshot.source).toBe("tamilmv");
    expect(snapshot.feedKind).toBe("tamilmv_latest");
    expect(snapshot.titles).toHaveLength(3);
    expect(snapshot.events).toHaveLength(3);
    expect(snapshot.titles[0]?.title).toBe("Ek Din");
    expect(snapshot.events[0]?.evidence[0]?.source).toBe("tamilmv");
    expect(snapshot.events[0]?.region).toBe("IN");
    expect(snapshot.attribution?.sourceLabel).toBe("1TamilMV");
  });

  it("respects the request budget", async () => {
    const adapter = createTamilmvAdapter({
      config: {
        ...defaultConfig,
        discovery: { firecrawl: { apiKey: "fc-test" } },
      },
      ledger: ledger(false),
      now: () => NOW,
      env: {},
      scrapeImpl: async () => ({ html: "<html></html>", sourceUrl: "https://www.1tamilmv.reisen/" }),
    });
    await expect(adapter.fetch(request(), { fetchImpl: vi.fn() }))
      .rejects.toBeInstanceOf(DiscoveryBudgetExceededError);
  });

  it("rejects unsupported feed kinds", async () => {
    const adapter = createTamilmvAdapter({
      config: {
        ...defaultConfig,
        discovery: { firecrawl: { apiKey: "fc-test" } },
      },
      ledger: ledger(),
      now: () => NOW,
      env: {},
    });
    await expect(adapter.fetch(request({ feedKind: "trending" }), { fetchImpl: vi.fn() }))
      .rejects.toBeInstanceOf(Error);
  });

  it("classifies events into the tamilmv feed only", async () => {
    const html = readFileSync(FIXTURE, "utf8");
    const adapter = createTamilmvAdapter({
      config: {
        ...defaultConfig,
        discovery: { firecrawl: { apiKey: "fc-test" } },
      },
      ledger: ledger(),
      now: () => NOW,
      env: {},
      scrapeImpl: async () => ({ html, sourceUrl: "https://www.1tamilmv.reisen/" }),
    });
    const snapshot = await adapter.fetch(request(), { fetchImpl: vi.fn() });
    const aggregation = aggregateDiscoverySnapshots([snapshot]);
    expect(aggregation.feeds.tamilmv).toHaveLength(3);
    expect(aggregation.feeds.india).toHaveLength(0);
    expect(aggregation.feeds.ott).toHaveLength(0);
  });

  it("surfaces disabled adapters as HTTP 403", async () => {
    const adapter = createTamilmvAdapter({
      config: {
        ...defaultConfig,
        discovery: {
          firecrawl: { apiKey: "fc-test" },
          disabledSources: ["tamilmv"],
        },
      },
      ledger: ledger(),
      now: () => NOW,
      env: {},
    });
    await expect(adapter.fetch(request(), { fetchImpl: vi.fn() }))
      .rejects.toBeInstanceOf(HttpError);
  });
});
