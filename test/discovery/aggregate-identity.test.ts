import { describe, expect, it } from "vitest";
import type { DiscoverySnapshot } from "../../src/discovery/adapter";
import { canonicalizeSnapshotTitles } from "../../src/discovery/aggregate";
import type { CatalogTitle, DiscoverySource, MediaType } from "../../src/discovery/types";

function title(
  id: string,
  name: string,
  year: number,
  mediaType: MediaType = "movie",
  identity: Pick<CatalogTitle, "tmdbId" | "imdbId"> = {},
): CatalogTitle {
  return {
    id,
    title: name,
    year,
    mediaType,
    ...identity,
    originCountries: [],
    genreIds: [],
  };
}

function snapshot(source: DiscoverySource, titles: CatalogTitle[]): DiscoverySnapshot {
  return { source, titles, events: [], fetchedAt: 1, warnings: [] };
}

describe("canonical discovery title identity", () => {
  it("matches media-compatible TMDB identity before other metadata", () => {
    const result = canonicalizeSnapshotTitles([
      snapshot("tmdb", [title("tmdb:movie:7", "Authoritative Name", 2026, "movie", {
        tmdbId: 7,
        imdbId: "tt0000007",
      })]),
      snapshot("streaming-availability", [
        title("streaming:7", "Localized Name", 2025, "movie", { tmdbId: 7 }),
        title("streaming:series:7", "Authoritative Name", 2026, "series", { tmdbId: 7 }),
      ]),
    ]);

    expect(result.titles).toHaveLength(2);
    expect(result.canonicalIdBySourceTitleId.get("tmdb:movie:7"))
      .toBe(result.canonicalIdBySourceTitleId.get("streaming:7"));
    expect(result.canonicalIdBySourceTitleId.get("streaming:series:7"))
      .not.toBe(result.canonicalIdBySourceTitleId.get("tmdb:movie:7"));
    expect(result.titles.find((item) => item.mediaType === "movie")).toMatchObject({
      id: "canonical:movie:tmdb:7",
      title: "Authoritative Name",
      imdbId: "tt0000007",
    });
  });

  it("matches IMDb identity when TMDB identities do not conflict", () => {
    const result = canonicalizeSnapshotTitles([
      snapshot("streaming-availability", [
        title("streaming:imdb", "Monsoon Letters", 2026, "movie", {
          imdbId: "tt9002001",
        }),
      ]),
      snapshot("bluray", [
        title("bluray:imdb", "Different Source Label", 2026, "movie", {
          imdbId: "tt9002001",
        }),
      ]),
    ]);

    expect(result.titles).toHaveLength(1);
    expect(result.titles[0]!.id).toBe("canonical:movie:imdb:tt9002001");
  });

  it("uses only normalized title plus exact year and compatible media as fallback", () => {
    const result = canonicalizeSnapshotTitles([
      snapshot("tmdb", [title("tmdb:fallback", "Café & Rain", 2026)]),
      snapshot("bluray", [
        title("bluray:fallback", "Cafe and Rain!", 2026),
        title("bluray:other-year", "Cafe and Rain", 2025),
        title("bluray:series", "Cafe and Rain", 2026, "series"),
      ]),
    ]);

    expect(result.titles).toHaveLength(3);
    expect(result.canonicalIdBySourceTitleId.get("tmdb:fallback"))
      .toBe(result.canonicalIdBySourceTitleId.get("bluray:fallback"));
    expect(result.canonicalIdBySourceTitleId.get("bluray:other-year"))
      .not.toBe(result.canonicalIdBySourceTitleId.get("tmdb:fallback"));
    expect(result.canonicalIdBySourceTitleId.get("bluray:series"))
      .not.toBe(result.canonicalIdBySourceTitleId.get("tmdb:fallback"));
  });

  it("leaves an ambiguous title/year fallback separate and counts it", () => {
    const result = canonicalizeSnapshotTitles([
      snapshot("tmdb", [
        title("tmdb:one", "Shared Horizon", 2026, "movie", { tmdbId: 1 }),
        title("tmdb:two", "Shared Horizon", 2026, "movie", { tmdbId: 2 }),
      ]),
      snapshot("bluray", [title("bluray:unknown", "Shared Horizon", 2026)]),
    ]);

    expect(result.titles).toHaveLength(3);
    expect(result.diagnostics).toEqual({
      ambiguousIdentity: 1,
      unresolvedIdentity: 1,
    });
    expect(result.canonicalIdBySourceTitleId.get("bluray:unknown"))
      .not.toBe(result.canonicalIdBySourceTitleId.get("tmdb:one"));
    expect(result.canonicalIdBySourceTitleId.get("bluray:unknown"))
      .not.toBe(result.canonicalIdBySourceTitleId.get("tmdb:two"));
  });
});
