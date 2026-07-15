import { describe, expect, it, vi } from "vitest";
import { createRatingsCacheRepository } from "../../src/discovery/ratings/cache-repository";
import { createMdblistBackend } from "../../src/discovery/ratings/mdblist";
import type { CatalogTitle } from "../../src/discovery/types";

const title: CatalogTitle = {
  id: "canonical:movie:tmdb:123", title: "Synthetic", mediaType: "movie",
  tmdbId: 123, originCountries: [], genreIds: [],
};

function repository() {
  return createRatingsCacheRepository({
    readFile: vi.fn(async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); }),
    writeJson: vi.fn(async () => {}),
  });
}

describe("MDBList ratings backend", () => {
  it("batches TMDB IDs and stores only a normalized IMDb rating", async () => {
    const recordAttempt = vi.fn(async () => ({ used: 1 }));
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      expect(url).toContain("https://api.mdblist.com/rating/movie/imdb");
      expect(JSON.parse(String(init?.body))).toEqual({ provider: "tmdb", ids: ["123"] });
      return new Response(JSON.stringify([{
        provider_id: "123", provider_rating: 8.4, mediatype: "movie",
        ratings: [{ source: "imdb", votes: 146_281 }],
      }]), { status: 200, headers: { "content-type": "application/json" } });
    });
    const backend = createMdblistBackend({
      apiKey: "owned-secret", repository: repository(),
      usage: { recordAttempt, status: vi.fn(), flush: vi.fn() } as never,
      fetchImpl: fetchImpl as typeof fetch,
      now: () => 10,
    });
    expect((await backend.lookup([title])).get(title.id)).toMatchObject({
      system: "imdb", provider: "mdblist", value: 8.4, voteCount: 146_281,
    });
    expect(recordAttempt).toHaveBeenCalledOnce();
  });

  it("never includes an API key in serialized errors", async () => {
    const backend = createMdblistBackend({
      apiKey: "owned-secret", repository: repository(),
      usage: { recordAttempt: vi.fn(async () => ({})) } as never,
      fetchImpl: vi.fn(async () => { throw new Error("failed owned-secret"); }) as typeof fetch,
    });
    await expect(backend.lookup([title])).rejects.not.toThrow("owned-secret");
  });
});
