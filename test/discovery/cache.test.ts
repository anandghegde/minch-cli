import { describe, expect, it } from "vitest";
import {
  DISCOVERY_CACHE_VERSION,
  createDiscoveryCacheEntry,
  discoveryRequestKey,
  parseDiscoveryCache,
  type DiscoveryCacheDocument,
} from "../../src/discovery/cache";
import type { DiscoverySnapshot } from "../../src/discovery/adapter";
import type { DiscoveryRequest } from "../../src/discovery/request";

const FETCHED_AT = 1_783_665_832_000;

function request(): DiscoveryRequest {
  return {
    region: "IN",
    feedKind: "streaming_added",
    dateRange: { start: "2026-06-09", end: "2026-07-10", direction: "past" },
    mediaTypes: ["series", "movie"],
    providerIds: ["prime", "netflix"],
    pageLimit: 4,
  };
}

function snapshot(): DiscoverySnapshot {
  return {
    source: "streaming-availability",
    titles: [{
      id: "streaming-availability:show-1",
      title: "Fixture",
      mediaType: "movie",
      originCountries: [],
      genreIds: [],
    }],
    events: [{
      id: "event-1",
      titleId: "streaming-availability:show-1",
      kind: "streaming_added",
      region: "IN",
      date: "2026-07-10",
      datePrecision: "day",
      providerId: "netflix",
      providerLabel: "Netflix",
      status: "today",
      firstObservedAt: FETCHED_AT,
      lastObservedAt: FETCHED_AT,
      evidence: [{
        source: "streaming-availability",
        sourceId: "show-1",
        observedAt: FETCHED_AT,
        confidence: "exact",
      }],
    }],
    fetchedAt: FETCHED_AT,
    cursor: "fixture-cursor",
    resume: {
      newestTimestampUnixSeconds: 1_783_665_832,
      overlapSeconds: 3_600,
    },
    warnings: [],
  };
}

describe("discovery cache format", () => {
  it("creates a versioned entry with a stable set-normalized request key", () => {
    const first = request();
    const second = {
      ...request(),
      mediaTypes: ["movie", "series"] as DiscoveryRequest["mediaTypes"],
      providerIds: ["netflix", "prime"],
    };
    const entry = createDiscoveryCacheEntry(
      first,
      snapshot(),
      FETCHED_AT + 12 * 60 * 60 * 1_000,
      FETCHED_AT + 45 * 24 * 60 * 60 * 1_000,
    );

    expect(discoveryRequestKey(entry.source, first)).toBe(
      discoveryRequestKey(entry.source, second),
    );
    expect(entry).toMatchObject({
      source: "streaming-availability",
      snapshot: {
        fetchedAt: FETCHED_AT,
        resume: {
          newestTimestampUnixSeconds: 1_783_665_832,
          overlapSeconds: 3_600,
        },
      },
    });
  });

  it("rejects one corrupt entry without discarding a valid peer", () => {
    const req = request();
    const entry = createDiscoveryCacheEntry(
      req,
      snapshot(),
      FETCHED_AT + 1_000,
      FETCHED_AT + 2_000,
    );
    const key = discoveryRequestKey(entry.source, req);
    const document: DiscoveryCacheDocument = {
      version: DISCOVERY_CACHE_VERSION,
      entries: { [key]: entry },
    };
    const raw = JSON.parse(JSON.stringify(document)) as {
      version: number;
      entries: Record<string, unknown>;
    };
    raw.entries.corrupt = { ...entry, expiresAt: "tomorrow" };

    const parsed = parseDiscoveryCache(raw);
    expect(Object.keys(parsed.document.entries)).toEqual([key]);
    expect(parsed.rejectedEntries).toEqual([
      { key: "corrupt", reason: "invalid cache entry" },
    ]);
    expect(parsed.documentError).toBeUndefined();
  });

  it("discards schema mismatches and invalid timestamp ordering safely", () => {
    expect(parseDiscoveryCache({ version: 999, entries: {} })).toMatchObject({
      document: { version: 1, entries: {} },
      documentError: "unsupported cache version: 999",
    });
    expect(() =>
      createDiscoveryCacheEntry(
        request(),
        snapshot(),
        FETCHED_AT - 1,
        FETCHED_AT + 1,
      ),
    ).toThrow("invalid discovery cache entry");
  });

  it("rejects corrupt normalized records inside an otherwise valid entry", () => {
    const req = request();
    const entry = createDiscoveryCacheEntry(
      req,
      snapshot(),
      FETCHED_AT + 1_000,
      FETCHED_AT + 2_000,
    );
    const key = discoveryRequestKey(entry.source, req);
    const raw = JSON.parse(JSON.stringify({
      version: DISCOVERY_CACHE_VERSION,
      entries: { [key]: entry },
    })) as { entries: Record<string, { snapshot: { events: { date: string }[] } }> };
    raw.entries[key]!.snapshot.events[0]!.date = "2026-02-30";

    expect(parseDiscoveryCache(raw)).toMatchObject({
      document: { entries: {} },
      rejectedEntries: [{ key, reason: "invalid cache entry" }],
    });
  });

  it("accepts optional ratings without making older rating-free snapshots unreadable", () => {
    const req = request();
    const rated = snapshot();
    rated.titles[0]!.ratings = [{
      system: "aggregate", provider: "streaming-availability", value: 82,
      scale: 100, observedAt: FETCHED_AT,
    }];
    const entry = createDiscoveryCacheEntry(
      req, rated, FETCHED_AT + 1_000, FETCHED_AT + 2_000,
    );
    const key = discoveryRequestKey(entry.source, req);
    expect(parseDiscoveryCache({ version: 1, entries: { [key]: entry } })
      .document.entries[key]?.snapshot.titles[0]?.ratings?.[0]?.value).toBe(82);
    expect(() => createDiscoveryCacheEntry(
      req, snapshot(), FETCHED_AT + 1_000, FETCHED_AT + 2_000,
    )).not.toThrow();
  });
});
