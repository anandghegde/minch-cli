import { describe, expect, it, vi } from "vitest";
import { createDiscoveryRatingsService } from "../../src/discovery/ratings/service";
import type { CatalogTitle } from "../../src/discovery/types";

const title: CatalogTitle = {
  id: "canonical:movie:tmdb:1", title: "Synthetic", mediaType: "movie",
  tmdbId: 1, originCountries: [], genreIds: [], ratings: [{
    system: "tmdb", provider: "tmdb", value: 9.8, scale: 10,
    voteCount: 100, observedAt: 1,
  }],
};

describe("ratings orchestration", () => {
  it("retains correctly labeled fallback when exact enrichment is off", async () => {
    const result = await createDiscoveryRatingsService({}).load([title], { provider: "off" });
    expect(result.exactCount).toBe(0);
    expect(result.fallbackCount).toBe(1);
    expect(result.byTitleId.get(title.id)?.[0]?.system).toBe("tmdb");
  });

  it("prefers exact IMDb even when its numeric value is lower", async () => {
    const service = createDiscoveryRatingsService({
      identities: { resolve: vi.fn(async () => new Map([[title.id, "tt9000001"]])) },
      dataset: { lookup: vi.fn(async () => new Map([["tt9000001", {
        system: "imdb" as const, provider: "imdb-dataset" as const,
        value: 6.2, scale: 10 as const, voteCount: 2, observedAt: 2,
      }]])) },
    });
    const result = await service.load([title], { provider: "imdb-dataset" });
    expect(result.exactCount).toBe(1);
    expect(result.byTitleId.get(title.id)?.map((rating) => rating.system)).toEqual(["imdb", "tmdb"]);
  });

  it("does not reject all fallbacks after a provider failure", async () => {
    const service = createDiscoveryRatingsService({
      mdblist: { lookup: vi.fn(async () => { throw new Error("offline"); }) },
    });
    const result = await service.load([title], { provider: "mdblist" });
    expect(result.error?.message).toBe("offline");
    expect(result.fallbackCount).toBe(1);
  });

  it("publishes IMDb results before a large identity batch completes", async () => {
    const titles = Array.from({ length: 9 }, (_, index): CatalogTitle => ({
      ...title,
      id: `canonical:movie:tmdb:${index + 1}`,
      tmdbId: index + 1,
    }));
    const updates: number[] = [];
    const service = createDiscoveryRatingsService({
      identities: { resolve: vi.fn(async (batch: readonly CatalogTitle[]) =>
        new Map<string, string>(batch.map((item) =>
        [item.id, `tt900000${item.tmdbId}`]))) },
      dataset: { lookup: vi.fn(async (ids: readonly string[]) =>
        new Map(ids.map((id): [string, {
          system: "imdb"; provider: "imdb-dataset"; value: number;
          scale: 10; observedAt: number;
        }] => [id, {
        system: "imdb" as const, provider: "imdb-dataset" as const,
        value: 8, scale: 10 as const, observedAt: 2,
      }]))) },
    });

    const result = await service.load(titles, {
      provider: "imdb-dataset",
      onUpdate: (update) => updates.push(update.exactCount),
    });

    expect(updates).toEqual([8]);
    expect(result.exactCount).toBe(9);
  });
});
