import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { BudgetStatus, RequestLedger } from "../../src/discovery/budget";
import { createDiscoveryCacheRepository } from "../../src/discovery/cache-repository";
import type { DiscoveryRequest } from "../../src/discovery/request";
import { createDiscoveryService } from "../../src/discovery/service";
import {
  BLURAY_ATTRIBUTION,
  blurayCalendarDate,
  createBlurayAdapter,
  enrichBlurayIdentities,
  normalizeBlurayIdentityTitle,
  parseBlurayRss,
  sanitizeBlurayText,
} from "../../src/discovery/sources/bluray";
import { USER_AGENT } from "../../src/util/net";
import type { DiscoverySnapshot } from "../../src/discovery/adapter";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/bluray-new-releases.xml",
);
const NOW = 1_783_665_832_000;

function ledger() {
  const status: BudgetStatus = {
    source: "bluray",
    endpoint: "rss",
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

function request(overrides: Partial<DiscoveryRequest> = {}): DiscoveryRequest {
  return {
    region: "ZZ",
    feedKind: "bluray",
    dateRange: { start: "2026-07-01", end: "2026-07-31", direction: "past" },
    mediaTypes: ["movie"],
    providerIds: [],
    pageLimit: 1,
    ...overrides,
  };
}

describe("Blu-ray RSS adapter", () => {
  it("maps the sanitized feed to honest unknown-region Blu-ray/4K events", async () => {
    const xml = readFileSync(FIXTURE, "utf8");
    const attempts = ledger();
    const calls: RequestInit[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      calls.push(init ?? {});
      return new Response(xml, { status: 200, headers: { "content-type": "text/xml" } });
    });
    const adapter = createBlurayAdapter({
      ledger: attempts,
      now: () => NOW,
      retries: 0,
    });

    const snapshot = await adapter.fetch(request(), { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(attempts.recordAttempt).toHaveBeenCalledWith("bluray", "rss");
    expect(new Headers(calls[0]!.headers).get("user-agent")).toBe(USER_AGENT);
    expect(snapshot.titles).toHaveLength(5);
    expect(snapshot.events).toHaveLength(5);
    expect(snapshot.titles.slice(0, 2).map((title) => title.title)).toEqual([
      "The Elephant Man",
      "The Elephant Man",
    ]);
    expect(snapshot.events[0]).toMatchObject({
      kind: "bluray",
      region: "ZZ",
      date: "2026-07-07",
      datePrecision: "day",
      formatLabel: "Blu-ray",
      status: "past",
      evidence: [{ source: "bluray", confidence: "source_claim" }],
    });
    expect(snapshot.events[1]).toMatchObject({
      kind: "uhd_bluray",
      formatLabel: "4K UHD Blu-ray",
    });
    expect(snapshot.events[3]).toMatchObject({
      datePrecision: "unknown",
      status: "unknown",
    });
    expect(snapshot.events[3]!.date).toBeUndefined();
    expect(snapshot.attribution).toEqual(BLURAY_ATTRIBUTION);
  });

  it("preserves the advertised calendar day and rejects any region claim", async () => {
    expect(blurayCalendarDate("Tue, 07 Jul 2026 00:00:00 -0400"))
      .toBe("2026-07-07");
    expect(blurayCalendarDate("Tue, 31 Feb 2026 00:00:00 -0400"))
      .toBeUndefined();
    expect(() => parseBlurayRss("<not-rss />")).toThrow("channel is missing");

    const fetchImpl = vi.fn<typeof fetch>();
    const adapter = createBlurayAdapter({ ledger: ledger(), now: () => NOW });
    await expect(adapter.fetch(request({ region: "IN" }), { fetchImpl }))
      .rejects.toThrow("region must remain unknown");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sanitizes HTML/control text, drops unsafe links, and prefers a stable GUID", async () => {
    expect(sanitizeBlurayText("<b>Safe</b>\u001b[31m Red\u001b[0m\u0007"))
      .toBe("Safe Red");
    const parsed = parseBlurayRss(`<?xml version="1.0"?>
      <rss><channel><item>
        <title><![CDATA[<b>Safe &amp; Sound</b>]]></title>
        <link>javascript:alert(1)</link>
        <guid>stable-guid-1</guid>
        <description><![CDATA[<p>Studio <em>description</em></p>]]></description>
        <category>blu-ray</category>
      </item></channel></rss>`);

    expect(parsed.items[0]).toMatchObject({
      title: "Safe & Sound",
      guid: "stable-guid-1",
      description: "Studio description",
    });
    expect(parsed.items[0]!.link).toBeUndefined();
    expect(parsed.warnings).toEqual([
      expect.objectContaining({ code: "unsafe-link" }),
    ]);
  });

  it("uses the shared 24-hour cache policy to avoid a second feed fetch", async () => {
    const xml = readFileSync(FIXTURE, "utf8");
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(xml, { status: 200 }));
    const repository = createDiscoveryCacheRepository({
      readFile: async () => {
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
      writeJson: async () => {},
    });
    const service = createDiscoveryService({ cache: repository, fetchImpl, now: () => NOW });
    const adapter = createBlurayAdapter({ ledger: ledger(), now: () => NOW, retries: 0 });

    expect((await service.load(adapter, request())).cacheState).toBe("refreshed");
    expect((await service.load(adapter, request())).cacheState).toBe("fresh");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("handles single-item/entity variants, deduplicates exact GUID items, and keeps generic format generic", async () => {
    const xml = `<?xml version="1.0"?>
      <rss><channel>
        <item><title>Generic &amp; Disc</title><guid>same-guid</guid><pubDate>10 Jul 2026 00:00:00 -0400</pubDate></item>
        <item><title>Generic &amp; Disc</title><guid>same-guid</guid><pubDate>10 Jul 2026 00:00:00 -0400</pubDate></item>
      </channel></rss>`;
    expect(parseBlurayRss(`<?xml version="1.0"?><rss><channel><item><title>A &amp; B</title></item></channel></rss>`)
      .items).toEqual([expect.objectContaining({ title: "A & B" })]);
    const adapter = createBlurayAdapter({ ledger: ledger(), now: () => NOW, retries: 0 });
    const snapshot = await adapter.fetch(request(), {
      fetchImpl: async () => new Response(xml, { status: 200 }),
    });

    expect(snapshot.titles).toHaveLength(1);
    expect(snapshot.events).toEqual([
      expect.objectContaining({ kind: "physical", formatLabel: "Physical" }),
    ]);
    expect(snapshot.warnings).toEqual([
      expect.objectContaining({ code: "duplicate-item", sourceRecordId: "same-guid" }),
    ]);
  });

  it("returns stale cached RSS when the feed is offline", async () => {
    const xml = readFileSync(FIXTURE, "utf8");
    let now = NOW;
    let offline = false;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      if (offline) throw new Error("offline");
      return new Response(xml, { status: 200 });
    });
    const repository = createDiscoveryCacheRepository({
      readFile: async () => {
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
      writeJson: async () => {},
    });
    const service = createDiscoveryService({ cache: repository, fetchImpl, now: () => now });
    const adapter = createBlurayAdapter({ ledger: ledger(), now: () => now, retries: 0 });

    const first = await service.load(adapter, request());
    now += 25 * 60 * 60 * 1_000;
    offline = true;
    const stale = await service.load(adapter, request());

    expect(first.cacheState).toBe("refreshed");
    expect(stale).toMatchObject({
      cacheState: "stale",
      refreshing: true,
      snapshot: first.snapshot,
    });
    await expect(stale.refresh).resolves.toMatchObject({
      status: "failed",
      snapshot: first.snapshot,
      retained: true,
      error: new Error("offline"),
    });
  });

  it("enriches only a unique cached TMDB title + exact-year match without I/O", () => {
    expect(normalizeBlurayIdentityTitle("Café & Rain!"))
      .toBe(normalizeBlurayIdentityTitle("Cafe and Rain"));
    const base: DiscoverySnapshot = {
      source: "bluray",
      titles: [{
        id: "bluray:one",
        title: "Café & Rain",
        year: 2026,
        mediaType: "movie",
        originCountries: [],
        genreIds: [],
      }],
      events: [],
      fetchedAt: NOW,
      warnings: [],
    };
    const enriched = enrichBlurayIdentities(base, [{
      id: "tmdb:movie:42",
      title: "Cafe and Rain",
      year: 2026,
      mediaType: "movie",
      tmdbId: 42,
      imdbId: "tt0000042",
      originalLanguage: "hi",
      originCountries: ["IN"],
      genreIds: [18],
      posterUrl: "https://image.tmdb.org/fixture.jpg",
    }]);

    expect(enriched.titles[0]).toMatchObject({
      id: "bluray:one",
      tmdbId: 42,
      imdbId: "tt0000042",
      originalLanguage: "hi",
      originCountries: ["IN"],
      genreIds: [18],
    });
    expect(base.titles[0]!.tmdbId).toBeUndefined();
  });

  it("leaves missing-year, conflicting-year, direct-ID, and ambiguous titles standalone", () => {
    const titles: DiscoverySnapshot = {
      source: "bluray",
      titles: [
        { id: "missing", title: "Same", mediaType: "movie", originCountries: [], genreIds: [] },
        { id: "conflict", title: "Same", year: 2025, mediaType: "movie", originCountries: [], genreIds: [] },
        { id: "direct", title: "Same", year: 2026, mediaType: "movie", tmdbId: 7, originCountries: [], genreIds: [] },
        { id: "ambiguous", title: "Same", year: 2026, mediaType: "movie", originCountries: [], genreIds: [] },
      ],
      events: [],
      fetchedAt: NOW,
      warnings: [],
    };
    const candidates = [8, 9].map((tmdbId) => ({
      id: `tmdb:movie:${tmdbId}`,
      title: "Same",
      year: 2026,
      mediaType: "movie" as const,
      tmdbId,
      originCountries: [],
      genreIds: [],
    }));

    const result = enrichBlurayIdentities(titles, candidates);
    expect(result.titles.map((title) => title.tmdbId)).toEqual([undefined, undefined, 7, undefined]);
    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "ambiguous-identity", sourceRecordId: "ambiguous" }),
    ]);
  });
});
