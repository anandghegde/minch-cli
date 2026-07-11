import { describe, expect, it } from "vitest";
import {
  tokenize,
  parseQuery,
  matchScore,
  logSeeders,
  rankResults,
  filterByRelevance,
  sizeReasonableness,
} from "../src/sources/relevance";
import { parseReleaseName } from "../src/sources/releasename";
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

describe("tokenize", () => {
  it("lowercases and splits on non-word chars", () => {
    expect(tokenize("Spider-Man Far From Home")).toEqual([
      "spider",
      "man",
      "far",
      "from",
      "home",
    ]);
  });

  it("drops stop words and 1-char tokens", () => {
    expect(tokenize("The A of An and X Movie")).toEqual(["movie"]);
  });

  it("drops expanded stop words (or, to) but keeps from", () => {
    expect(tokenize("guide to linux or windows")).toEqual(["guide", "linux", "windows"]);
    // "from" stays so Far From Home keeps structure
    expect(tokenize("far from home")).toEqual(["far", "from", "home"]);
  });

  it("keeps dotted version numbers as whole tokens", () => {
    expect(tokenize("ubuntu 24.04")).toEqual(["ubuntu", "24.04"]);
    expect(tokenize("package 1.2.3 release")).toEqual(["package", "1.2.3", "release"]);
  });

  it("normalizes apostrophes so Zoey's and Zoeys compare equal", () => {
    expect(tokenize("Zoey's Extraordinary Playlist")).toEqual(
      tokenize("Zoeys Extraordinary Playlist"),
    );
    expect(tokenize("Zoey's")).toEqual(["zoeys"]);
  });

  it("normalizes dashes (hyphen, en-dash, em-dash)", () => {
    expect(tokenize("foo-bar")).toEqual(["foo", "bar"]);
    expect(tokenize("foo\u2013bar")).toEqual(["foo", "bar"]);
    expect(tokenize("foo\u2014bar")).toEqual(["foo", "bar"]);
  });

  it("returns empty for blank / stop-only input", () => {
    expect(tokenize("")).toEqual([]);
    expect(tokenize("   ")).toEqual([]);
    expect(tokenize("the a an of and or to")).toEqual([]);
  });
});

describe("matchScore", () => {
  const q = tokenize("breaking bad");

  it("tier 2 when all query tokens are present", () => {
    const m = matchScore("Breaking.Bad.S01E01.1080p.BluRay", q);
    expect(m.tier).toBe(2);
    expect(m.score).toBeGreaterThan(0);
  });

  it("tier 1 when only some tokens match", () => {
    const m = matchScore("Breaking Point 2020", q);
    expect(m.tier).toBe(1);
  });

  it("tier 0 when none match", () => {
    const m = matchScore("Better Call Saul S01", q);
    expect(m.tier).toBe(0);
    expect(m.score).toBe(0);
  });

  it("rewards higher coverage within partial matches", () => {
    const tokens = tokenize("the matrix reloaded");
    const fullish = matchScore("The Matrix Reloaded 1080p", tokens);
    const partial = matchScore("The Matrix Revolutions 1080p", tokens);
    expect(fullish.tier).toBe(2);
    expect(partial.tier).toBe(1);
    expect(fullish.score).toBeGreaterThan(partial.score);
  });

  it("rewards contiguous and leading token runs", () => {
    const tokens = tokenize("lord rings");
    const leading = matchScore("Lord Rings Extended 1080p", tokens);
    const buried = matchScore("Extended Cut Lord Rings 1080p", tokens);
    // Both full matches; leading contiguous should score at least as high.
    expect(leading.tier).toBe(2);
    expect(buried.tier).toBe(2);
    expect(leading.score).toBeGreaterThanOrEqual(buried.score);
  });

  it("penalizes low signal-to-noise (many extra name tokens)", () => {
    const tokens = tokenize("dune");
    const clean = matchScore("Dune 2021 1080p", tokens);
    const noisy = matchScore(
      "Dune 2021 Multi Audio Dual Audio Hindi English 1080p BluRay x264 AAC ESub",
      tokens,
    );
    expect(clean.tier).toBe(2);
    expect(noisy.tier).toBe(2);
    expect(clean.score).toBeGreaterThan(noisy.score);
  });

  it("degrades gracefully on empty / garbage names", () => {
    expect(matchScore("", q)).toEqual({ tier: 0, score: 0 });
    expect(matchScore("!!!", q)).toEqual({ tier: 0, score: 0 });
  });

  it("matches glued name token against multi-word query (spider man → spiderman)", () => {
    const tokens = tokenize("spider man");
    const m = matchScore("SpiderMan.No.Way.Home.1080p", tokens);
    expect(m.tier).toBe(2);
  });

  it("matches glued query token against multi-token name (spiderman → spider + man)", () => {
    const tokens = tokenize("spiderman");
    const m = matchScore("Spider.Man.No.Way.Home.1080p", tokens);
    expect(m.tier).toBe(2);
  });

  it("rewards higher title similarity for closer cleaned titles", () => {
    const tokens = tokenize("spider man no way home");
    const close = matchScore("Spider.Man.No.Way.Home.1080p.BluRay", tokens);
    const far = matchScore(
      "Spider.Man.No.Way.Home.Extended.Cut.Bonus.Extras.Featurettes.1080p.BluRay",
      tokens,
    );
    expect(close.tier).toBe(2);
    expect(far.tier).toBe(2);
    // Cleaner title (higher SNR / similarity) should score higher.
    expect(close.score).toBeGreaterThan(far.score);
  });
});

