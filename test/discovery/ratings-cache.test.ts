import { describe, expect, it } from "vitest";
import {
  createCachedRating,
  emptyRatingsCache,
  parseRatingsCache,
} from "../../src/discovery/ratings/cache";

describe("ratings cache document", () => {
  it("round trips valid normalized entries", () => {
    const document = emptyRatingsCache();
    const rating = { system: "imdb", provider: "imdb-dataset", value: 8.4,
      scale: 10, voteCount: 123, observedAt: 1 } as const;
    document.ratings["tt1:imdb:imdb-dataset"] = createCachedRating(
      "tt1:imdb:imdb-dataset", rating, 1, "etag-a",
    );
    expect(parseRatingsCache(document)).toEqual({ document, rejectedEntries: [] });
  });

  it("rejects unknown versions, invalid ratings, and credential-like fields", () => {
    expect(parseRatingsCache({ ...emptyRatingsCache(), version: 2 }).documentError)
      .toContain("version");
    const invalid = emptyRatingsCache();
    invalid.ratings.bad = {
      key: "bad",
      rating: { system: "imdb", provider: "imdb-dataset", value: 11, scale: 10, observedAt: 1 },
      fetchedAt: 1, expiresAt: 2, staleUntil: 3,
    };
    expect(parseRatingsCache(invalid).rejectedEntries).toEqual(["ratings:bad"]);
    expect(parseRatingsCache({ ...emptyRatingsCache(), apiKey: "secret" }).documentError)
      .toContain("credential");
  });
});
