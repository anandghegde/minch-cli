# Discover Filters and Sort Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add client-side key-cycle sort and year/IMDb filters on every Discover feed without re-fetching.

**Architecture:** Extend `DiscoveryScreenState` with sort/year/min-rating/min-votes; extend `filterDiscoveryEntries` + add `sortDiscoveryEntries` in `aggregate.ts` (pure, ratings-map aware); wire keys and status chips in `Discover.tsx`. Default sort keeps existing `rankDiscoveryEntries` cascade.

**Tech Stack:** TypeScript, React/Ink, Vitest

**Spec:** `docs/superpowers/specs/2026-07-15-discover-filters-sort-design.md`

---

## File map

| File | Responsibility |
| --- | --- |
| `src/ui/discovery-state.ts` | Sort/year/IMDb state, cycle constants, reducer actions, reset |
| `src/discovery/aggregate.ts` | Year match, IMDb extract, filter extensions, `sortDiscoveryEntries` |
| `src/ui/components/Discover.tsx` | Build filters, apply sort, keys `o/y/i/v/x`, status chips, help |
| `test/discovery-screen-state.test.ts` | Reducer cycles + reset |
| `test/discovery/aggregate-filters.test.ts` | Year + IMDb threshold filters |
| `test/discovery/aggregate-ranking.test.ts` (or new `aggregate-sort.test.ts`) | Sort modes |
| `test/discover-content.test.tsx` | Only if existing tests break or key smoke is cheap |

No adapter, cache, Firecrawl, or config changes.

---

### Task 1: Screen state — sort / year / IMDb cycles + reset

**Files:**
- Modify: `src/ui/discovery-state.ts`
- Test: `test/discovery-screen-state.test.ts`

- [ ] **Step 1: Update failing expectations for initial state**

In `test/discovery-screen-state.test.ts`, change the initial-state assertion to include new defaults:

```ts
it("starts with every planned dimension represented", () => {
  expect(INITIAL_DISCOVERY_SCREEN_STATE).toEqual({
    feed: "trending",
    media: "all",
    dateWindow: "30d",
    sort: "default",
    yearFilter: "all",
    cursor: 0,
    detailsOpen: false,
  });
});
```

Add a new test for cycles and reset:

```ts
it("cycles sort, year, min IMDb rating/votes and resets them with filters", () => {
  const withFilters = reduce([
    { type: "set-feed", feed: "tamilmv" },
    { type: "set-sort", sort: "imdb_rating" },
    { type: "set-year-filter", yearFilter: "2020s" },
    { type: "set-min-imdb-rating", minImdbRating: 7 },
    { type: "set-min-imdb-votes", minImdbVotes: 1000 },
    { type: "set-language", languageCode: "ta" },
  ]);
  expect(withFilters).toMatchObject({
    feed: "tamilmv",
    sort: "imdb_rating",
    yearFilter: "2020s",
    minImdbRating: 7,
    minImdbVotes: 1000,
    languageCode: "ta",
    dateWindow: "all", // tamilmv feed still forces all
  });

  const reset = discoveryScreenReducer(withFilters, { type: "reset-filters" });
  expect(reset).toEqual({
    ...INITIAL_DISCOVERY_SCREEN_STATE,
    feed: "tamilmv",
  });
  expect(reset.minImdbRating).toBeUndefined();
  expect(reset.minImdbVotes).toBeUndefined();
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `npx vitest run test/discovery-screen-state.test.ts`

Expected: FAIL (missing `sort` / `yearFilter` on initial state, unknown action types)

- [ ] **Step 3: Implement state + reducer**

In `src/ui/discovery-state.ts`, add after the existing language constants:

```ts
export const DISCOVERY_SORT_MODES = [
  "default",
  "date_added",
  "release_date",
  "imdb_rating",
  "imdb_votes",
  "title",
] as const;
export type DiscoverySortMode = typeof DISCOVERY_SORT_MODES[number];

export const DISCOVERY_YEAR_FILTERS = [
  "all",
  "2020s",
  "2010s",
  "2000s",
  "1990s",
  "1980s",
  "pre-1980",
  "2026",
  "2025",
  "2024",
  "2023",
  "2022",
  "2021",
] as const;
export type DiscoveryYearFilter = typeof DISCOVERY_YEAR_FILTERS[number];

export const DISCOVERY_MIN_IMDB_RATINGS = [undefined, 6, 7, 7.5, 8] as const;
export type DiscoveryMinImdbRating = typeof DISCOVERY_MIN_IMDB_RATINGS[number];

