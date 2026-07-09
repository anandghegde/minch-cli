import { describe, expect, it } from "vitest";
import {
  applyFilters,
  emptyFilters,
  filtersFromConfig,
  isEmptyFilters,
  activeFilterCount,
  filterSummary,
  cycleTime,
  cycleSize,
  cycleSeeders,
  cycleMatch,
  TIME_PRESETS,
  SIZE_PRESETS,
  SEEDER_PRESETS,
  MATCH_PRESETS,
  type FilterState,
} from "../src/sources/filters";
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

// Build a FilterState by preset label, so tests don't hardcode indices.
function f(over: {
  time?: string;
  size?: string;
  seeders?: string;
  match?: string;
  hideTrash?: boolean;
}): FilterState {
  return {
    time: over.time ? TIME_PRESETS.findIndex((p) => p.label === over.time) : 0,
    size: over.size ? SIZE_PRESETS.findIndex((p) => p.label === over.size) : 0,
    seeders: over.seeders ? SEEDER_PRESETS.findIndex((p) => p.label === over.seeders) : 0,
    match: over.match ? MATCH_PRESETS.findIndex((p) => p.label === over.match) : 0,
    hideTrash: over.hideTrash === true,
  };
}

const NOW = 1_000_000_000; // fixed reference for deterministic time windows

describe("applyFilters passthrough", () => {
  it("returns the same array instance when no filter is active", () => {
    const list = [r({ name: "a" }), r({ name: "b" })];
    expect(applyFilters(list, emptyFilters, NOW)).toBe(list);
  });

  it("isEmptyFilters is true for the default state", () => {
    expect(isEmptyFilters(emptyFilters)).toBe(true);
  });
});

describe("time window filter", () => {
  const weekSecs = TIME_PRESETS.find((p) => p.label === "week")!.seconds!;
  const list = [
    r({ name: "recent", added: NOW - 10 }),
    r({ name: "stale", added: NOW - weekSecs - 100 }),
    r({ name: "undated" }), // no `added`
  ];

  it("keeps results inside the window and always keeps undated rows", () => {
    const out = applyFilters(list, f({ time: "week" }), NOW);
    expect(out.map((x) => x.name).sort()).toEqual(["recent", "undated"]);
  });

  it("24h window is tighter than week", () => {
    const list2 = [
      r({ name: "hour", added: NOW - 3600 }),
      r({ name: "twoDays", added: NOW - 2 * 24 * 3600 }),
    ];
    expect(applyFilters(list2, f({ time: "24h" }), NOW).map((x) => x.name)).toEqual([
      "hour",
    ]);
  });

  it("'any' time keeps everything", () => {
    expect(applyFilters(list, f({ time: "any" }), NOW)).toHaveLength(3);
  });
});

describe("size filter", () => {
  const list = [
    r({ name: "tiny", sizeBytes: 50 * 1e6 }),
    r({ name: "mid", sizeBytes: 500 * 1e6 }),
    r({ name: "big", sizeBytes: 3 * 1e9 }),
    r({ name: "huge", sizeBytes: 25 * 1e9 }),
  ];

  it("applies the 1-5GB bucket", () => {
    expect(applyFilters(list, f({ size: "1-5GB" }), NOW).map((x) => x.name)).toEqual([
      "big",
    ]);
  });

  it("<100MB has only an upper bound", () => {
    expect(applyFilters(list, f({ size: "<100MB" }), NOW).map((x) => x.name)).toEqual([
      "tiny",
    ]);
  });

  it(">20GB has only a lower bound", () => {
    expect(applyFilters(list, f({ size: ">20GB" }), NOW).map((x) => x.name)).toEqual([
      "huge",
    ]);
  });
});

