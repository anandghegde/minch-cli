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
  buildTamilmvListingUrls,
  cleanTamilmvTitle,
  createTamilmvAdapter,
  mergeTamilmvItems,
  parseTamilmvLatestHtml,
  safeTamilmvLink,
  titleFromTamilmvSlug,
  TAMILMV_MAX_ITEMS,
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
    hardCap: 120,
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

  it("cleans slug-style titles", () => {
    expect(cleanTamilmvTitle("mark 2026 telugu true web dl 1080p 720p")).toEqual({
      title: "mark",
      year: 2026,
    });
    expect(titleFromTamilmvSlug(
      "https://www.1tamilmv.reisen/index.php?/forums/topic/198781-mark-2026-telugu-true-web-dl-1080p/",
    )).toMatch(/mark 2026/i);
  });
});

describe("TamilMV HTML parser", () => {
  it("parses latest, week-release, and slug-backed rows", () => {
    const html = readFileSync(FIXTURE, "utf8");
    const parsed = parseTamilmvLatestHtml(html, "https://www.1tamilmv.reisen/");
    const titles = parsed.items.map((item) => item.title);
    expect(titles).toContain("Ek Din");
    expect(titles).toContain("Gurthukosthunnayi");
    expect(titles).toContain("Housekeeping");
    expect(titles).toContain("Ride or Die");
    expect(titles).toContain("Second Love");
    expect(titles).toContain("mark");
    expect(titles).not.toContain("Languages");
    expect(parsed.items.length).toBeGreaterThanOrEqual(6);

    const ekDin = parsed.items.find((item) => item.topicId === "198858");
    expect(ekDin).toMatchObject({
      year: 2026,
      mediaType: "movie",
      formatLabel: "TRUE WEB-DL",
      audioLanguages: ["ta"],
      listedDate: "2026-07-15",
    });
    expect(parsed.warnings.some((warning) => warning.code === "unsafe-link")).toBe(true);
    expect(safeTamilmvLink("https://evil.example/x", "https://www.1tamilmv.reisen/")).toBeUndefined();
  });

  it("builds multi-page listing URLs", () => {
    const urls = buildTamilmvListingUrls("https://www.1tamilmv.reisen/", 3);
    expect(urls).toHaveLength(3);
    expect(urls[0]).toMatch(/1tamilmv\.reisen/);
    expect(urls[1]).toContain("forums");
    expect(urls[2]).toContain("discover");
  });

  it("merges and caps items by topic id", () => {
    const merged = mergeTamilmvItems([
      {
        rawTitle: "A (2026) WEB-DL",
        title: "A",
        year: 2026,
        mediaType: "movie",
        audioLanguages: [],
        topicId: "1",
        sourceUrl: "https://www.1tamilmv.reisen/index.php?/forums/topic/11111-a/",
      },
      {
        rawTitle: "A again (2026) WEB-DL",
        title: "A again",
        year: 2026,
        mediaType: "movie",
        audioLanguages: [],
        topicId: "1",
        sourceUrl: "https://www.1tamilmv.reisen/index.php?/forums/topic/11111-a/",
      },
      {
        rawTitle: "B (2026) WEB-DL",
        title: "B",
        year: 2026,
        mediaType: "movie",
        audioLanguages: [],
        topicId: "2",
        sourceUrl: "https://www.1tamilmv.reisen/index.php?/forums/topic/22222-b/",
      },
    ], 1);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.title).toBe("A");
    expect(TAMILMV_MAX_ITEMS).toBeGreaterThanOrEqual(200);
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
    expect(snapshot.titles.length).toBeGreaterThanOrEqual(6);
    expect(snapshot.events.length).toBe(snapshot.titles.length);
    expect(snapshot.titles.some((title) => title.title === "Ek Din")).toBe(true);
    expect(snapshot.titles.some((title) => title.title === "Ride or Die")).toBe(true);
    expect(snapshot.events[0]?.evidence[0]?.source).toBe("tamilmv");
    expect(snapshot.events[0]?.region).toBe("IN");
    expect(snapshot.attribution?.sourceLabel).toBe("1TamilMV");
  });

  it("scrapes multiple listing pages when pageLimit allows", async () => {
    const home = readFileSync(FIXTURE, "utf8");
    const forums = `
      <a class="ipsDataItem_title"
         href="https://www.1tamilmv.reisen/index.php?/forums/topic/199001-recent-add-2026-tamil-web-dl/">
        Recent Add (2026) Tamil WEB-DL
      </a>`;
    const attempts = ledger();
    const scraped: string[] = [];
    const adapter = createTamilmvAdapter({
      config: {
        ...defaultConfig,
        discovery: { firecrawl: { apiKey: "fc-test" } },
      },
      ledger: attempts,
      now: () => NOW,
      retries: 0,
      env: {},
      scrapeImpl: async ({ url }) => {
        scraped.push(url);
        return {
          html: scraped.length === 1 ? home : forums,
          sourceUrl: url,
        };
      },
    });

    const snapshot = await adapter.fetch(request({ pageLimit: 2 }), {
      fetchImpl: vi.fn(),
    });

    expect(scraped).toHaveLength(2);
    expect(scraped[1]).toContain("forums");
    expect(attempts.recordAttempt).toHaveBeenCalledWith("tamilmv", "scrape:listing:1");
    expect(snapshot.titles.some((title) => title.title === "Recent Add")).toBe(true);
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
    expect(aggregation.feeds.tamilmv.length).toBeGreaterThanOrEqual(6);
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
