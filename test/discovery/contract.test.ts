import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { DiscoveryAdapter } from "../../src/discovery/adapter";
import { indiaToday, statusForDate } from "../../src/discovery/dates";
import { normalizeProvider } from "../../src/discovery/normalize";
import {
  validateDiscoveryRequest,
  type DiscoveryRequest,
} from "../../src/discovery/request";
import { UNKNOWN_REGION } from "../../src/discovery/types";
import { parseRssItems } from "../../src/sources/adapter";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const OBSERVED_AT = 1_783_665_832_000;

function jsonFixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as T;
}

function request(overrides: Partial<DiscoveryRequest>): DiscoveryRequest {
  return {
    region: "IN",
    feedKind: "digital",
    dateRange: { start: "2026-06-09", end: "2026-07-10", direction: "past" },
    mediaTypes: ["movie"],
    providerIds: [],
    pageLimit: 1,
    ...overrides,
  };
}

const tmdbFake: DiscoveryAdapter = {
  id: "tmdb",
  label: "TMDB fixture",
  capabilities: {
    features: ["trending", "regional_release", "watch_providers"],
    mediaTypes: ["movie", "series"],
    regions: ["IN"],
  },
  isConfigured: () => true,
  fetch: async (rawRequest) => {
    const validated = validateDiscoveryRequest(rawRequest);
    const discover = jsonFixture<{
      results: { id: number; title: string; original_language: string; genre_ids: number[] }[];
    }>("tmdb-discover-movie.json");
    const regional = jsonFixture<{
      results: { iso_3166_1: string; release_dates: { release_date: string; type: number }[] }[];
    }>("tmdb-movie-release-dates-digital.json");
    const row = discover.results[0]!;
    const release = regional.results
      .find((country) => country.iso_3166_1 === validated.region)!
      .release_dates.find((candidate) => candidate.type === 4)!;
    const date = release.release_date.slice(0, 10);
    const titleId = `tmdb:movie:${row.id}`;
    return {
      source: "tmdb",
      titles: [{
        id: titleId,
        title: row.title,
        mediaType: "movie",
        tmdbId: row.id,
        originalLanguage: row.original_language,
        originCountries: [],
        genreIds: row.genre_ids,
      }],
      events: [{
        id: `${titleId}:${validated.region}:digital:${date}`,
        titleId,
        kind: "digital",
        region: validated.region,
        date,
        datePrecision: "day",
        status: statusForDate(date, "2026-07-10"),
        firstObservedAt: OBSERVED_AT,
        lastObservedAt: OBSERVED_AT,
        evidence: [{
          source: "tmdb",
          sourceId: String(row.id),
          observedAt: OBSERVED_AT,
          confidence: "exact",
        }],
      }],
      fetchedAt: OBSERVED_AT,
      warnings: [],
    };
  },
};

const blurayFake: DiscoveryAdapter = {
  id: "bluray",
  label: "Blu-ray RSS fixture",
  capabilities: {
    features: ["bluray"],
    mediaTypes: ["movie"],
    regions: [],
  },
  isConfigured: () => true,
  fetch: async (rawRequest) => {
    validateDiscoveryRequest(rawRequest);
    const items = parseRssItems(
      readFileSync(join(FIXTURES, "bluray-new-releases.xml"), "utf8"),
    ) as { title: string; link: string; guid?: string; pubDate?: string }[];
    const item = items[1]!;
    const date = "2026-07-07";
    const titleId = "bluray:the-elephant-man-4k";
    return {
      source: "bluray",
      titles: [{
        id: titleId,
        title: item.title,
        mediaType: "movie",
        originCountries: [],
        genreIds: [],
      }],
      events: [{
        id: `${titleId}:ZZ:uhd_bluray:${date}`,
        titleId,
        kind: "uhd_bluray",
        region: UNKNOWN_REGION,
        date,
        datePrecision: "day",
        formatLabel: "4K UHD Blu-ray",
        status: statusForDate(date, "2026-07-10"),
        firstObservedAt: OBSERVED_AT,
        lastObservedAt: OBSERVED_AT,
        evidence: [{
          source: "bluray",
          sourceId: item.guid,
          sourceUrl: item.link,
          observedAt: OBSERVED_AT,
          confidence: "source_claim",
        }],
      }],
      fetchedAt: OBSERVED_AT,
      warnings: [],
    };
  },
};

