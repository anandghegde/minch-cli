# Discover feed filters and sort

- Status: Approved for implementation
- Date: 2026-07-15
- Scope: Client-side sort and extended filters for **all** Discover subtabs

## Summary

Add extensive **key-cycle** sort and filter controls on every Discover feed (`trending`, `ott`, `bluray`, `popular`, `charts`, `community`, `tamilmv`). Controls apply only to already-loaded/cached rows — no adapter re-fetch. Especially useful on TamilMV (large, mixed-language, often undated listings) but the same surface ships on all subtabs.

## Goals

1. Manual sort: default feed rank, date added, release date, IMDb rating, IMDb votes, title A–Z.
2. Filters: existing media/language/provider/date-window plus **catalog year**, **min IMDb rating**, **min IMDb votes**.
3. Year cycle: decades first, then recent individual years.
4. One consistent key-cycle UX across all Discover feeds (match Search’s cycle style).
5. Pure filter/sort helpers unit-tested without Ink; no new network/quota cost.

## Non-goals

- Filter panel / modal UI
- Server-side or re-fetch filters (TMDB discover params, etc.)
- Genre multi-filter, multi-select languages
- Persisting Discover filter prefs to `config.json`
- Changing TamilMV scrape coverage or rating enrichment pipelines
- Replacing `r` (refresh) with filter reset

## Product decisions (locked)

| Decision | Choice |
| --- | --- |
| Interaction | Single-key cycles (not a panel) |
| Year ladder | All → decades → recent years (2026…2021) |
| IMDb rating ladder | Any → 6.0+ → 7.0+ → 7.5+ → 8.0+ |
| IMDb votes ladder | Any → 1K+ → 5K+ → 10K+ → 50K+ |
| Sort ladder | Default → date added → release date → IMDb rating → IMDb votes → title |
| Missing metadata under threshold | **Exclude** the row |
| Approach | Extend existing Discover filter path + small pure helpers |

## Product behavior

### Keys

| Key | Action | Notes |
| --- | --- | --- |
| `o` | Cycle sort mode | All feeds |
| `y` | Cycle year filter | All feeds |
| `i` | Cycle min IMDb rating | All feeds |
| `v` | Cycle min IMDb votes | All feeds |
| `x` | Reset filters + sort for current feed | Keeps current feed; does not refresh |
| `m` | Media type | Unchanged |
| `l` | Language | Unchanged |
| `p` | Provider | Unchanged (OTT / popular / charts only) |
| `t` | Date window | Unchanged (still disabled on trending, popular, charts, community, tamilmv) |
| `r` | Refresh | Unchanged |
| `s` | Search handoff | Unchanged |

### Status line

Show active chips only, for example:

```
Movies · Tamil · 2020s · IMDb 7.0+ · 1K+ votes · sort: rating
```

Footer help (list view): extend the dim help row with `o sort · y year · i rating · v votes · x reset` (truncate on narrow terminals as needed).

### Year cycle order

```
all → 2020s → 2010s → 2000s → 1990s → 1980s → pre-1980
    → 2026 → 2025 → 2024 → 2023 → 2022 → 2021 → all
```

| Token | Match on `title.year` |
| --- | --- |
| `all` | No year constraint |
| `2020s` | 2020–2029 (same pattern for 2010s…1980s) |
| `pre-1980` | year &lt; 1980 |
| `2026`…`2021` | Exact year |

When year filter ≠ `all`, rows with missing `title.year` are **excluded**.

### IMDb rating / votes

- Prefer IMDb ratings from `model.ratings.get(titleId)` then `title.ratings`.
- Use preferred IMDb entry (system `imdb`); if none, treat as **missing** for IMDb-specific filters and sorts (TMDB/aggregate alone does not satisfy min-IMDb thresholds).
- Normalize to a 0–10 scale when comparing rating floors.
- When a min rating or min votes threshold is active, rows without a usable IMDb value / vote count are **excluded**.

### Sort modes

| Mode | Primary key | Direction | Missing values |
| --- | --- | --- | --- |
| `default` | Existing `rankDiscoveryEntries` (event date → confidence → popularity) | feed direction | as today |
| `date_added` | `max(event.lastObservedAt, event.firstObservedAt)` | desc | last |
| `release_date` | `event.date` (YYYY-MM-DD) | desc | last |
| `imdb_rating` | IMDb value (0–10) | desc | last |
| `imdb_votes` | IMDb `voteCount` | desc | last |
| `title` | `title.title` localeCompare | asc | last |

Tie-breakers (after primary):