describe("logSeeders", () => {
  it("buckets by log10, floored at 1 seeder", () => {
    expect(logSeeders(0)).toBe(0); // log10(1) = 0
    expect(logSeeders(1)).toBe(0);
    expect(logSeeders(10)).toBe(1);
    expect(logSeeders(100)).toBe(2);
    expect(logSeeders(1000)).toBe(3);
    expect(logSeeders(500)).toBe(3); // round(2.70) = 3
    expect(logSeeders(50)).toBe(2); // round(1.70) = 2
  });
});

describe("rankResults", () => {
  it("exact-match with few seeders beats wrong-title with many seeders", () => {
    const list = [
      r({
        infoHash: "1".repeat(40),
        name: "Completely Unrelated Garbage 1080p",
        seeders: 50_000,
        added: 500,
      }),
      r({
        infoHash: "2".repeat(40),
        name: "Inception 2010 1080p BluRay",
        seeders: 5,
        added: 100,
      }),
    ];
    const out = rankResults(list, "inception");
    expect(out[0]!.name).toMatch(/Inception/);
    expect(out[1]!.name).toMatch(/Unrelated/);
  });

  it("none-match sinks but survives", () => {
    const list = [
      r({ infoHash: "1".repeat(40), name: "Other Movie", seeders: 100 }),
      r({ infoHash: "2".repeat(40), name: "Inception 1080p", seeders: 1 }),
      r({ infoHash: "3".repeat(40), name: "Also Unrelated", seeders: 200 }),
    ];
    const out = rankResults(list, "inception");
    expect(out).toHaveLength(3);
    expect(out[0]!.name).toMatch(/Inception/);
    // Non-matches still present at the bottom.
    expect(out.slice(1).map((x) => x.name).sort()).toEqual(
      ["Also Unrelated", "Other Movie"].sort(),
    );
  });

  it("uses recency as tiebreaker when tier/score/seeders match", () => {
    const list = [
      r({
        infoHash: "1".repeat(40),
        name: "Dune 2021",
        seeders: 100,
        added: 1000,
      }),
      r({
        infoHash: "2".repeat(40),
        name: "Dune 2021",
        seeders: 100,
        added: 2000,
      }),
    ];
    const out = rankResults(list, "dune");
    expect(out[0]!.added).toBe(2000);
    expect(out[1]!.added).toBe(1000);
  });

  it("falls back to seeders order when query has no tokens", () => {
    const list = [
      r({ infoHash: "1".repeat(40), name: "a", seeders: 5, added: 1 }),
      r({ infoHash: "2".repeat(40), name: "b", seeders: 50, added: 2 }),
    ];
    expect(rankResults(list, "").map((x) => x.seeders)).toEqual([50, 5]);
    expect(rankResults(list, "the a an").map((x) => x.seeders)).toEqual([50, 5]);
  });

  it("prefers full AND match over partial when seeders favor partial", () => {
    const list = [
      r({
        infoHash: "1".repeat(40),
        name: "Spider Something Else 1080p",
        seeders: 5000,
      }),
      r({
        infoHash: "2".repeat(40),
        name: "Spider Man No Way Home 1080p",
        seeders: 10,
      }),
    ];
    const out = rankResults(list, "spider man");
    expect(out[0]!.name).toMatch(/No Way Home/);
  });

  it("prefers exact query year over wrong year when both match title", () => {
    const list = [
      r({
        infoHash: "1".repeat(40),
        name: "Dune.Part.Two.2024.1080p.BluRay",
        seeders: 5000,
      }),
      r({
        infoHash: "2".repeat(40),
        name: "Dune.2021.1080p.BluRay",
        seeders: 50,
      }),
      r({
        infoHash: "3".repeat(40),
        name: "Dune.1984.1080p.BluRay",
        seeders: 2000,
      }),
    ];
    const out = rankResults(list, "dune 2021");
    expect(out[0]!.name).toMatch(/2021/);
    // Wrong years stay below exact even with more seeders / cleaner SNR.
    expect(out.map((x) => x.name).findIndex((n) => /2021/.test(n))).toBe(0);
    expect(out.map((x) => x.name).findIndex((n) => /1984/.test(n))).toBeGreaterThan(0);
    expect(out.map((x) => x.name).findIndex((n) => /2024/.test(n))).toBeGreaterThan(0);
  });

  it("prefers matching season/episode over other episodes of same show", () => {
    const list = [
      r({
        infoHash: "1".repeat(40),
        name: "Breaking.Bad.S05E01.1080p.BluRay",
        seeders: 5000,
      }),
      r({
        infoHash: "2".repeat(40),
        name: "Breaking.Bad.S05E14.1080p.BluRay",
        seeders: 20,
      }),
      r({
        infoHash: "3".repeat(40),
        name: "Breaking.Bad.S04E14.1080p.BluRay",
        seeders: 3000,
      }),
    ];
    const out = rankResults(list, "breaking bad s05e14");
    expect(out[0]!.name).toMatch(/S05E14/i);
  });

  it("demotes CAM/trash below clean release when text match is equal", () => {
    const list = [
      r({
        infoHash: "1".repeat(40),
        name: "Inception.2010.CAM.x264",
        seeders: 4000,
      }),
      r({
        infoHash: "2".repeat(40),
        name: "Inception.2010.1080p.BluRay.x264",
        seeders: 50,
      }),
    ];
    const out = rankResults(list, "inception");
    expect(out[0]!.name).toMatch(/BluRay/);
    expect(out[1]!.name).toMatch(/CAM/);
  });

  it("does not break non-media dotted version queries", () => {
    const list = [
      r({
        infoHash: "1".repeat(40),
        name: "Completely Unrelated 1080p",
        seeders: 50_000,
      }),
      r({
        infoHash: "2".repeat(40),
        name: "ubuntu-24.04-desktop-amd64.iso",
        seeders: 100,
      }),
      r({
        infoHash: "3".repeat(40),
        name: "Ubuntu 22.04 Server",
        seeders: 5000,
      }),
    ];
    const out = rankResults(list, "ubuntu 24.04");
    expect(out[0]!.name.toLowerCase()).toContain("24.04");
  });

  it("does not mutate input results (ephemeral ranking only)", () => {
    const item = r({
      infoHash: "1".repeat(40),
      name: "Inception 2010",
      seeders: 10,
    });
    const list = [item];
    const before = JSON.stringify(item);
    rankResults(list, "inception");
    expect(JSON.stringify(item)).toBe(before);
    expect("_rank" in item).toBe(false);
  });

  // --- Phase B: phrases + excludes -------------------------------------------

  it("requires contiguous phrase tokens for quoted phrases", () => {
    const list = [
      r({
        infoHash: "1".repeat(40),
        name: "Spider.Something.Man.Home.1080p",
        seeders: 5000,
      }),
      r({
        infoHash: "2".repeat(40),
        name: "Spider.Man.No.Way.Home.1080p",
        seeders: 10,
      }),
    ];
    const out = rankResults(list, '"spider man" home');
    expect(out[0]!.name).toMatch(/No\.Way\.Home/);
  });

  it("gives tier-3 boost when phrase + must tokens all match", () => {
    const withPhrase = matchScore("Spider.Man.No.Way.Home.1080p", ["home"], [
      ["spider", "man"],
    ]);
    const mustOnly = matchScore("Home.Alone.Spider.Far.Away.1080p", ["home"], [
      ["spider", "man"],
    ]);
    // Phrase satisfied → tier 3; must-only without contiguous phrase → lower.
    expect(withPhrase.tier).toBe(3);
    expect(mustOnly.tier).toBeLessThan(3);
    expect(withPhrase.score).toBeGreaterThan(mustOnly.score);
  });

  it.each([
    ['"the matrix"', "The.Matrix.1999.1080p", 3],
    ['"the matrix"', "Matrix.The.1999.1080p", 0],
    ['"lord of the rings"', "Lord.Of.The.Rings.2001.1080p", 3],
  ])("matches phrase query %s with stop words", (query, name, expectedTier) => {
    const parsed = parseQuery(query);
    expect(matchScore(name, parsed.must, parsed.phrases).tier).toBe(expectedTier);
  });

  it('filters out excluded tokens: "spider man" -cam drops CAM rows', () => {
    const list = [
      r({
        infoHash: "1".repeat(40),
        name: "Spider.Man.No.Way.Home.2021.CAM.x264",
        seeders: 9000,
      }),
      r({
        infoHash: "2".repeat(40),
        name: "Spider.Man.No.Way.Home.2021.1080p.BluRay",
        seeders: 50,
      }),
      r({
        infoHash: "3".repeat(40),
        name: "Unrelated.Garbage.1080p",
        seeders: 100,
      }),
    ];
    const out = rankResults(list, '"spider man" -cam');
    expect(out.every((x) => !/CAM/i.test(x.name))).toBe(true);
    expect(out[0]!.name).toMatch(/BluRay/);
    // Exclude removes rows; unrelated without phrase may remain or sink.
    expect(out.find((x) => /CAM/i.test(x.name))).toBeUndefined();
  });

  it.each([
    ["-cam", {}],
    ["-cam", { strictAnd: true }],
    ['"the matrix" -cam', { strictAnd: true }],
  ] as const)("honors exclusions for %s with options %o", (query, opts) => {
    const list = [
      r({ infoHash: "1".repeat(40), name: "The.Matrix.1999.CAM", seeders: 1000 }),
      r({ infoHash: "2".repeat(40), name: "The.Matrix.1999.BluRay", seeders: 10 }),
    ];
    const out = rankResults(list, query, opts);
    expect(out.map((x) => x.name)).toEqual(["The.Matrix.1999.BluRay"]);
  });

  it("does not crash on unclosed quotes", () => {
    const list = [
      r({
        infoHash: "1".repeat(40),
        name: "No.Way.Home.1080p",
        seeders: 10,
      }),
    ];
    expect(() => rankResults(list, '"no way home')).not.toThrow();
    const out = rankResults(list, '"no way home');
    expect(out[0]!.name).toMatch(/No\.Way\.Home/);
  });

  it("plain queries without operators stay Phase-A compatible", () => {
    const list = [
      r({
        infoHash: "1".repeat(40),
        name: "Completely Unrelated Garbage 1080p",
        seeders: 50_000,
      }),
      r({
        infoHash: "2".repeat(40),
        name: "Inception 2010 1080p BluRay",
        seeders: 5,
      }),
    ];
    const out = rankResults(list, "inception");
    expect(out[0]!.name).toMatch(/Inception/);
  });

  // --- Phase C: strictAnd, hideTrash, preferQuality, size reasonableness ----

  it("strictAnd hides tier < 2 (partial / none matches)", () => {
    const list = [
      r({
        infoHash: "1".repeat(40),
        name: "Completely Unrelated Garbage 1080p",
        seeders: 50_000,
      }),
      r({
        infoHash: "2".repeat(40),
        name: "Inception Point Of No Return",
        seeders: 9000,
      }),
      r({
        infoHash: "3".repeat(40),
        name: "Inception 2010 1080p BluRay",
        seeders: 5,
      }),
    ];
    const soft = rankResults(list, "inception");
    expect(soft).toHaveLength(3);

    const strict = rankResults(list, "inception", { strictAnd: true });
    expect(strict.every((x) => /inception/i.test(x.name))).toBe(true);
    expect(strict.find((x) => /Unrelated/i.test(x.name))).toBeUndefined();
    // Partial "Inception Point…" still contains the token → tier 2 for single-token query.
    expect(strict.map((x) => x.name).join(" ")).toMatch(/Inception/);
  });

  it("strictAnd with multi-token query drops partial-token rows", () => {
    const list = [
      r({
        infoHash: "1".repeat(40),
        name: "The.Matrix.1999.1080p",
        seeders: 100,
      }),
      r({
        infoHash: "2".repeat(40),
        name: "The.Matrix.Reloaded.2003.1080p",
        seeders: 50,
      }),
      r({
        infoHash: "3".repeat(40),
        name: "Unrelated.Reload.Pack",
        seeders: 9000,
      }),
    ];
    const out = rankResults(list, "matrix reloaded", { strictAnd: true });
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toMatch(/Reloaded/);
  });

  it("hideTrash drops CAM/SAMPLE rows instead of only sinking them", () => {
    const list = [
      r({
        infoHash: "1".repeat(40),
        name: "Inception.2010.CAM.x264",
        seeders: 4000,
      }),
      r({
        infoHash: "2".repeat(40),
        name: "Inception.2010.1080p.BluRay.x264",
        seeders: 50,
      }),
    ];
    const out = rankResults(list, "inception", { hideTrash: true });
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toMatch(/BluRay/);
  });

  it("preferQuality ranks higher quality above more seeders when text ties", () => {
    const list = [
      r({
        infoHash: "1".repeat(40),
        name: "Inception.2010.480p.XviD",
        seeders: 5000,
        sizeBytes: 700_000_000,
      }),
      r({
        infoHash: "2".repeat(40),
        name: "Inception.2010.2160p.Remux",
        seeders: 50,
        sizeBytes: 40_000_000_000,
      }),
    ];
    // Without preferQuality, higher seeder buckets win after trash/text ties.
    const without = rankResults(list, "inception");
    expect(without[0]!.name).toMatch(/480p/);

    // With preferQuality, quality sits before seeders → Remux wins despite fewer seeds.
    const withQ = rankResults(list, "inception", { preferQuality: true });
    expect(withQ[0]!.name).toMatch(/2160p/);
    expect(withQ[1]!.name).toMatch(/480p/);
  });

  it("preferQuality does not break non-media software queries", () => {
    const list = [
      r({
        infoHash: "1".repeat(40),
        name: "ubuntu-24.04-desktop-amd64.iso",
        seeders: 100,
        sizeBytes: 5_000_000_000,
      }),
      r({
        infoHash: "2".repeat(40),
        name: "Ubuntu 22.04 Server",
        seeders: 5000,
        sizeBytes: 2_000_000_000,
      }),
    ];
    const out = rankResults(list, "ubuntu 24.04", { preferQuality: true });
    expect(out[0]!.name.toLowerCase()).toContain("24.04");
  });

  it("size reasonableness soft-penalizes absurd 1080p sizes", () => {
    const tiny = parseReleaseName("Movie.2020.1080p.BluRay.x264");
    const ok = parseReleaseName("Movie.2020.1080p.BluRay.x264");
    const huge = parseReleaseName("Movie.2020.1080p.BluRay.x264");
    expect(sizeReasonableness(tiny, 50_000_000)).toBe(-1); // 50 MB
    expect(sizeReasonableness(ok, 2_000_000_000)).toBe(0); // 2 GB
    expect(sizeReasonableness(huge, 40_000_000_000)).toBe(-1); // 40 GB

    // No media tags → never penalize (software / generic names).
    const soft = parseReleaseName("ubuntu-24.04-desktop-amd64.iso");
    expect(sizeReasonableness(soft, 50_000_000)).toBe(0);
  });

  it("size reasonableness ranks reasonable 1080p above absurd pack of same title", () => {
    // Identical names so textScore/tier/seeders all tie; only size differs.
    const list = [
      r({
        infoHash: "1".repeat(40),
        name: "Dune.2021.1080p.BluRay.x264",
        seeders: 100,
        sizeBytes: 80_000_000_000, // absurd for single 1080p
      }),
      r({
        infoHash: "2".repeat(40),
        name: "Dune.2021.1080p.BluRay.x264",
        seeders: 100,
        sizeBytes: 2_000_000_000,
      }),
    ];
    const out = rankResults(list, "dune 2021");
    expect(out[0]!.sizeBytes).toBe(2_000_000_000);
    expect(out[1]!.sizeBytes).toBe(80_000_000_000);
  });

  it("filterByRelevance applies strictAnd/hideTrash without sorting", () => {
    const list = [
      r({
        infoHash: "1".repeat(40),
        name: "Inception.2010.CAM.x264",
        seeders: 9000,
      }),
      r({
        infoHash: "2".repeat(40),
        name: "Unrelated.Garbage",
        seeders: 100,
      }),
      r({
        infoHash: "3".repeat(40),
        name: "Inception.2010.1080p.BluRay",
        seeders: 5,
      }),
    ];
    const out = filterByRelevance(list, "inception", {
      strictAnd: true,
      hideTrash: true,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.name).toMatch(/BluRay/);
    // Preserves input order among survivors (no re-sort).
    expect(out[0]).toBe(list[2]);
  });

  it("filterByRelevance retains exclusions with a manual sort and no other filter", () => {
    const list = [
      r({ infoHash: "1".repeat(40), name: "Movie.CAM", seeders: 1000 }),
      r({ infoHash: "2".repeat(40), name: "Movie.BluRay", seeders: 10 }),
    ];
    const out = filterByRelevance(list, "-cam");
    expect(out).toEqual([list[1]]);
  });
});
