import { describe, expect, it } from "vitest";
import { inferSearchIntent } from "../src/sources/intent";
import { rankResults, scoreResult } from "../src/sources/ranking";
import type { TorrentResult } from "../src/sources/types";

function r(over: Partial<TorrentResult>): TorrentResult {
  return {
    infoHash: "0".repeat(40),
    name: "x",
    sizeBytes: 0,
    seeders: 0,
    leechers: 0,
    source: "s",
    magnet: "magnet:?xt=urn:btih:0",
    ...over,
  };
}

describe("ranking", () => {
  it("ranks a healthy trusted result above a dead one", () => {
    const intent = inferSearchIntent("movie interstellar");
    const ranked = rankResults(
      [
        r({ name: "Interstellar 2014 1080p x265", source: "yts", seeders: 500, leechers: 20, added: 100 }),
        r({ name: "Interstellar 4K", source: "unknown", seeders: 0, leechers: 0 }),
      ],
      intent,
    );
    expect(ranked[0]?.source).toBe("yts");
    expect(scoreResult(ranked[0]!, intent)).toBeGreaterThan(scoreResult(ranked[1]!, intent));
  });

  it("boosts preferred sources for the intent", () => {
    const intent = inferSearchIntent("anime attack on titan");
    const a = r({ name: "Attack on Titan S01E01", source: "nyaa", seeders: 100 });
    const b = r({ name: "Attack on Titan S01E01", source: "solidtorrents", seeders: 100 });
    expect(rankResults([b, a], intent)[0]?.source).toBe("nyaa");
  });

  it("penalizes suspicious titles", () => {
    const intent = inferSearchIntent("game elden ring");
    const clean = r({ name: "Elden Ring FitGirl Repack", source: "fitgirl", seeders: 50 });
    const sus = r({ name: "Elden Ring keygen only.exe", source: "fitgirl", seeders: 50 });
    expect(rankResults([sus, clean], intent)[0]?.name).toBe(clean.name);
  });

  it("is stable and does not mutate the input order", () => {
    const intent = inferSearchIntent("movie dune");
    const list = [
      r({ name: "Dune 720p", source: "yts", seeders: 10 }),
      r({ name: "Dune 1080p", source: "yts", seeders: 200 }),
    ];
    const ranked = rankResults(list, intent);
    expect(ranked[0]?.seeders).toBe(200);
    expect(list[0]?.seeders).toBe(10);
  });
});
