import { describe, expect, it, vi } from "vitest";
import type {
  DiscoveryAdapter,
  DiscoveryFetchOptions,
} from "../../src/discovery/adapter";

interface FakeRequest {
  region: string;
}

describe("DiscoveryAdapter", () => {
  it("supports an offline fake with a normalized snapshot and injected fetch", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const controller = new AbortController();
    let seenOptions: DiscoveryFetchOptions | undefined;
    const adapter: DiscoveryAdapter<FakeRequest> = {
      id: "tmdb",
      label: "Fake TMDB",
      capabilities: {
        features: ["trending", "regional_release"],
        mediaTypes: ["movie", "series"],
        regions: ["IN"],
      },
      isConfigured: () => true,
      fetch: async (request, options) => {
        seenOptions = options;
        return {
          source: "tmdb",
          titles: [
            {
              id: `fake:${request.region}:1`,
              title: "Fixture",
              mediaType: "movie",
              originCountries: [],
              genreIds: [],
            },
          ],
          events: [],
          fetchedAt: 1_783_665_832_000,
          cursor: "fixture-cursor",
          warnings: [{ code: "partial", message: "Fixture warning" }],
        };
      },
    };

    const snapshot = await adapter.fetch(
      { region: "IN" },
      { fetchImpl, signal: controller.signal },
    );

    expect(adapter.isConfigured()).toBe(true);
    expect(adapter.capabilities.features).toContain("regional_release");
    expect(snapshot).toMatchObject({
      source: "tmdb",
      fetchedAt: 1_783_665_832_000,
      cursor: "fixture-cursor",
      warnings: [{ code: "partial" }],
    });
    expect(seenOptions).toEqual({ fetchImpl, signal: controller.signal });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
