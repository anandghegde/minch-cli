import { describe, expect, it, vi } from "vitest";
import { createCachedRating } from "../../src/discovery/ratings/cache";
import { createRatingsCacheRepository } from "../../src/discovery/ratings/cache-repository";

describe("ratings cache repository", () => {
  it("recovers from corrupt JSON and coalesces atomic repository writes", async () => {
    const writes: unknown[] = [];
    const repository = createRatingsCacheRepository({
      readFile: vi.fn(async () => "not json"),
      writeJson: vi.fn(async (_file, value) => { writes.push(value); }),
    });
    expect((await repository.load()).documentError).toContain("JSON");
    const rating = { system: "imdb", provider: "imdb-dataset", value: 8,
      scale: 10, observedAt: 10 } as const;
    await Promise.all([
      repository.putRating(createCachedRating("tt1:imdb:imdb-dataset", rating, 10)),
      repository.putMissing("tt2", { checkedAt: 10, expiresAt: 20 }),
    ]);
    await repository.flush();
    const snapshot = await repository.snapshot();
    expect(snapshot.ratings["tt1:imdb:imdb-dataset"]?.rating.value).toBe(8);
    expect(snapshot.missing.tt2).toBeDefined();
    expect(writes.length).toBeGreaterThan(0);
  });

  it("refuses credential-like fields instead of persisting them", async () => {
    const writeJson = vi.fn(async () => {});
    const repository = createRatingsCacheRepository({
      readFile: vi.fn(async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }),
      writeJson,
    });
    await expect(repository.putRating({
      ...createCachedRating("tt1:imdb:imdb-dataset", {
        system: "imdb", provider: "imdb-dataset", value: 8, scale: 10, observedAt: 1,
      }, 1),
      apiKey: "must-not-store",
    } as never)).rejects.toThrow("invalid cached rating");
    expect(writeJson).not.toHaveBeenCalled();
  });
});
