import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseRssItems } from "../../src/sources/adapter";

const FIXTURE_DIR = dirname(fileURLToPath(new URL("fixtures/README.md", import.meta.url)));

function readFixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), "utf8");
}

function readJson(name: string): unknown {
  return JSON.parse(readFixture(name)) as unknown;
}

describe("discovery Phase 0 fixtures", () => {
  it("parses every JSON fixture with JSON.parse", () => {
    const jsonFiles = readdirSync(FIXTURE_DIR).filter((name) => name.endsWith(".json"));

    expect(jsonFiles.length).toBeGreaterThan(0);
    for (const name of jsonFiles) {
      expect(() => readJson(name), name).not.toThrow();
    }
  });

  it("parses the Blu-ray RSS fixture with the existing XML parser", () => {
    const items = parseRssItems(readFixture("bluray-new-releases.xml")) as Record<
      string,
      unknown
    >[];

    expect(items).toHaveLength(5);
    expect(items[0]).toMatchObject({
      title: "The Elephant Man (Blu-ray)",
      category: "blu-ray",
      guid: "https://www.blu-ray.com/movies/fixture-elephant-man-bluray/1/",
    });
    expect(items.some((item) => !Object.hasOwn(item, "pubDate"))).toBe(true);
    expect(items.some((item) => !Object.hasOwn(item, "guid"))).toBe(true);
  });

  it("keeps representative movie, series, Indian-language, sparse, and duplicate records", () => {
    const tmdb = readJson("tmdb-discover-movie.json") as {
      results: { original_language: string; release_date: string; title: string }[];
    };
    const streaming = readJson("streaming-availability-changes.json") as {
      changes: { showId: string; showType: string; timestamp: number }[];
      shows: Record<string, { imdbId?: string; title: string; tmdbId?: string }>;
    };
    const shows = Object.values(streaming.shows);
    const titleCounts = new Map<string, number>();
    for (const show of shows) {
      titleCounts.set(show.title, (titleCounts.get(show.title) ?? 0) + 1);
    }

    expect(tmdb.results).toHaveLength(5);
    expect(tmdb.results.some((row) => row.original_language === "hi")).toBe(true);
    expect(tmdb.results.some((row) => row.release_date === "")).toBe(true);
    expect(streaming.changes).toHaveLength(5);
    expect(streaming.changes.every((change) => Number.isFinite(change.timestamp))).toBe(true);
    expect(streaming.changes.map((change) => change.showType)).toEqual(
      expect.arrayContaining(["movie", "series"]),
    );
    expect(shows.some((show) => !show.imdbId && !show.tmdbId)).toBe(true);
    expect([...titleCounts.values()].some((count) => count > 1)).toBe(true);
  });

  it("contains no credential or account material in payload fixtures", () => {
    const payloadFiles = readdirSync(FIXTURE_DIR).filter((name) => /\.(?:json|xml)$/.test(name));
    const forbidden = [
      /authorization\s*[:=]/i,
      /x-api-key\s*[:=]/i,
      /(?:api[_-]?key|access[_-]?token|account[_-]?id)\s*[:=]/i,
      /bearer\s+[a-z0-9._~-]+/i,
      /eyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/,
    ];

    for (const name of payloadFiles) {
      const payload = readFixture(name);
      for (const pattern of forbidden) {
        expect(payload, `${name} matched ${pattern}`).not.toMatch(pattern);
      }
    }
  });
});
