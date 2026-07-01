import { describe, expect, it } from "vitest";
import { dedupe, defaultOrder, nextSort, sortResults } from "../src/sources/search";
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

  it("defaultOrder is most seeders first", () => {
    expect(defaultOrder(list).map((x) => x.seeders)).toEqual([50, 20, 5]);
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

  it("nextSort cycles and wraps", () => {
    let s = nextSort("default");
    expect(s).toEqual({ field: "seeders", dir: "desc" });
    // cycle all the way around back to default
    for (let i = 0; i < 5; i++) s = nextSort(s);
    expect(s).toBe("default");
  });
});
