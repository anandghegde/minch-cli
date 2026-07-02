import { describe, it, expect } from "vitest";
import {
  classifyCategory,
  filterByCategory,
  browseSource,
  TRENDING_CATEGORIES,
} from "../src/sources/trending";
import type { Source, TorrentResult } from "../src/sources/types";

const HASH = "a".repeat(40);

function result(partial: Partial<TorrentResult>): TorrentResult {
  return {
    infoHash: HASH,
    name: "x",
    sizeBytes: 0,
    seeders: 0,
    leechers: 0,
    source: "s",
    magnet: `magnet:?xt=urn:btih:${HASH}`,
    ...partial,
  };
}

function fakeSource(over: Partial<Source>): Source {
  return {
    id: "fake",
    label: "Fake",
    kind: "api",
    links: ["https://example.test"],
    requiresConfig: false,
    defaultEnabled: true,
    test: async () => ({ ok: true, status: "ok" }),
    search: async () => [],
    ...over,
  };
}

describe("classifyCategory", () => {
  it("maps known coarse labels to chips", () => {
    expect(classifyCategory("Movies")).toBe("movies");
    expect(classifyCategory("Movies/HD")).toBe("movies");
    expect(classifyCategory("Video")).toBe("movies");
    expect(classifyCategory("TV")).toBe("tv");
    expect(classifyCategory("TV/Anime")).toBe("tv");
    expect(classifyCategory("Anime")).toBe("anime");
    expect(classifyCategory("Games")).toBe("games");
    expect(classifyCategory("Console")).toBe("games");
    expect(classifyCategory("XXX")).toBe("xxx");
    expect(classifyCategory("Audio")).toBe("music");
    expect(classifyCategory("Music")).toBe("music");
  });

  it("is case-insensitive", () => {
    expect(classifyCategory("movies")).toBe("movies");
    expect(classifyCategory("xxx")).toBe("xxx");
  });

  it("returns 'other' for unknown or missing labels", () => {
    expect(classifyCategory(undefined)).toBe("other");
    expect(classifyCategory("")).toBe("other");
    expect(classifyCategory("Books")).toBe("other");
    expect(classifyCategory("Apps")).toBe("other");
  });
});

describe("filterByCategory", () => {
  const rows = [
    result({ name: "a", category: "Movies" }),
    result({ name: "b", category: "TV" }),
    result({ name: "c", category: "Anime" }),
    result({ name: "d", category: undefined }),
  ];

  it("returns everything (same instance) for 'all'", () => {
    expect(filterByCategory(rows, "all")).toBe(rows);
  });

  it("keeps only rows matching the chip", () => {
    expect(filterByCategory(rows, "movies").map((r) => r.name)).toEqual(["a"]);
    expect(filterByCategory(rows, "anime").map((r) => r.name)).toEqual(["c"]);
  });

  it("drops uncategorized rows from specific chips", () => {
    expect(filterByCategory(rows, "music")).toEqual([]);
  });
});

describe("TRENDING_CATEGORIES", () => {
  it("leads with the 'all' chip", () => {
    expect(TRENDING_CATEGORIES[0]!.category).toBe("all");
  });
});

describe("browseSource", () => {
  it("prefers browse() when the source provides one", async () => {
    const browsed = [result({ name: "browsed" })];
    const src = fakeSource({
      browse: async () => browsed,
      search: async () => [result({ name: "searched" })],
    });
    expect(await browseSource(src)).toBe(browsed);
  });

  it("falls back to an empty-query search() when browse is absent", async () => {
    let calledWith: string | null = null;
    const searched = [result({ name: "searched" })];
    const src = fakeSource({
      search: async (q) => {
        calledWith = q;
        return searched;
      },
    });
    expect(await browseSource(src)).toBe(searched);
    expect(calledWith).toBe("");
  });

  it("forwards opts to the underlying call", async () => {
    let seenLimit: number | undefined;
    const src = fakeSource({
      browse: async (opts) => {
        seenLimit = opts?.limit;
        return [];
      },
    });
    await browseSource(src, { limit: 25 });
    expect(seenLimit).toBe(25);
  });
});
