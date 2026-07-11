import { describe, expect, it } from "vitest";
import {
  dedupe,
  defaultOrder,
  nextSort,
  sortResults,
  sortLabel,
  SORT_CYCLE,
} from "../src/sources/search";
import { rankResults } from "../src/sources/relevance";
import type { TorrentResult } from "../src/sources/types";

function r(over: Partial<TorrentResult>): TorrentResult {
  return {
    infoHash: "0000000000000000000000000000000000000000",
    name: "x",
    sizeBytes: 0,
    seeders: 0,
    leechers: 0,
    source: "s",
    magnet: "magnet:?xt=urn:btih:0",
    ...over,
  };
}

describe("dedupe", () => {
  it("collapses by info hash, keeping the highest seeders", () => {
    const list = [
      r({ infoHash: "a".repeat(40), seeders: 5, source: "s1" }),
      r({ infoHash: "a".repeat(40), seeders: 50, source: "s2" }),
      r({ infoHash: "b".repeat(40), seeders: 1 }),
    ];
    const out = dedupe(list);
    expect(out).toHaveLength(2);
    const a = out.find((x) => x.infoHash === "a".repeat(40))!;
    expect(a.seeders).toBe(50);
    expect(a.source).toBe("s2");
  });

  it("falls back to title+size when no valid hash", () => {
    const list = [
      r({ infoHash: "notahash", name: "The Movie", sizeBytes: 100, seeders: 2 }),
      r({ infoHash: "alsobad", name: "the movie", sizeBytes: 100, seeders: 9 }),
    ];
    const out = dedupe(list);
    expect(out).toHaveLength(1);
    expect(out[0]!.seeders).toBe(9);
  });
});

describe("sorting", () => {
  const list = [
    r({ infoHash: "1".repeat(40), name: "low", seeders: 5, sizeBytes: 300, added: 100 }),
    r({ infoHash: "2".repeat(40), name: "high", seeders: 50, sizeBytes: 100, added: 200 }),
    r({ infoHash: "3".repeat(40), name: "mid", seeders: 20, sizeBytes: 200, added: 300 }),
  ];

  it("defaultOrder is most seeders first (legacy / trending path)", () => {
    expect(defaultOrder(list).map((x) => x.seeders)).toEqual([50, 20, 5]);
  });

  it("uses a stable source/name/hash key when visible sort fields tie", () => {
    const tied = [
      r({ source: "z", name: "Same", infoHash: "b".repeat(40), seeders: 1, added: 1 }),
      r({ source: "a", name: "Same", infoHash: "a".repeat(40), seeders: 1, added: 1 }),
    ];
    expect(defaultOrder(tied).map((item) => item.source)).toEqual(["a", "z"]);
    expect(sortResults(tied, { field: "seeders", dir: "desc" }).map((item) => item.source))
      .toEqual(["a", "z"]);
  });

  it("keyword default path ranks by query relevance, not raw seeders", () => {
    const mixed = [
      r({
        infoHash: "1".repeat(40),
        name: "Unrelated Blockbuster 1080p",
        seeders: 9000,
      }),
      r({
        infoHash: "2".repeat(40),
        name: "Inception 2010 1080p BluRay",
        seeders: 3,
      }),
    ];
    const ranked = rankResults(mixed, "inception");
    expect(ranked[0]!.name).toMatch(/Inception/);
  });

  it("sorts by size ascending", () => {
    expect(
      sortResults(list, { field: "size", dir: "asc" }).map((x) => x.sizeBytes),
    ).toEqual([100, 200, 300]);
  });

  it("sorts by date descending", () => {
    expect(
      sortResults(list, { field: "date", dir: "desc" }).map((x) => x.added),
    ).toEqual([300, 200, 100]);
  });

  it("sorts missing and invalid dates below known dates in both directions", () => {
    const dates = [
      r({ infoHash: "1".repeat(40), name: "missing" }),
      r({ infoHash: "2".repeat(40), name: "newest", added: 300 }),
      r({ infoHash: "3".repeat(40), name: "invalid", added: Number.NaN }),
      r({ infoHash: "4".repeat(40), name: "oldest", added: 100 }),
      r({ infoHash: "5".repeat(40), name: "middle", added: 200 }),
    ];

    expect(sortResults(dates, { field: "date", dir: "desc" }).map((x) => x.name))
      .toEqual(["newest", "middle", "oldest", "invalid", "missing"]);
    expect(sortResults(dates, { field: "date", dir: "asc" }).map((x) => x.name))
      .toEqual(["oldest", "middle", "newest", "invalid", "missing"]);
  });

  it("sorts by quality descending then log-seeders", () => {
    const qlist = [
      r({
        infoHash: "1".repeat(40),
        name: "Movie.2024.720p.WEBRip.x264",
        seeders: 5000,
      }),
      r({
        infoHash: "2".repeat(40),
        name: "Movie.2024.2160p.BluRay.REMUX.HEVC",
        seeders: 10,
      }),
      r({
        infoHash: "3".repeat(40),
        name: "Movie.2024.1080p.BluRay.x264",
        seeders: 100,
      }),
    ];
    const out = sortResults(qlist, { field: "quality", dir: "desc" });
    expect(out.map((x) => x.name)).toEqual([
      "Movie.2024.2160p.BluRay.REMUX.HEVC",
      "Movie.2024.1080p.BluRay.x264",
      "Movie.2024.720p.WEBRip.x264",
    ]);
  });

  it("nextSort cycles through quality and wraps to default", () => {
    let s: ReturnType<typeof nextSort> = nextSort("default");
    expect(s).toEqual({ field: "seeders", dir: "desc" });
    s = nextSort(s);
    expect(s).toEqual({ field: "quality", dir: "desc" });
    // cycle the rest of the way around back to default
    for (let i = 0; i < SORT_CYCLE.length - 2; i++) s = nextSort(s);
    expect(s).toBe("default");
  });

  it("sortLabel labels default as relevance", () => {
    expect(sortLabel("default")).toBe("relevance");
    expect(sortLabel({ field: "quality", dir: "desc" })).toBe("quality \u25be");
  });
});
