import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/config/config";
import { createDiscoveryCacheRepository } from "../../src/discovery/cache-repository";
import {
  DiscoveryBudgetExceededError,
  type BudgetStatus,
  type RequestLedger,
} from "../../src/discovery/budget";
import type { DiscoveryRequest } from "../../src/discovery/request";
import { createDiscoveryService } from "../../src/discovery/service";
import {
  createStreamingAvailabilityAdapter,
  indiaDateStartUnixSeconds,
  parseStreamingChangesPage,
  streamingResumeFromUnixSeconds,
} from "../../src/discovery/sources/streaming-availability";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/streaming-availability-changes.json",
);
const NOW = 1_783_665_832_000;

function rawChanges(): {
  changes: Record<string, unknown>[];
  shows: Record<string, unknown>;
  hasMore: boolean;
  nextCursor: string;
} {
  return JSON.parse(readFileSync(FIXTURE, "utf8")) as {
    changes: Record<string, unknown>[];
    shows: Record<string, unknown>;
    hasMore: boolean;
    nextCursor: string;
  };
}

function ledger() {
  const status: BudgetStatus = {
    source: "streaming-availability",
    endpoint: "changes",
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
    canSpend: vi.fn<Pick<RequestLedger, "canSpend">["canSpend"]>(async () => status),
  };
}

function request(): DiscoveryRequest {
  return {
    region: "IN",
    feedKind: "streaming_added",
    dateRange: { start: "2026-06-09", end: "2026-07-10", direction: "past" },
    mediaTypes: ["movie", "series"],
    providerIds: ["netflix", "prime"],
    pageLimit: 1,
  };
}