const streamingFake: DiscoveryAdapter = {
  id: "streaming-availability",
  label: "Streaming Availability fixture",
  capabilities: {
    features: ["streaming_changes", "streaming_upcoming", "provider_dictionary", "cursor_pagination"],
    mediaTypes: ["movie", "series", "season", "episode"],
    regions: ["IN"],
  },
  isConfigured: () => true,
  fetch: async (rawRequest) => {
    const validated = validateDiscoveryRequest(rawRequest);
    const fixture = jsonFixture<{
      changes: {
        changeType: string;
        link: string;
        service: { id: string; name: string };
        showId: string;
        showType: "movie" | "series";
        timestamp: number;
      }[];
      shows: Record<string, {
        id: string;
        imdbId?: string;
        tmdbId?: string;
        title: string;
        showType: "movie" | "series";
        releaseYear?: number;
      }>;
      nextCursor: string;
    }>("streaming-availability-changes.json");
    const change = fixture.changes[0]!;
    const show = fixture.shows[change.showId]!;
    const provider = normalizeProvider(change.service.id, change.service.name)!;
    const date = indiaToday(change.timestamp * 1_000);
    const titleId = `streaming-availability:${show.id}`;
    return {
      source: "streaming-availability",
      titles: [{
        id: titleId,
        title: show.title,
        year: show.releaseYear,
        mediaType: show.showType,
        imdbId: show.imdbId,
        tmdbId: show.tmdbId ? Number(show.tmdbId.split("/")[1]) : undefined,
        originCountries: [],
        genreIds: [],
      }],
      events: [{
        id: `${titleId}:${validated.region}:${provider.id}:streaming_added:${change.timestamp}`,
        titleId,
        kind: "streaming_added",
        region: validated.region,
        date,
        datePrecision: "day",
        providerId: provider.id,
        providerLabel: provider.label,
        status: statusForDate(date, "2026-07-10"),
        firstObservedAt: OBSERVED_AT,
        lastObservedAt: OBSERVED_AT,
        evidence: [{
          source: "streaming-availability",
          sourceId: change.showId,
          sourceUrl: change.link,
          observedAt: OBSERVED_AT,
          confidence: "exact",
        }],
      }],
      fetchedAt: OBSERVED_AT,
      cursor: fixture.nextCursor,
      warnings: [],
    };
  },
};

const traktNoGo: DiscoveryAdapter = {
  id: "trakt",
  label: "Trakt (disabled by ADR 002)",
  capabilities: { features: [], mediaTypes: [], regions: [] },
  isConfigured: () => false,
  fetch: async () => {
    throw new Error("Trakt is disabled by ADR 002");
  },
};

describe("fixture-backed discovery adapter contract", () => {
  it("preserves source-specific region, provider, date, format, cursor, and evidence", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const [tmdb, bluray, streaming] = await Promise.all([
      tmdbFake.fetch(request({ feedKind: "digital" }), { fetchImpl }),
      blurayFake.fetch(
        request({
          region: "ZZ",
          feedKind: "bluray",
          dateRange: { start: "2026-07-01", end: "2026-07-31", direction: "upcoming" },
        }),
        { fetchImpl },
      ),
      streamingFake.fetch(
        request({ feedKind: "streaming_added", providerIds: ["netflix"], pageLimit: 4 }),
        { fetchImpl },
      ),
    ]);

    expect(tmdb.events[0]).toMatchObject({
      kind: "digital",
      region: "IN",
      datePrecision: "day",
      evidence: [{ source: "tmdb", confidence: "exact" }],
    });
    expect(bluray.events[0]).toMatchObject({
      kind: "uhd_bluray",
      region: "ZZ",
      formatLabel: "4K UHD Blu-ray",
      evidence: [{ source: "bluray", confidence: "source_claim" }],
    });
    expect(streaming.events[0]).toMatchObject({
      kind: "streaming_added",
      region: "IN",
      providerId: "netflix",
      providerLabel: "Netflix",
      evidence: [{ source: "streaming-availability", confidence: "exact" }],
    });
    expect(streaming.cursor).toBe("1783647000:fixture-page-2");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps the prohibited fourth source representable but unconfigured", () => {
    const adapters: DiscoveryAdapter[] = [tmdbFake, blurayFake, streamingFake, traktNoGo];
    expect(adapters.map((adapter) => adapter.id)).toEqual([
      "tmdb",
      "bluray",
      "streaming-availability",
      "trakt",
    ]);
    expect(traktNoGo.isConfigured()).toBe(false);
  });
});
