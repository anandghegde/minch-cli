import { describe, expect, it, vi } from "vitest";
import { createRatingsCacheRepository } from "../../src/discovery/ratings/cache-repository";
import { createRatingIdentityResolver } from "../../src/discovery/ratings/identity-resolver";
import type { CatalogTitle } from "../../src/discovery/types";

const movie: CatalogTitle = {
  id: "canonical:movie:tmdb:1", title: "Synthetic Movie", year: 2026,
  mediaType: "movie", tmdbId: 1, originCountries: [], genreIds: [],
};

function repository() {
  return createRatingsCacheRepository({
    readFile: vi.fn(async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }),
    writeJson: vi.fn(async () => {}),
  });
}

describe("rating identity resolver", () => {
  it("uses an existing IMDb ID without making a request", async () => {
    const enrich = vi.fn();
    const resolver = createRatingIdentityResolver({ repository: repository(), enricher: { enrich } });
    const result = await resolver.resolve([{ ...movie, imdbId: "tt9000001" }]);
    expect(result.get(movie.id)).toBe("tt9000001");
    expect(enrich).not.toHaveBeenCalled();
  });

  it("uses the correct movie endpoint data and persists positive identity", async () => {
    const repo = repository();
    const enrich = vi.fn(async () => ({ tmdbId: 1, mediaType: "movie" as const,
      imdbId: "tt9000001", warnings: [], fetchedAt: 1 }));
    const resolver = createRatingIdentityResolver({ repository: repo, enricher: { enrich }, now: () => 10 });
    expect((await resolver.resolve([movie])).get(movie.id)).toBe("tt9000001");
    expect(enrich).toHaveBeenCalledWith(
      { tmdbId: 1, mediaType: "movie", missingFields: ["external_ids"] },
      expect.any(Object),
    );
    expect((await repo.getIdentity("tmdb:movie:1"))?.imdbId).toBe("tt9000001");
  });

  it("resolves a chart title from an exact ordered movie or series suggestion", async () => {
    const resolver = createRatingIdentityResolver({
      repository: repository(),
      enricher: { enrich: vi.fn() },
      searchTitle: vi.fn(async () => [
        { imdbId: "tt9000002", title: "Chart Show", mediaType: "series" as const },
      ]),
    });
    const chartTitle: CatalogTitle = {
      id: "apify:flixpatrol:netflix:show:chart-show",
      title: "Chart Show",
      mediaType: "series",
      originCountries: [],
      genreIds: [],
    };

    expect((await resolver.resolve([chartTitle])).get(chartTitle.id)).toBe("tt9000002");
  });

  it("rejects ambiguous Blu-ray search matches", async () => {
    const resolver = createRatingIdentityResolver({
      repository: repository(),
      enricher: { enrich: vi.fn() },
      searchTmdbMovie: vi.fn(async () => [
        { tmdbId: 1, title: "Synthetic Movie", year: 2026, imdbId: "tt1" },
        { tmdbId: 2, title: "Synthetic Movie", year: 2026, imdbId: "tt2" },
      ]),
    });
    const result = await resolver.resolve([{ ...movie, id: "bluray:item", tmdbId: undefined }]);
    expect(result.get("bluray:item")).toBeUndefined();
  });

  it("searches aggregated Blu-ray canonical titles without external IDs", async () => {
    const search = vi.fn(async () => [{
      tmdbId: 42, title: "Synthetic Movie", year: 2026,
    }]);
    const enrich = vi.fn(async () => ({
      tmdbId: 42, mediaType: "movie" as const, imdbId: "tt9000042",
      warnings: [], fetchedAt: 1,
    }));
    const resolver = createRatingIdentityResolver({
      repository: repository(),
      enricher: { enrich },
      searchTmdbMovie: search,
    });
    const aggregated: CatalogTitle = {
      ...movie,
      id: "canonical:movie:title:synthetic-movie:2026:bluray:item",
      tmdbId: undefined,
    };

    expect((await resolver.resolve([aggregated])).get(aggregated.id)).toBe("tt9000042");
    expect(search).toHaveBeenCalledWith(aggregated, expect.any(Object));
    expect(enrich).toHaveBeenCalledWith(
      { tmdbId: 42, mediaType: "movie", missingFields: ["external_ids"] },
      expect.any(Object),
    );
  });
});