describe("India recent Streaming Availability changes", () => {
  it("uses the exact bounded new/show query without splitting movie and series", async () => {
    const raw = rawChanges();
    raw.changes[0]!.timestamp = Math.floor(Date.parse("2026-07-08T12:00:00Z") / 1_000);
    raw.changes[0]!.audios = [{ language: "hi" }, "en"];
    raw.changes[0]!.subtitles = ["en", { language: "ta" }];
    Object.assign(raw.shows["show-2001"]!, {
      originalLanguage: "hi-IN",
      countries: [{ countryCode: "in", name: "India" }],
      genres: [
        { id: 18, name: "Drama" },
        { id: "comedy", name: "Comedy" },
      ],
      imageSet: {
        verticalPoster: {
          w240: "https://images.example.test/poster-small.jpg",
          w480: "https://images.example.test/poster.jpg",
        },
        horizontalBackdrop: {
          w720: "https://images.example.test/backdrop.jpg",
        },
      },
      rating: 82,
    });
    const calls: URL[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      calls.push(new URL(String(input)));
      return new Response(JSON.stringify(raw), { status: 200 });
    });
    const adapter = createStreamingAvailabilityAdapter({
      config: defaultConfig,
      env: { STREAMING_AVAILABILITY_API_KEY: "key" },
      ledger: ledger(),
      now: () => NOW,
      retries: 0,
    });

    const snapshot = await adapter.fetch(request(), { fetchImpl });

    expect(calls).toHaveLength(1);
    const url = calls[0]!;
    expect(url.pathname).toBe("/v4/changes");
    expect(url.searchParams.get("country")).toBe("in");
    expect(url.searchParams.get("change_type")).toBe("new");
    expect(url.searchParams.get("item_type")).toBe("show");
    expect(url.searchParams.has("show_type")).toBe(false);
    expect(url.searchParams.get("from")).toBe(String(indiaDateStartUnixSeconds("2026-06-09")));
    expect(url.searchParams.get("catalogs")).toBe("netflix,prime");
    expect(url.searchParams.get("output_language")).toBe("en");
    expect(url.searchParams.get("order_direction")).toBe("desc");

    expect(snapshot.titles).toHaveLength(5);
    expect(snapshot.titles.map((title) => title.mediaType)).toEqual(
      expect.arrayContaining(["movie", "series"]),
    );
    expect(snapshot.titles[0]).toMatchObject({
      originalTitle: "Monsoon Letters",
      tmdbId: 9002001,
      imdbId: "tt9002001",
      originalLanguage: "hi",
      originCountries: ["IN"],
      genreIds: [18],
      genreLabels: ["Drama", "Comedy"],
      posterUrl: "https://images.example.test/poster.jpg",
      images: {
        verticalPoster: "https://images.example.test/poster.jpg",
        horizontalBackdrop: "https://images.example.test/backdrop.jpg",
      },
      ratings: [{
        system: "aggregate",
        provider: "streaming-availability",
        value: 82,
        scale: 100,
        observedAt: NOW,
      }],
    });
    expect(snapshot.events).toHaveLength(5);
    expect(snapshot.events.map((event) => event.providerId)).toEqual([
      "netflix",
      "hotstar",
      "zee5",
      "prime",
      "sonyliv",
    ]);
    expect(snapshot.events[0]).toMatchObject({
      kind: "streaming_added",
      region: "IN",
      date: "2026-07-08",
      datePrecision: "day",
      providerId: "netflix",
      providerLabel: "Netflix",
      accessType: "subscription",
      audioLanguages: ["hi", "en"],
      subtitleLanguages: ["en", "ta"],
      firstObservedAt: NOW,
      evidence: [{
        source: "streaming-availability",
        sourceUrl: "https://www.netflix.com/title/fixture-2001",
        confidence: "exact",
      }],
    });
    expect(snapshot.events[0]!.id).toContain(String(raw.changes[0]!.timestamp));
    expect(snapshot.cursor).toBe(raw.nextCursor);
  });

  it("rejects millisecond timestamps for past changes instead of treating observation as arrival", () => {
    const raw = rawChanges();
    raw.changes[0]!.timestamp = 1_783_665_832_000;
    const parsed = parseStreamingChangesPage(raw);

    expect(parsed.changes.some((change) => change.showId === "show-2001")).toBe(false);
    expect(parsed.warnings).toEqual([
      expect.objectContaining({ code: "malformed-change" }),
    ]);
  });

  it("deduplicates events and stops when a page repeats its cursor", async () => {
    const raw = rawChanges();
    raw.nextCursor = "looping-cursor";
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(raw), { status: 200 }));
    const adapter = createStreamingAvailabilityAdapter({
      config: defaultConfig,
      env: { STREAMING_AVAILABILITY_API_KEY: "key" },
      ledger: ledger(),
      now: () => NOW,
      retries: 0,
    });

    const snapshot = await adapter.fetch({ ...request(), pageLimit: 4 }, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(snapshot.events).toHaveLength(5);
    expect(new Set(snapshot.events.map((event) => event.id)).size).toBe(5);
    expect(snapshot.cursor).toBeUndefined();
    expect(snapshot.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "duplicate-event" }),
      expect.objectContaining({ code: "repeated-cursor", sourceRecordId: "looping-cursor" }),
    ]));
    expect(snapshot.resume).toEqual({
      newestTimestampUnixSeconds: 1_783_665_832,
      overlapSeconds: 3_600,
    });
    expect(streamingResumeFromUnixSeconds(snapshot)).toBe(1_783_662_232);
  });

  it("skips a change whose included show entry is missing", async () => {
    const raw = rawChanges();
    raw.hasMore = false;
    delete raw.shows["show-2002"];
    const adapter = createStreamingAvailabilityAdapter({
      config: defaultConfig,
      env: { STREAMING_AVAILABILITY_API_KEY: "key" },
      ledger: ledger(),
      now: () => NOW,
      retries: 0,
    });

    const snapshot = await adapter.fetch(request(), {
      fetchImpl: async () => new Response(JSON.stringify(raw), { status: 200 }),
    });

    expect(snapshot.events).toHaveLength(4);
    expect(snapshot.titles.some((title) => title.id.endsWith("show-2002"))).toBe(false);
    expect(snapshot.warnings).toContainEqual(expect.objectContaining({
      code: "missing-show",
      sourceRecordId: "show-2002",
    }));
  });

  it("consumes no more than four cursor pages", async () => {
    const raw = rawChanges();
    let page = 0;
    const cursors: (string | null)[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      cursors.push(url.searchParams.get("cursor"));
      page += 1;
      return new Response(JSON.stringify({
        ...raw,
        hasMore: true,
        nextCursor: `cursor-${page}`,
      }), { status: 200 });
    });
    const adapter = createStreamingAvailabilityAdapter({
      config: defaultConfig,
      env: { STREAMING_AVAILABILITY_API_KEY: "key" },
      ledger: ledger(),
      now: () => NOW,
      retries: 0,
    });

    const snapshot = await adapter.fetch({ ...request(), pageLimit: 4 }, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(cursors).toEqual([null, "cursor-1", "cursor-2", "cursor-3"]);
    expect(snapshot.cursor).toBe("cursor-4");
    expect(snapshot.events).toHaveLength(5);
  });

  it("serves a stale streaming snapshot while an offline refresh retains it", async () => {
    const raw = rawChanges();
    raw.hasMore = false;
    let offline = false;
    let clock = NOW;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      if (offline) throw new Error("offline");
      return new Response(JSON.stringify(raw), { status: 200 });
    });
    const cache = createDiscoveryCacheRepository({
      readFile: async () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      },
      writeJson: async () => {},
    });
    const adapter = createStreamingAvailabilityAdapter({
      config: defaultConfig,
      env: { STREAMING_AVAILABILITY_API_KEY: "key" },
      ledger: ledger(),
      now: () => clock,
      retries: 0,
    });
    const service = createDiscoveryService({ cache, fetchImpl, now: () => clock });

    const fresh = await service.load(adapter, request());
    expect(fresh).toMatchObject({ cacheState: "refreshed", refreshing: false });
    offline = true;
    clock += 13 * 60 * 60 * 1_000;

    const stale = await service.load(adapter, request());
    expect(stale).toMatchObject({
      cacheState: "stale",
      snapshot: fresh.snapshot,
      refreshing: true,
    });
    await expect(stale.refresh).resolves.toMatchObject({
      status: "failed",
      snapshot: fresh.snapshot,
      retained: true,
      error: new Error("offline"),
    });
  });

  it("makes one supported-provider upcoming call and keeps unknown dates separate", async () => {
    const raw = rawChanges();
    raw.changes = raw.changes.slice(0, 2).map((change, index) => {
      const upcoming: Record<string, unknown> = { ...change, changeType: "upcoming" };
      if (index === 1) delete upcoming.timestamp;
      return upcoming;
    });
    const calls: URL[] = [];
    const attempts = ledger();
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      calls.push(new URL(String(input)));
      return new Response(JSON.stringify(raw), { status: 200 });
    });
    const adapter = createStreamingAvailabilityAdapter({
      config: defaultConfig,
      env: { STREAMING_AVAILABILITY_API_KEY: "key" },
      ledger: attempts,
      now: () => NOW,
      retries: 0,
    });
    const upcomingRequest: DiscoveryRequest = {
      ...request(),
      feedKind: "streaming_upcoming",
      dateRange: { start: "2026-07-10", end: "2026-08-01", direction: "upcoming" },
      providerIds: ["netflix", "zee5", "prime"],
      pageLimit: 4,
    };

    const snapshot = await adapter.fetch(upcomingRequest, { fetchImpl });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.searchParams.get("change_type")).toBe("upcoming");
    expect(calls[0]!.searchParams.get("catalogs")).toBe("netflix,prime");
    expect(calls[0]!.searchParams.get("include_unknown_dates")).toBe("true");
    expect(calls[0]!.searchParams.has("to")).toBe(true);
    expect(snapshot.events).toHaveLength(2);
    expect(snapshot.events[0]).toMatchObject({
      kind: "streaming_upcoming",
      datePrecision: "day",
    });
    expect(snapshot.events[1]).toMatchObject({
      kind: "streaming_upcoming",
      datePrecision: "unknown",
      status: "unknown",
    });
    expect(snapshot.events[1]!.date).toBeUndefined();
    expect(attempts.canSpend).toHaveBeenCalledWith(
      "streaming-availability",
      "changes-upcoming",
    );
  });

  it("skips upcoming automatically at the soft warning threshold", async () => {
    const attempts = ledger();
    attempts.canSpend.mockResolvedValue({
      source: "streaming-availability",
      endpoint: "changes-upcoming",
      month: "2026-07",
      used: 350,
      endpointUsed: 0,
      allowed: true,
      warning: true,
      softWarning: 350,
      hardCap: 450,
      remaining: 100,
    });
    const fetchImpl = vi.fn<typeof fetch>();
    const adapter = createStreamingAvailabilityAdapter({
      config: defaultConfig,
      env: { STREAMING_AVAILABILITY_API_KEY: "key" },
      ledger: attempts,
    });

    await expect(adapter.fetch({
      ...request(),
      feedKind: "streaming_upcoming",
      dateRange: { start: "2026-07-10", end: "2026-08-01", direction: "upcoming" },
      providerIds: ["netflix"],
    }, { fetchImpl })).rejects.toBeInstanceOf(DiscoveryBudgetExceededError);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(attempts.recordAttempt).not.toHaveBeenCalled();
  });
});