describe("seeders filter", () => {
  const list = [
    r({ name: "dead", seeders: 0 }),
    r({ name: "few", seeders: 3 }),
    r({ name: "many", seeders: 80 }),
  ];

  it("applies a >=5 threshold", () => {
    expect(applyFilters(list, f({ seeders: ">=5" }), NOW).map((x) => x.name)).toEqual([
      "many",
    ]);
  });

  it(">0 drops dead torrents", () => {
    expect(applyFilters(list, f({ seeders: ">0" }), NOW).map((x) => x.name)).toEqual([
      "few",
      "many",
    ]);
  });
});

describe("composition", () => {
  it("applies date, size and seeders together", () => {
    const list = [
      r({ name: "keep", added: NOW - 10, sizeBytes: 2 * 1e9, seeders: 100 }),
      r({ name: "tooOld", added: NOW - 400 * 24 * 3600, sizeBytes: 2 * 1e9, seeders: 100 }),
      r({ name: "tooBig", added: NOW - 10, sizeBytes: 30 * 1e9, seeders: 100 }),
      r({ name: "tooFewSeeds", added: NOW - 10, sizeBytes: 2 * 1e9, seeders: 1 }),
    ];
    const out = applyFilters(
      list,
      f({ time: "year", size: "1-5GB", seeders: ">=5" }),
      NOW,
    );
    expect(out.map((x) => x.name)).toEqual(["keep"]);
  });
});

describe("cycle helpers", () => {
  it("each cycle advances one dimension and wraps", () => {
    let s = emptyFilters;
    expect(s.time).toBe(0);
    for (let i = 0; i < TIME_PRESETS.length; i++) s = cycleTime(s);
    expect(s.time).toBe(0); // wrapped back
    expect(cycleSize(emptyFilters).size).toBe(1);
    expect(cycleSeeders(emptyFilters).seeders).toBe(1);
    expect(cycleMatch(emptyFilters).match).toBe(1);
    expect(cycleMatch(cycleMatch(emptyFilters)).match).toBe(0);
  });

  it("cycling does not mutate the input", () => {
    const s = emptyFilters;
    cycleTime(s);
    cycleMatch(s);
    expect(s.time).toBe(0);
    expect(s.match).toBe(0);
  });
});

describe("match / hideTrash session state", () => {
  it("filtersFromConfig seeds strictAnd and hideTrash", () => {
    expect(filtersFromConfig()).toEqual(emptyFilters);
    expect(filtersFromConfig({ strictAnd: true, hideTrash: true })).toEqual({
      ...emptyFilters,
      match: 1,
      hideTrash: true,
    });
    // preferQuality does not affect filter state (ranker-only).
    expect(filtersFromConfig({ preferQuality: true })).toEqual(emptyFilters);
  });

  it("isEmptyFilters is false when match is strict or hideTrash is on", () => {
    expect(isEmptyFilters(f({ match: "strict" }))).toBe(false);
    expect(isEmptyFilters(f({ hideTrash: true }))).toBe(false);
  });

  it("applyFilters ignores match/hideTrash (time/size/seeders only)", () => {
    const list = [r({ name: "a" }), r({ name: "b" })];
    // Same array instance when only match/trash active — no time/size/seeders.
    expect(applyFilters(list, f({ match: "strict", hideTrash: true }), NOW)).toBe(
      list,
    );
  });
});

describe("helpers", () => {
  it("activeFilterCount counts non-any dimensions", () => {
    expect(activeFilterCount(emptyFilters)).toBe(0);
    expect(activeFilterCount(f({ time: "week", size: "1-5GB", seeders: ">=5" }))).toBe(3);
    expect(activeFilterCount(f({ seeders: ">0" }))).toBe(1);
    expect(activeFilterCount(f({ match: "strict", hideTrash: true }))).toBe(2);
  });

  it("filterSummary renders a compact label", () => {
    const summary = filterSummary(f({ time: "week", size: "1-5GB", seeders: ">=5" }));
    expect(summary).toBe("week \u00b7 1-5GB \u00b7 >=5");
    expect(filterSummary(emptyFilters)).toBe("");
    expect(filterSummary(f({ match: "strict", hideTrash: true }))).toBe(
      "match:strict \u00b7 no-trash",
    );
  });
});
