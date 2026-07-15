import { describe, expect, it } from "vitest";
import {
  formatRatingValue,
  mergeRatings,
  normalizeRating,
  ratingKey,
  selectPreferredRating,
} from "../../src/discovery/ratings/types";
import type { CatalogRating } from "../../src/discovery/types";

const tmdb: CatalogRating = {
  system: "tmdb", provider: "tmdb", value: 7.8, scale: 10,
  voteCount: 12_000, observedAt: 10,
};

describe("rating domain", () => {
  it("validates provider/system boundaries and numeric fields", () => {
    expect(normalizeRating(tmdb)).toEqual(tmdb);
    expect(normalizeRating({ ...tmdb, value: Number.NaN })).toBeUndefined();
    expect(normalizeRating({ ...tmdb, voteCount: -1 })).toBeUndefined();
    expect(normalizeRating({ ...tmdb, system: "imdb" })).toBeUndefined();
    expect(normalizeRating({ ...tmdb, provider: "mdblist", system: "tmdb" })).toBeUndefined();
  });

  it("selects by provider priority rather than maximum score", () => {
    const imdb: CatalogRating = {
      system: "imdb", provider: "imdb-dataset", value: 6.1, scale: 10,
      voteCount: 9, observedAt: 20,
    };
    expect(selectPreferredRating([tmdb, imdb])).toEqual(imdb);
    expect(ratingKey(imdb)).toBe("imdb:imdb-dataset");
  });

  it("normalizes 100-point scores and keeps the newest duplicate", () => {
    const score: CatalogRating = {
      system: "aggregate", provider: "streaming-availability",
      value: 82, scale: 100, observedAt: 3,
    };
    expect(formatRatingValue(score)).toBe(8.2);
    expect(mergeRatings(tmdb ? [tmdb] : [], [{ ...tmdb, value: 7.1, observedAt: 11 }]))
      .toEqual([{ ...tmdb, value: 7.1, observedAt: 11 }]);
  });
});