- `imdb_rating`: votes desc, then title, then stable id
- `imdb_votes`: rating desc, then title, then stable id
- `date_added` / `release_date`: title, then stable id
- `title`: year, then stable id

Pipeline: **hard filters → sort**. Blu-ray title dedupe remains after selection (unchanged).

### Per-feed notes

| Feed | Notes |
| --- | --- |
| All | Same keys; status chips always reflect active state |
| tamilmv | Date window remains N/A; **date added** uses observation timestamps; release dates often empty — year + IMDb filters/sorts are the main levers |
| charts / community | Rank/`#n` column remains list index **after** filter/sort |
| ott / bluray | `t` date window remains the load-time event window; year filter is **catalog year**, not the event window |

### Empty state

When base feed has rows but filters remove all of them, keep existing empty reason `"filters"` (user can press `x` to reset).

## Architecture

```
Discover keys → discoveryScreenReducer
  → DiscoveryScreenState { sort, yearFilter, minImdbRating, minImdbVotes, … }
  → build DiscoveryFeedFilters (+ year / imdb thresholds)
  → filterDiscoveryEntries (media, language, provider, date, year, imdb…)
  → rankDiscoveryEntries | sortDiscoveryEntries(mode)
  → optional bluray dedupe
  → list + status chips
```

### State extensions (`src/ui/discovery-state.ts`)

```ts
sort: "default" | "date_added" | "release_date" | "imdb_rating" | "imdb_votes" | "title"
yearFilter: "all" | "2020s" | "2010s" | "2000s" | "1990s" | "1980s" | "pre-1980"
  | "2026" | "2025" | "2024" | "2023" | "2022" | "2021"
minImdbRating?: 6 | 7 | 7.5 | 8
minImdbVotes?: 1000 | 5000 | 10000 | 50000
```

Actions: `set-sort`, `set-year-filter`, `set-min-imdb-rating`, `set-min-imdb-votes`, and `reset-filters` clears sort/year/rating/votes (and existing media/language/provider/format/date defaults) while **keeping** `feed`.

### Domain filter/sort

Extend `DiscoveryFeedFilters` with:

- `yearFilter?: string` — tokens from the year cycle (`all` omitted / treated as no-op)
- `minImdbRating?: number` — floor on 0–10 scale
- `minImdbVotes?: number`

Add pure helpers (React-free):

- `matchesYearFilter(year, yearFilter)`
- `entryImdbRating(entry, ratingsMap)` — IMDb-only; undefined if missing
- `filterDiscoveryEntries` — also apply year + min IMDb rating/votes when set (ratings map required for IMDb fields)
- `sortDiscoveryEntries(entries, mode, ratingsMap, rankingOptions)` — `default` delegates to `rankDiscoveryEntries`

Composition in `DiscoveryContent`:

```ts
const filtered = filterDiscoveryEntries(base, filters, ratingsMap);
const ordered = sortDiscoveryEntries(filtered, screen.sort, ratingsMap, { direction });
```

Existing `selectDiscoveryEntries` keeps working for callers that only need default rank after hard filters; Discover may call filter + sort explicitly so the ratings map is in scope.

### UI (`src/ui/components/Discover.tsx`)

- Wire `o` / `y` / `i` / `v` / `x` in `useInput`
- Build filters from screen state; apply sort mode after filter
- Status line chips for active non-default filters and non-default sort
- Help text update

No adapter, cache, or Firecrawl changes.

## Testing

| Area | Cases |
| --- | --- |
| Year | decade bounds, exact year, pre-1980, missing year excluded when active |
| Min rating | 6/7/7.5/8 floors; missing IMDb excluded; non-IMDb-only rows excluded |
| Min votes | 1K/5K/10K/50K; missing votes excluded |
| Sort | each mode ordering; missing last; stable ties |
| Reducer | cycle wrap-around; `reset-filters` keeps feed and clears new fields |
| Optional UI | key mapping smoke if existing Discover tests cover input |

Existing aggregate/select tests remain green; extend rather than rewrite default ranking behavior.

## Implementation sketch (for planning)

1. Add year / rating / votes / sort constants and reducer actions in `discovery-state.ts`.
2. Implement pure year match + IMDb extract + filter extensions + `sortDiscoveryEntries`.
3. Wire `DiscoveryContent` filters, sort, keys, status line, help.
4. Unit tests for pure helpers and reducer; fix any Discover UI tests.
5. Manual smoke: TamilMV + charts with rating/year/sort combos.

## Open questions

None — product and approach approved 2026-07-15.
