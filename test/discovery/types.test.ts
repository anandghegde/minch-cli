import { describe, expect, it } from "vitest";
import {
  UNKNOWN_REGION,
  type CatalogTitle,
  type ReleaseEvent,
} from "../../src/discovery/types";

describe("discovery domain types", () => {
  it("uses an explicit unknown-region sentinel", () => {
    expect(UNKNOWN_REGION).toBe("ZZ");
  });

  it("models titles and release evidence independently of torrent rows", () => {
    const title: CatalogTitle = {
      id: "tmdb:movie:1001",
      title: "Sample Indian Film",
      mediaType: "movie",
      tmdbId: 1001,
      originalLanguage: "hi",
      originCountries: ["IN"],
      genreIds: [18],
    };
    const event: ReleaseEvent = {
      id: "tmdb:movie:1001:IN:digital:2026-07-10",
      titleId: title.id,
      kind: "digital",
      region: "IN",
      date: "2026-07-10",
      datePrecision: "day",
      status: "past",
      firstObservedAt: 1_783_665_832_000,
      lastObservedAt: 1_783_665_832_000,
      evidence: [
        {
          source: "tmdb",
          sourceId: "1001",
          observedAt: 1_783_665_832_000,
          confidence: "exact",
        },
      ],
    };

    expect(event.titleId).toBe(title.id);
    expect("magnet" in title).toBe(false);
    expect("seeders" in event).toBe(false);
  });
});