export const DISCOVERY_MIN_IMDB_VOTES = [
  undefined,
  1000,
  5000,
  10000,
  50000,
] as const;
export type DiscoveryMinImdbVotes = typeof DISCOVERY_MIN_IMDB_VOTES[number];

export const DISCOVERY_SORT_LABELS: Record<DiscoverySortMode, string> = {
  default: "default",
  date_added: "date added",
  release_date: "release date",
  imdb_rating: "IMDb rating",
  imdb_votes: "IMDb votes",
  title: "title",
};

export const DISCOVERY_YEAR_FILTER_LABELS: Record<DiscoveryYearFilter, string> = {
  all: "All years",
  "2020s": "2020s",
  "2010s": "2010s",
  "2000s": "2000s",
  "1990s": "1990s",
  "1980s": "1980s",
  "pre-1980": "pre-1980",
  "2026": "2026",
  "2025": "2025",
  "2024": "2024",
  "2023": "2023",
  "2022": "2022",
  "2021": "2021",
};
```

Extend `DiscoveryScreenState`:

```ts
export interface DiscoveryScreenState {
  feed: DiscoveryFeed;
  media: DiscoveryMediaFilter;
  dateWindow: DiscoveryDateWindow;
  sort: DiscoverySortMode;
  yearFilter: DiscoveryYearFilter;
  minImdbRating?: number;
  minImdbVotes?: number;
  providerId?: string;
  languageCode?: string;
  formatLabel?: string;
  cursor: number;
  detailsOpen: boolean;
}
```

Extend actions:

```ts
  | { type: "set-sort"; sort: DiscoverySortMode }
  | { type: "set-year-filter"; yearFilter: DiscoveryYearFilter }
  | { type: "set-min-imdb-rating"; minImdbRating?: number }
  | { type: "set-min-imdb-votes"; minImdbVotes?: number }
```

Initial state:

```ts
export const INITIAL_DISCOVERY_SCREEN_STATE: DiscoveryScreenState = {
  feed: "trending",
  media: "all",
  dateWindow: "30d",
  sort: "default",
  yearFilter: "all",
  cursor: 0,
  detailsOpen: false,
};
```

In `discoveryScreenReducer`, add cases that use `resetSelection` (cursor 0, details closed):

```ts
    case "set-sort":
      return resetSelection(state, { sort: action.sort });
    case "set-year-filter":
      return resetSelection(state, { yearFilter: action.yearFilter });
    case "set-min-imdb-rating":
      return resetSelection(state, {
        ...(action.minImdbRating !== undefined
          ? { minImdbRating: action.minImdbRating }
          : { minImdbRating: undefined }),
      });
    case "set-min-imdb-votes":
      return resetSelection(state, {
        ...(action.minImdbVotes !== undefined
          ? { minImdbVotes: action.minImdbVotes }
          : { minImdbVotes: undefined }),
      });
```

Keep existing `reset-filters` as:

```ts
    case "reset-filters":
      return {
        ...INITIAL_DISCOVERY_SCREEN_STATE,
        feed: state.feed,
      };
```

(Optional helper for UI cycles — can live in Discover or here:)

```ts
export function cycleChoice<T>(values: readonly T[], current: T, delta = 1): T {
  const index = values.indexOf(current);
  const start = index < 0 ? 0 : index;
  return values[(start + delta + values.length) % values.length]!;
}
```

For rating/votes cycles, current may be `undefined`; `indexOf(undefined)` works on the const arrays above.

- [ ] **Step 4: Run tests — expect PASS**

Run: `npx vitest run test/discovery-screen-state.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/ui/discovery-state.ts test/discovery-screen-state.test.ts
git commit -m "feat(discover): add sort/year/IMDb screen state cycles"
```

---

### Task 2: Year filter helper + filterDiscoveryEntries year

**Files:**
- Modify: `src/discovery/aggregate.ts`
- Test: `test/discovery/aggregate-filters.test.ts`

- [ ] **Step 1: Write failing year-filter tests**

Append to `test/discovery/aggregate-filters.test.ts`:

```ts
import { matchesYearFilter } from "../../src/discovery/aggregate";

describe("discovery year filter", () => {
  it("matches decades, exact years, and pre-1980", () => {
    expect(matchesYearFilter(2024, "all")).toBe(true);
    expect(matchesYearFilter(undefined, "all")).toBe(true);
    expect(matchesYearFilter(2024, "2020s")).toBe(true);
    expect(matchesYearFilter(2019, "2020s")).toBe(false);
    expect(matchesYearFilter(1995, "1990s")).toBe(true);
    expect(matchesYearFilter(1979, "pre-1980")).toBe(true);
    expect(matchesYearFilter(1980, "pre-1980")).toBe(false);
    expect(matchesYearFilter(2025, "2025")).toBe(true);
    expect(matchesYearFilter(2024, "2025")).toBe(false);
  });

  it("excludes missing years when a year filter is active", () => {
    const withYear = { title: title("y2024", { year: 2024 }) };
    const noYear = { title: title("noyear", { year: undefined }) };
    expect(filterDiscoveryEntries([withYear, noYear], { yearFilter: "2020s" })
      .map((e) => e.title?.id)).toEqual(["y2024"]);
    expect(filterDiscoveryEntries([withYear, noYear], { yearFilter: "all" })
      .map((e) => e.title?.id)).toEqual(["y2024", "noyear"]);
    expect(filterDiscoveryEntries([withYear, noYear], {})
      .map((e) => e.title?.id)).toEqual(["y2024", "noyear"]);
  });
});
```

Note: `title()` helper spreads overrides over `year: 2026`; for `year: undefined`, use a helper that omits year:

```ts
function titleWithoutYear(id: string): CatalogTitle {
  const base = title(id);
  const { year: _y, ...rest } = base;
  return rest;
}
// use titleWithoutYear("noyear") instead of title("noyear", { year: undefined })
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `npx vitest run test/discovery/aggregate-filters.test.ts`

Expected: FAIL (`matchesYearFilter` not exported / `yearFilter` ignored)

- [ ] **Step 3: Implement year matching + filter branch**

In `src/discovery/aggregate.ts`, extend filters:

```ts
export interface DiscoveryFeedFilters {
  mediaTypes?: readonly MediaType[];
  providerIds?: readonly string[];
  date?: DiscoveryEventDateSelection;
  formatLabels?: readonly string[];
  languageCodes?: readonly string[];
  genreIds?: readonly number[];
  indianTitlesOnly?: boolean;
  /** Year cycle token; omit or `"all"` = no year constraint. */
  yearFilter?: string;
  minImdbRating?: number;
  minImdbVotes?: number;
}
```

Add:

```ts
export function matchesYearFilter(
  year: number | undefined,
  yearFilter: string | undefined,
): boolean {
  if (!yearFilter || yearFilter === "all") return true;
  if (year === undefined || !Number.isFinite(year)) return false;
  if (yearFilter === "pre-1980") return year < 1980;
  const decade = /^(\d{4})s$/.exec(yearFilter);
  if (decade) {
    const start = Number(decade[1]);
    return year >= start && year <= start + 9;
  }
  const exact = Number(yearFilter);
  if (Number.isInteger(exact)) return year === exact;
  return true;
}
```

Inside `filterDiscoveryEntries`, after existing checks, before `return true`:

```ts
    if (!matchesYearFilter(entry.title?.year, filters.yearFilter)) return false;
```

(Do not implement min IMDb yet — Task 3.)

- [ ] **Step 4: Run tests — expect PASS**

Run: `npx vitest run test/discovery/aggregate-filters.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/discovery/aggregate.ts test/discovery/aggregate-filters.test.ts
git commit -m "feat(discover): filter discovery entries by catalog year"
```

---

### Task 3: IMDb rating/votes filters

**Files:**
- Modify: `src/discovery/aggregate.ts`
- Test: `test/discovery/aggregate-filters.test.ts`

- [ ] **Step 1: Write failing IMDb filter tests**

```ts
import type { CatalogRating } from "../../src/discovery/types";
import {
  entryImdbRating,
  filterDiscoveryEntries,
} from "../../src/discovery/aggregate";

function imdb(value: number, voteCount?: number): CatalogRating {
  return {
    system: "imdb",
    provider: "imdb-dataset",
    value,
    scale: 10,
    ...(voteCount !== undefined ? { voteCount } : {}),
    observedAt: 1,
  };
}

describe("discovery IMDb threshold filters", () => {
  it("prefers ratings map over title.ratings and ignores non-IMDb systems for thresholds", () => {
    const entry: DiscoveryFeedEntry = {
      title: title("t1", {
        ratings: [imdb(5, 100)],
      }),
    };
    const map = new Map<string, CatalogRating[]>([
      ["t1", [imdb(8.2, 12_000)]],
    ]);
    expect(entryImdbRating(entry, map)?.value).toBe(8.2);
    expect(entryImdbRating(entry, new Map())?.value).toBe(5);

    const tmdbOnly: DiscoveryFeedEntry = {
      title: title("tmdb", {
        ratings: [{
          system: "tmdb",
          provider: "tmdb",
          value: 90,
          scale: 100,
          voteCount: 99999,
          observedAt: 1,
        }],
      }),
    };
    expect(entryImdbRating(tmdbOnly, new Map())).toBeUndefined();
  });

  it("excludes rows below min rating or votes and rows missing IMDb when thresholds active", () => {
    const high = {
      title: title("high", { ratings: [imdb(8.1, 20_000)] }),
    };
    const mid = {
      title: title("mid", { ratings: [imdb(6.5, 2_000)] }),
    };
    const lowVotes = {
      title: title("lowv", { ratings: [imdb(9.0, 100)] }),
    };
    const none = { title: title("none") };
    const rows = [high, mid, lowVotes, none];
    const emptyMap = new Map<string, CatalogRating[]>();

    expect(filterDiscoveryEntries(rows, { minImdbRating: 7 }, emptyMap)
      .map((e) => e.title?.id)).toEqual(["high", "lowv"]);
    expect(filterDiscoveryEntries(rows, { minImdbVotes: 1000 }, emptyMap)
      .map((e) => e.title?.id)).toEqual(["high", "mid"]);
    expect(filterDiscoveryEntries(rows, {
      minImdbRating: 7,
      minImdbVotes: 1000,
    }, emptyMap).map((e) => e.title?.id)).toEqual(["high"]);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `npx vitest run test/discovery/aggregate-filters.test.ts`

Expected: FAIL (`entryImdbRating` missing; thresholds ignored)

- [ ] **Step 3: Implement entryImdbRating + filter signature**

Import at top of `aggregate.ts`:

```ts
import type { CatalogRating } from "./types";
import { formatRatingValue, selectPreferredRating } from "./ratings/types";
```

(`CatalogRating` may already be reachable via types import — merge into existing type import.)

```ts
export type DiscoveryRatingsMap = ReadonlyMap<string, readonly CatalogRating[]>;

/** IMDb-only rating for filters/sorts; map wins over title.ratings. */
export function entryImdbRating(
  entry: DiscoveryFeedEntry,
  ratingsByTitleId: DiscoveryRatingsMap = new Map(),
): CatalogRating | undefined {
  const titleId = entry.title?.id;
  const fromMap = titleId ? ratingsByTitleId.get(titleId) : undefined;
  const pool = [
    ...(fromMap ?? []),
    ...(entry.title?.ratings ?? []),
  ].filter((rating) => rating.system === "imdb");
  return selectPreferredRating(pool);
}

export function filterDiscoveryEntries(
  entries: readonly DiscoveryFeedEntry[],
  filters: DiscoveryFeedFilters,
  ratingsByTitleId: DiscoveryRatingsMap = new Map(),
): DiscoveryFeedEntry[] {
  // ... existing setup ...
  return entries.filter((entry) => {
    // ... existing checks including year ...
    if (filters.minImdbRating !== undefined || filters.minImdbVotes !== undefined) {
      const rating = entryImdbRating(entry, ratingsByTitleId);
      if (!rating) return false;
      const score = formatRatingValue(rating);
      if (
        filters.minImdbRating !== undefined &&
        score < filters.minImdbRating
      ) {
        return false;
      }
      if (filters.minImdbVotes !== undefined) {
        if (rating.voteCount === undefined || rating.voteCount < filters.minImdbVotes) {
          return false;
        }
      }
    }
    return true;
  });
}
```

Keep third parameter optional so all existing call sites stay valid.

- [ ] **Step 4: Run tests — expect PASS**

Run: `npx vitest run test/discovery/aggregate-filters.test.ts test/discovery/india-matrix.test.ts test/discovery/aggregate-golden.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/discovery/aggregate.ts test/discovery/aggregate-filters.test.ts
git commit -m "feat(discover): filter discovery entries by min IMDb rating and votes"
```

---

### Task 4: sortDiscoveryEntries

**Files:**
- Modify: `src/discovery/aggregate.ts`
- Create or modify: `test/discovery/aggregate-sort.test.ts` (prefer new file to keep ranking tests focused)

- [ ] **Step 1: Write failing sort tests**

Create `test/discovery/aggregate-sort.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  sortDiscoveryEntries,
  type DiscoveryFeedEntry,
} from "../../src/discovery/aggregate";
import type { CatalogRating, CatalogTitle, ReleaseEvent } from "../../src/discovery/types";

function title(id: string, overrides: Partial<CatalogTitle> = {}): CatalogTitle {
  return {
    id,
    title: id,
    mediaType: "movie",
    originCountries: [],
    genreIds: [],
    ...overrides,
  };
}

function event(id: string, titleId: string, overrides: Partial<ReleaseEvent> = {}): ReleaseEvent {
  return {
    id,
    titleId,
    kind: "streaming_added",
    region: "IN",
    datePrecision: "day",
    status: "past",
    firstObservedAt: 1,
    lastObservedAt: 1,
    evidence: [{ source: "tamilmv", observedAt: 1, confidence: "source_claim" }],
    ...overrides,
  };
}

function imdb(value: number, votes?: number): CatalogRating {
  return {
    system: "imdb",
    provider: "imdb-dataset",
    value,
    scale: 10,
    ...(votes !== undefined ? { voteCount: votes } : {}),
    observedAt: 1,
  };
}

describe("sortDiscoveryEntries", () => {
  it("sorts by date_added using max observed timestamps desc, missing last", () => {
    const a: DiscoveryFeedEntry = {
      title: title("a"),
      event: event("ea", "a", { firstObservedAt: 10, lastObservedAt: 100 }),
    };
    const b: DiscoveryFeedEntry = {
      title: title("b"),
      event: event("eb", "b", { firstObservedAt: 50, lastObservedAt: 50 }),
    };
    const c: DiscoveryFeedEntry = { title: title("c") }; // no event
    const ordered = sortDiscoveryEntries([c, b, a], "date_added", { direction: "past" });
    expect(ordered.map((e) => e.title?.id)).toEqual(["a", "b", "c"]);
  });

  it("sorts by release_date desc and puts undated last", () => {
    const older: DiscoveryFeedEntry = {
      title: title("older"),
      event: event("e1", "older", { date: "2020-01-01" }),
    };
    const newer: DiscoveryFeedEntry = {
      title: title("newer"),
      event: event("e2", "newer", { date: "2024-06-01" }),
    };
    const undated: DiscoveryFeedEntry = {
      title: title("undated"),
      event: event("e3", "undated", { date: undefined, datePrecision: "unknown", status: "unknown" }),
    };
    const ordered = sortDiscoveryEntries(
      [older, undated, newer],
      "release_date",
      { direction: "past" },
    );
    expect(ordered.map((e) => e.title?.id)).toEqual(["newer", "older", "undated"]);
  });

  it("sorts by imdb_rating and imdb_votes with missing last", () => {
    const high: DiscoveryFeedEntry = {
      title: title("high", { ratings: [imdb(8.5, 1000)] }),
    };
    const mid: DiscoveryFeedEntry = {
      title: title("mid", { ratings: [imdb(7.0, 50_000)] }),
    };
    const none: DiscoveryFeedEntry = { title: title("none") };
    expect(sortDiscoveryEntries([none, mid, high], "imdb_rating", { direction: "past" })
      .map((e) => e.title?.id)).toEqual(["high", "mid", "none"]);
    expect(sortDiscoveryEntries([none, mid, high], "imdb_votes", { direction: "past" })
      .map((e) => e.title?.id)).toEqual(["mid", "high", "none"]);
  });

  it("sorts by title A-Z and delegates default to rankDiscoveryEntries", () => {
    const z: DiscoveryFeedEntry = {
      title: title("z", { title: "Zebra" }),
      event: event("ez", "z", { date: "2020-01-01" }),
    };
    const a: DiscoveryFeedEntry = {
      title: title("a", { title: "Alpha" }),
      event: event("ea", "a", { date: "2010-01-01" }),
    };
    expect(sortDiscoveryEntries([z, a], "title", { direction: "past" })
      .map((e) => e.title?.title)).toEqual(["Alpha", "Zebra"]);
    // default: newer date first
    expect(sortDiscoveryEntries([z, a], "default", { direction: "past" })
      .map((e) => e.title?.id)).toEqual(["z", "a"]);
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `npx vitest run test/discovery/aggregate-sort.test.ts`

Expected: FAIL (`sortDiscoveryEntries` not exported)

- [ ] **Step 3: Implement sortDiscoveryEntries**

In `src/discovery/aggregate.ts`:

```ts
export type DiscoverySortMode =
  | "default"
  | "date_added"
  | "release_date"
  | "imdb_rating"
  | "imdb_votes"
  | "title";

function observedAt(entry: DiscoveryFeedEntry): number | undefined {
  const event = entry.event;
  if (!event) return undefined;
  return Math.max(event.lastObservedAt ?? 0, event.firstObservedAt ?? 0) || undefined;
}

function cmpMissingLast(
  left: number | string | undefined,
  right: number | string | undefined,
  dir: "asc" | "desc",
): number | undefined {
  const leftMissing = left === undefined || left === "";
  const rightMissing = right === undefined || right === "";
  if (leftMissing && rightMissing) return 0;
  if (leftMissing) return 1;
  if (rightMissing) return -1;
  if (left === right) return 0;
  if (typeof left === "number" && typeof right === "number") {
    return dir === "desc" ? right - left : left - right;
  }
  const text = String(left).localeCompare(String(right));
  return dir === "desc" ? -text : text;
}

export function sortDiscoveryEntries(
  entries: readonly DiscoveryFeedEntry[],
  mode: DiscoverySortMode,
  ranking: DiscoveryRankingOptions,
  ratingsByTitleId: DiscoveryRatingsMap = new Map(),
): DiscoveryFeedEntry[] {
  if (mode === "default") {
    return rankDiscoveryEntries(entries, ranking);
  }

  return [...entries].sort((left, right) => {
    if (mode === "date_added") {
      const primary = cmpMissingLast(observedAt(left), observedAt(right), "desc");
      if (primary) return primary;
    } else if (mode === "release_date") {
      const primary = cmpMissingLast(left.event?.date, right.event?.date, "desc");
      if (primary) return primary;
    } else if (mode === "imdb_rating") {
      const leftR = entryImdbRating(left, ratingsByTitleId);
      const rightR = entryImdbRating(right, ratingsByTitleId);
      const primary = cmpMissingLast(
        leftR ? formatRatingValue(leftR) : undefined,
        rightR ? formatRatingValue(rightR) : undefined,
        "desc",
      );
      if (primary) return primary;
      const votes = cmpMissingLast(leftR?.voteCount, rightR?.voteCount, "desc");
      if (votes) return votes;
    } else if (mode === "imdb_votes") {
      const leftR = entryImdbRating(left, ratingsByTitleId);
      const rightR = entryImdbRating(right, ratingsByTitleId);
      const primary = cmpMissingLast(leftR?.voteCount, rightR?.voteCount, "desc");
      if (primary) return primary;
      const rating = cmpMissingLast(
        leftR ? formatRatingValue(leftR) : undefined,
        rightR ? formatRatingValue(rightR) : undefined,
        "desc",
      );
      if (rating) return rating;
    } else if (mode === "title") {
      const primary = cmpMissingLast(left.title?.title, right.title?.title, "asc");
      if (primary) return primary;
      const year = cmpMissingLast(left.title?.year, right.title?.year, "asc");
      if (year) return year;
    }

    const titleCmp = (left.title?.title ?? "").localeCompare(right.title?.title ?? "");
    if (titleCmp !== 0) return titleCmp;
    return stableEntryId(left).localeCompare(stableEntryId(right));
  });
}
```

Fix `cmpMissingLast` carefully: when values equal, return `0` (falsy) so callers use `if (primary !== undefined && primary !== 0)` or return `number` and check `!== 0`:

Prefer:

```ts
function cmpMissingLast(...): number {
  // always return a number; 0 means equal
}
// callers: const primary = cmpMissingLast(...); if (primary !== 0) return primary;
```

- [ ] **Step 4: Run tests — expect PASS**

Run: `npx vitest run test/discovery/aggregate-sort.test.ts test/discovery/aggregate-ranking.test.ts`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/discovery/aggregate.ts test/discovery/aggregate-sort.test.ts
git commit -m "feat(discover): add manual discovery sort modes"
```

---

### Task 5: Wire Discover UI — filters, sort, keys, chips, help

**Files:**
- Modify: `src/ui/components/Discover.tsx`
- Test: re-run `test/discover-content.test.tsx` if present; fix breakages only

- [ ] **Step 1: Update entry selection pipeline**

In `DiscoveryContent`, replace `selectDiscoveryEntries` usage with filter + sort:

```ts
import {
  filterDiscoveryEntries,
  sortDiscoveryEntries,
  type DiscoveryFeedEntry,
  type DiscoveryFeedFilters,
} from "../../discovery/aggregate";
import {
  DISCOVERY_DATE_WINDOWS,
  DISCOVERY_DATE_WINDOW_LABELS,
  DISCOVERY_FEEDS,
  DISCOVERY_LANGUAGE_FILTERS,
  DISCOVERY_MEDIA_FILTERS,
  DISCOVERY_MIN_IMDB_RATINGS,
  DISCOVERY_MIN_IMDB_VOTES,
  DISCOVERY_SORT_LABELS,
  DISCOVERY_SORT_MODES,
  DISCOVERY_YEAR_FILTER_LABELS,
  DISCOVERY_YEAR_FILTERS,
  cycleChoice, // if exported; else reuse local cycle()
  useDiscoveryScreenState,
  // ...
} from "../discovery-state";
```

Build filters:

```ts
  const filters: DiscoveryFeedFilters = {
    ...(screen.media === "all" ? {} : { mediaTypes: [screen.media] }),
    ...(screen.feed === "trending" ||
      screen.feed === "popular" ||
      screen.feed === "charts" ||
      screen.feed === "community" ||
      screen.feed === "tamilmv"
      ? {}
      : { date }),
    ...(screen.providerId &&
      (screen.feed === "ott" || screen.feed === "popular" || screen.feed === "charts")
      ? { providerIds: [screen.providerId] }
      : {}),
    ...(screen.languageCode ? { languageCodes: [screen.languageCode] } : {}),
    ...(screen.formatLabel ? { formatLabels: [screen.formatLabel] } : {}),
    ...(screen.yearFilter !== "all" ? { yearFilter: screen.yearFilter } : {}),
    ...(screen.minImdbRating !== undefined
      ? { minImdbRating: screen.minImdbRating }
      : {}),
    ...(screen.minImdbVotes !== undefined
      ? { minImdbVotes: screen.minImdbVotes }
      : {}),
  };

  const entries = useMemo(() => {
    const filtered = filterDiscoveryEntries(
      model.aggregation.feeds[screen.feed],
      filters,
      model.ratings,
    );
    const ordered = sortDiscoveryEntries(
      filtered,
      screen.sort,
      { direction: date.direction },
      model.ratings,
    );
    return screen.feed === "bluray" ? dedupeBlurayEntries(ordered) : ordered;
  }, [
    date.direction,
    filters,
    model.aggregation.feeds,
    model.ratings,
    screen.feed,
    screen.sort,
  ]);
```

Confirm `model.ratings` type is `Map<string, CatalogRating[]>` (or compatible). If it is a different structure, adapt with a thin adapter in the component.

- [ ] **Step 2: Wire keys**

In `useInput`, after language handling, add:

```ts
    if (input === "o") {
      dispatch({
        type: "set-sort",
        sort: cycle(DISCOVERY_SORT_MODES, screen.sort, 1),
      });
      return;
    }
    if (input === "y") {
      dispatch({
        type: "set-year-filter",
        yearFilter: cycle(DISCOVERY_YEAR_FILTERS, screen.yearFilter, 1),
      });
      return;
    }
    if (input === "i") {
      const current = Math.max(
        0,
        DISCOVERY_MIN_IMDB_RATINGS.findIndex((v) => v === screen.minImdbRating),
      );
      const next = DISCOVERY_MIN_IMDB_RATINGS[
        (current + 1) % DISCOVERY_MIN_IMDB_RATINGS.length
      ];
      dispatch({ type: "set-min-imdb-rating", minImdbRating: next });
      return;
    }
    if (input === "v") {
      const current = Math.max(
        0,
        DISCOVERY_MIN_IMDB_VOTES.findIndex((v) => v === screen.minImdbVotes),
      );
      const next = DISCOVERY_MIN_IMDB_VOTES[
        (current + 1) % DISCOVERY_MIN_IMDB_VOTES.length
      ];
      dispatch({ type: "set-min-imdb-votes", minImdbVotes: next });
      return;
    }
    if (input === "x") {
      dispatch({ type: "reset-filters" });
      return;
    }
```

Update the action logging ternary chain to include `o/y/i/v/x` labels (`sort.next`, `year.next`, `rating.next`, `votes.next`, `filters.reset`).

Note: local `cycle` is typed as `readonly string[]` — `DISCOVERY_SORT_MODES` is fine. For `undefined` rating ladders, use `findIndex` as above (do not use string `cycle`).

- [ ] **Step 3: Status chips + help**

Replace the dim status line that currently shows media/window/provider/language with chips including new fields:

```ts
        <Text color={COLOR.dim}>
          {[
            MEDIA_LABELS[screen.media],
            ...(screen.feed === "trending" ||
              screen.feed === "popular" ||
              screen.feed === "charts" ||
              screen.feed === "community" ||
              screen.feed === "tamilmv"
              ? []
              : [DISCOVERY_DATE_WINDOW_LABELS[screen.dateWindow]]),
            ...(screen.feed === "ott" ||
              screen.feed === "popular" ||
              screen.feed === "charts"
              ? [providerLabel]
              : []),
            ...(screen.languageCode ? [languageChoice.label] : []),
            ...(screen.yearFilter !== "all"
              ? [DISCOVERY_YEAR_FILTER_LABELS[screen.yearFilter]]
              : []),
            ...(screen.minImdbRating !== undefined
              ? [`IMDb ${screen.minImdbRating.toFixed(1)}+`]
              : []),
            ...(screen.minImdbVotes !== undefined
              ? [`${formatVoteCount(screen.minImdbVotes)}+ votes`]
              : []),
            ...(screen.sort !== "default"
              ? [`sort: ${DISCOVERY_SORT_LABELS[screen.sort]}`]
              : []),
          ].join(" · ")}
        </Text>
```

Help row (top right or existing dim line):

```ts
        <Text color={COLOR.dim}>
          ←→ feed · m type · o sort · y year · i rating · v votes · x reset · r refresh
        </Text>
```

Truncate or shorten on narrow `cols` if the line wraps badly (e.g. when `cols < 90`, drop middle segments or use a shorter string `o/y/i/v/x`).

- [ ] **Step 4: Run UI + unit tests**

Run:

```bash
npx vitest run test/discovery-screen-state.test.ts \
  test/discovery/aggregate-filters.test.ts \
  test/discovery/aggregate-sort.test.ts \
  test/discovery/aggregate-ranking.test.ts \
  test/discover-content.test.tsx
```

Expected: PASS (fix `discover-content` if it asserts exact help text or initial state shape)

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/Discover.tsx test/discover-content.test.tsx
git commit -m "feat(discover): wire sort and year/IMDb filter keys in UI"
```

---

### Task 6: Full verification

**Files:** none (verify only)

- [ ] **Step 1: Run discovery + discover UI suite**

```bash
npx vitest run test/discovery test/discovery-screen-state.test.ts test/discover-content.test.tsx
```

Expected: all PASS

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

Expected: no errors

- [ ] **Step 3: Manual smoke checklist (human or interactive TUI)**

1. Open Discover → TamilMV: `y` cycles years; list shrinks; `x` restores.
2. `i` / `v` hide NR / low-vote rows when ratings loaded.
3. `o` through sort modes; order changes; default restores feed rank feel.
4. OTT: `m` + `l` + `y` + `o` still work; `t` still changes window.
5. Charts: `#n` is post-filter index.

- [ ] **Step 4: Final commit only if verification fixes landed**

```bash
git add -A  # only files from this feature
git commit -m "test(discover): finish filters/sort verification fixes"
```

(Skip empty commit if already green.)

---

## Spec coverage checklist

| Spec requirement | Task |
| --- | --- |
| Sort modes (default, date_added, release_date, imdb_rating, imdb_votes, title) | 4, 5 |
| Year decades + recent years | 1, 2, 5 |
| Min IMDb rating / votes ladders | 1, 3, 5 |
| Keys `o/y/i/v/x` | 1, 5 |
| Missing metadata excluded under active filters | 2, 3 |
| Missing sort keys last | 4 |
| All feeds, client-side only | 5 (no adapter changes) |
| Status chips + help | 5 |
| Pure unit tests | 1–4 |
| `reset-filters` keeps feed | 1 |
| Blu-ray dedupe after select | 5 |
| Charts rank after filter/sort | 5 (index from filtered list) |

## Self-review notes

- No TBD placeholders in steps.
- `filterDiscoveryEntries` third arg is optional — existing tests unchanged.
- UI cycle for `undefined` rating/votes uses `findIndex`, not string `cycle`.
- `DiscoverySortMode` is defined in both UI state and aggregate — either re-export one type from aggregate and import in discovery-state, **or** keep string unions identical. Prefer defining the union once in `aggregate.ts` and importing into `discovery-state.ts` for the sort field type to avoid drift; year filter tokens can stay UI-only constants with string passed to `yearFilter`.
