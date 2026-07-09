# Search Relevancy Improvement Plan

**Goal:** When a user types a keyword search in minch, the *most relevant* torrents should appear at the top of the list — not merely the ones with the most seeders or the noisiest public-indexer dump.

**Status of prior work:** Phase 1 (token AND/partial tiers + `logSeeders`) and Phase 2 (release-name quality parser + opt-in `quality` sort) from `better-search-relevancy.md` are **already implemented**. This document audits that baseline, compares it to ≥12 peer open-source projects, and proposes the next rounds of work needed to actually *feel* relevant for real queries.

---

## 1. Current state audit

### 1.1 Pipeline today

```
query ──► fanout (N sources) ──► dedupe(infoHash | name+size)
                │
                ▼
        rankResults(query)          # useSourceFanout.ts on every partial settle
                │
                ▼
        applyFilters(t/z/x)         # Results.tsx
                │
                ▼
        rankResults again (default) # or sortResults(field) if user hit `s`
                │                   # sort chip label: "relevance"
                ▼
             TUI list
```

| Layer | File | Role |
| --- | --- | --- |
| Tokenize + score | `src/sources/relevance.ts` | `tokenize`, `matchScore`, `logSeeders`, `rankResults` |
| Quality parse/sort | `src/sources/releasename.ts` | `parseReleaseName`, `qualityRank` |
| Dedupe / manual sorts | `src/sources/search.ts` | `dedupe`, `defaultOrder`, `sortResults`, `SORT_CYCLE` |
| Filters | `src/sources/filters.ts` | date / size / min-seeders cycles |
| Fanout | `src/ui/hooks/useSourceFanout.ts` | streams + ranks on each source settle |
| Display | `src/ui/components/Results.tsx` | filter → rank/sort |

### 1.2 What the default ranker actually does

`rankResults(list, query)`:

1. **Tokenize** query: lowercase, strip apostrophes (`Zoey's` ≡ `Zoeys`), dashes → separators, split on non-letters/digits, drop stop words `{a,an,and,of,the}` and 1-char tokens.
2. **`matchScore(name, tokens)`** → `{ tier, score }`
   - **tier 2** = every query token present in the name (full AND)
   - **tier 1** = some tokens
   - **tier 0** = none (sunk, **not** removed)
   - Token match = exact equality **or** name-token prefix of query token when query token length ≥ 3
   - `score = coverage×100 + contiguousRun×20 + leadingBonus×15 + snr×10`
3. Sort key cascade:
   1. tier ↓
   2. score ↓
   3. `logSeeders = round(log10(max(1, seeders)))` ↓  *(Sonarr-style buckets)*
   4. `added` ↓
4. Empty / stop-only query → seeders then recency (trending/browse keep `defaultOrder`).

Opt-in via `s`: seeders · quality · size · date · source.

### 1.3 What already works well

- Full-AND titles beat high-seeder garbage (tested).
- Prefix match helps multi-word titles (`spider` → `spider` in `Spider-Man`).
- Contiguous / leading / SNR penalties reduce tag-stuffed noise somewhat.
- Quality sort exists without polluting the default path.
- Pure modules + solid unit tests (`test/relevance.test.ts`, `test/releasename.test.ts`).
- No runtime deps for ranking — fits minch’s zero-config ethos.

### 1.4 Where relevancy still fails (user-visible)

These are the failure modes a thorough review still hits against real public-indexer output:

| # | Failure | Example |
| --- | --- | --- |
| F1 | **Partial-token luck** | Query `matrix reloaded` → `The Matrix Revolutions` is only tier 1, good — but `The Matrix 1999` and `The Matrix Reloaded` both tier-2 after stop-words if user types `the matrix`; year is unused as a *preference*. |
| F2 | **Year is just another token** | `dune 2021` ranks any name containing both tokens, but a 2024 remaster that only says `Dune.Part.Two.2024` loses hard; a pack named `Dune.Collection.2021.1080p` can beat the actual 2021 film if seeders are higher *within the same tier/score band*. |
| F3 | **No title-vs-tags separation** | Scene names bury the title in tags (`Movie.2020.1080p.BluRay.x264.DTS-HD.MA.5.1-GROUP`). SNR helps, but we never score *parsed title* vs *query* (Levenshtein / token-F1 on stripped title). |
| F4 | **No trash demotion** | CAM / TS / SAMPLE / PROOF / XXX-in-title noise can still land in tier 2 with enough seeders (public trackers love this). |
| F5 | **Quality not in default cascade** | A 50-seeder 2160p Remux and a 60-seeder 480p CAM of the same title are adjacent; only `s` → quality fixes it. |
| F6 | **No query operators** | Users cannot write `"spider man" -cam 1080p` the way bitmagnet / Hydra / common search UX expect. |
| F7 | **No soft / fuzzy title match** | Typo `incepton`, or glued tokens `spiderman` vs `spider man`, never match. |
| F8 | **Double full re-rank on every source** | Correct but O(N log N) per settle with no score cache; feels fine at hundreds of rows, wasteful at thousands. |
| F9 | **Debrid integration ignores cache signal** | TorBox / RD are first-class, yet “already cached on debrid” is never a ranking boost (Torrentio/AIOStreams treat this as primary). |
| F10 | **Size reasonableness ignored** | A “1080p” 80 GB pack and a 1.5 GB 1080p WEB-DL score identically on text; *arrs use preferred size bands. |
| F11 | **TV episode structure unused** | `breaking bad s05e14` tokens match any name with those tokens scattered; no S/E structural boost when parser finds the same season/episode. |
| F12 | **None-match noise still visible** | Tier 0 rows sink but pollute long lists; Jackett `andmatch` would drop them. |

README still describes the product as “sorted by seeders” in the intro — the runtime default is already “relevance”; docs lag the code.

---

## 2. Survey of open-source peers (≥12)

Projects chosen for similarity: multi-indexer torrent/usenet meta-search, Stremio scrapers, *arr decision engines, and dedicated torrent FTS engines.

### 2.1 Jackett

- **Role:** Indexer proxy; scrapes → Torznab.
- **Relevancy lever:** Cardigann row filter **`andmatch`** — *only torrents whose title contains **all** query words are returned*. Optional `args` = max chars of the title to compare (trackers that truncate names).
- **Sort:** Generally leaves ordering to the tracker / consumer app.
- **Takeaway for minch:** Binary AND as a *filter* is battle-tested for noisy public trackers. minch already uses AND as a *tier*, which is softer and better for a manual TUI — but an optional “strict match” filter (hide tier &lt; 2) would match Jackett’s fix for junk-heavy sources.

### 2.2 Prowlarr

- **Role:** Indexer manager (Jackett successor for *arr stack).
- **Relevancy lever:** Mostly pass-through. Interactive search returns whatever indexers dump; apps (*arrs) do the real ranking. Uses **sortTitle**-style normalization for display/compare.
- **Takeaway:** Aggregation alone is not relevancy. Ranking belongs in the client that knows the query intent — which for minch is us.

### 2.3 Sonarr

- **Role:** Automated TV grabber.
- **Decision order** (`DownloadDecisionComparer`, Servarr FAQ — “Generally Quality Trumps All”):
  1. Quality (profile index; REPACK/PROPER = higher revision)
  2. Custom Format score
  3. Protocol (torrent vs usenet per delay profile)
  4. Episode count / episode number
  5. Indexer priority
  6. **Seeds/Peers** — `round(log10(seeders))`, then `round(log10(peers))`
  7. Age (Usenet)
  8. Size (closest to preferred size for quality)
- **Takeaway:** Cascade of *hard* keys, not a blended float. minch already borrowed log-seeder buckets. Missing from minch default: quality revision, size preference, structural episode match. Custom formats are **out of scope** (too *arr-heavy* for a zero-config CLI).

### 2.4 Radarr

- Same comparer pattern as Sonarr for movies.
- **Custom Formats** = user-defined regex/attribute scores summed into a single score used as the #2 key.
- **Takeaway:** Attribute scoring (HDR, Atmos, preferred groups) as *tiebreakers after text match* is the right complexity band if we ever add light preferences — not full CF profiles.

### 2.5 NZBHydra2

- Meta-search for Newznab + Torznab.
- **Relevancy levers:** required / forbidden words, min/max size & age, min seeders, per-indexer priority on duplicates, column sort, quickfilters (now regex-capable).
- **Does not** invent a sophisticated text-relevance score; relies on filters + user sort.
- **Takeaway:** Query-side exclude/include words and “forbid trash tokens” are high leverage for interactive search. Dedupe + indexer priority is secondary for minch (we already keep highest-seeder copy).

### 2.6 qBittorrent Search Engine

- Plugin fanout (often via Jackett); **column sort only** (name, size, seeders, engine).
- **No** client-side relevance rank.
- **Takeaway:** Pure seeder sort is the historical baseline minch deliberately moved past — good. Do not regress.

### 2.7 bitmagnet

- Self-hosted DHT indexer + **Postgres full-text search**.
- Query language (user-facing):
  - Unquoted terms = AND, any order
  - `"quoted phrases"` = ordered phrase
  - `.` = followed-by
  - `|` = OR
  - `!` = NOT
  - `*` = suffix wildcard
  - ASCII normalization (café ≡ cafe)
  - Forgiving parser
- Ranking: FTS rank (`ts_rank`-class) combined with content metadata / popularity signals in the app UI.
- **Takeaway:** Best-in-class *query language* for torrent titles. minch should steal a **subset** (quotes, `-term`/`!term`, maybe `*`) without needing Postgres — implement over in-memory rows.

### 2.8 Torrentio (Stremio)

- Scrapes public trackers; heavy debrid use.
- Config sort modes: quality then size, quality then seeders, seeders only, etc.
- Filters low-seeded torrents; with debrid, **cached** links dominate UX advice (“sort by quality then size”).
- **Takeaway:** (1) Quality-aware default for *media* queries is expected by users of modern tools. (2) Debrid-cache as a boost is table stakes once debrid is integrated.

### 2.9 Comet (and forks)

- Stremio addon; **smart ranking powered by RTN**.
- Sort modes: resolution-then-rank, resolution-then-seeders, resolution-then-size; language / completion preferences.
- **Takeaway:** Resolution banding *above* fine-grained rank is a clean UX. minch’s `qualityRank` already encodes res+source; folding a soft quality signal into default relevance is the Comet lesson without taking the Python RTN dependency.

### 2.10 AIOStreams

- Aggregates Stremio addons; **user-built multi-key sort** (resolution, quality, encode, language, cache, seeders, size, bitrate, age, service, addon…).
- Property filters: include / require / exclude on those axes.
- **Takeaway:** Configurable cascade is ideal long-term; for minch v1 of improvements, ship a **fixed good cascade** + a couple of toggles (strict match, prefer quality, prefer cached) rather than a full sort-builder UI in a TUI.

### 2.11 MediaFusion

- Similar to AIOStreams/Torrentio: sorting priority list, quality filters (e.g. uncheck CAM), language priority.
- **Takeaway:** Explicit CAM/screener exclusion is a one-line product win.

### 2.12 Rank Torrent Name (RTN) + PTT

- Library used by Comet / Riven / scrapers.
- **`title_match`** — Levenshtein ratio of cleaned titles (default threshold ~0.9) before rank.
- **`check_trash`** — garbage collector for known-bad patterns.
- **Rank** = sum of resolution/source/HDR/audio/codec/extra scores + huge preferred-pattern boost.
- **Takeaway:** Do **not** add RTN as a Python dependency. Port the *ideas*: (a) extract clean title, (b) similarity vs query, (c) trash demotion, (d) additive quality subscore as a *lower* cascade key.

### 2.13 parse-torrent-title / scene parsers

- Foundation for almost every media ranker (Sonarr QualityParser, RTN/PTT, minch `releasename.ts`).
- **Takeaway:** minch’s minimal parser is the right shape; extend it (languages, multi-episode, trash flags, group) rather than vendoring a huge parser.

### 2.14 Typesense (general search reference)

- Tie-breaking sort: `_text_match` first, then numeric popularity fields.
- **Takeaway:** Validates minch’s “text tier first, then popularity” philosophy. Keep text *strictly above* seeders forever.

### 2.15 Comparison matrix

| Project | Text match | Strict AND filter | Quality in default order | log seeders | Query ops (`"`, `-`, OR) | Trash demote | Debrid cache | Title similarity |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **minch (today)** | tier+score | sink only | opt-in sort | yes | no | no | no | prefix only |
| Jackett | — | andmatch | no | — | — | — | — | token presence |
| Prowlarr | pass-through | — | no | — | — | — | — | sortTitle |
| Sonarr/Radarr | ID+title (known item) | reject rules | **#1 key** | yes | CF regex | via CF/quality | n/a | parser |
| NZBHydra2 | filters | required words | user sort | min filter | forbid words | forbid | n/a | — |
| qBittorrent | none | — | no | column | — | — | — | — |
| bitmagnet | FTS rank | AND default | popularity UI | health | **rich** | classifier | n/a | phrase |
| Torrentio | known meta | seeder floor | **yes** | yes | config | CAM filter | **yes** | meta id |
| Comet | RTN | RTN fetch | res→rank | yes | — | RTN trash | yes | Levenshtein |
| AIOStreams | multi | property filters | configurable | yes | — | exclude | **yes** | — |
| MediaFusion | multi | quality filters | configurable | yes | — | CAM off | yes | — |
| RTN | lev + parse | require/exclude | additive rank | external | patterns | **yes** | external | **yes** |

---

## 3. Design principles (for minch specifically)

1. **Text relevance always outranks popularity.** A 5-seeder exact title must beat a 50k-seeder unrelated hit. Already true; never reverse this.
2. **Rank, don’t hide — by default.** Keep tier-0 / trash *visible but sunk* so users never think a source “returned nothing.” Offer an optional strict filter for power users (Jackett andmatch).
3. **Cascade keys &gt; blended magic scores.** Sonarr/Typesense style: ordered keys with clear semantics. Easier to test and explain in a TUI.
4. **Zero new runtime deps** unless a dep is tiny and pure-TS. Prefer extending `releasename.ts` / `relevance.ts`.
5. **Media-aware, content-agnostic.** Ranking helpers may use scene tags, but software/game/ebook queries must not be hurt (no forced “prefer 1080p” for `ubuntu 24.04`).
6. **Debrid is a signal when configured**, never a hard requirement.
7. **Streaming-friendly.** Ranking must stay O(n log n) and cheap enough to re-run as sources settle; cache per-result scores when possible.
8. **Stay a manual TUI**, not an *arr*. No auto-grab, no full custom-format engine.

---

## 4. Target ranking model

### 4.1 Query parse (new)

Extend beyond bag-of-tokens:

```
parseQuery(raw) → {
  must: string[]          // AND tokens (unquoted)
  phrases: string[][]     // ordered phrase token lists from "..."
  exclude: string[]       // -word or !word
  orGroups: string[][]    // optional later: a|b
  year?: number           // 19xx/20xx if present
  season?: number
  episode?: number
  rawTokens: string[]     // for display / debug
}
```

**Syntax (v1, bitmagnet-inspired, forgiving):**

| Syntax | Meaning |
| --- | --- |
| `word` | required token (AND) |
| `"exact phrase"` | contiguous ordered tokens in name |
| `-word` / `!word` | name must not contain token |
| `2024` | also sets `year` preference when it looks like a year |
| `S05E14` / `5x14` | also sets season/episode preference |

Unclosed quotes: treat rest as phrase (bitmagnet-style forgiveness).

Stop words still dropped *inside* free tokens; **not** inside explicit phrases.

### 4.2 Per-result features (new `scoreResult`)

| Feature | Type | Source |
| --- | --- | --- |
| `tier` | 0–3 | 3 = all must + all phrases; 2 = all must (today’s tier 2); 1 = partial; 0 = none |
| `textScore` | number | coverage, contiguity, leading, SNR, **phrase hits**, **titleSimilarity** |
| `yearBoost` | −1 / 0 / +1 | query year vs parsed year |
| `episodeBoost` | 0 / 1 | S/E match when query has S/E |
| `trashPenalty` | 0–2 | CAM/TS/SAMPLE/PROOF/SCR detected |
| `qualityBand` | number | existing `qualityRank` (soft key only) |
| `seedBucket` | number | existing `logSeeders` |
| `sizeScore` | number | optional: prefer mid-band sizes when resolution known |
| `cacheBoost` | 0 / 1 | debrid-cached if known |
| `added` | number | recency |

**Title similarity (new):**

1. `cleanTitle(name)` = strip resolution/source/codec/HDR/group/brackets via `parseReleaseName` + residual token cleanup.
2. Compare `cleanTitle` tokens to query `must` (+ phrases) with:
   - token F1 / Jaccard on sets, **or**
   - cheap normalized Levenshtein ratio on joined title strings when token counts are small (≤6 tokens) — port RTN idea without the package.
3. Feed into `textScore` (e.g. +0…25) so `Spider-Man.No.Way.Home` beats `Spider.Something.Else` even when both are full-AND on `spider man`.

**Trash patterns (initial list):**

```
\b(CAM|HDCAM|TELESYNC|HDTS|TS|TC|TELECINE|SCR|SCREENER|R5|DVDScr|SAMPLE|PROOF|XXX)\b
```

Demote (penalty key), do not delete — unless user enables strict trash hide.

### 4.3 Default sort cascade (replacement for today’s 4-key sort)

```
1. excludeMatch?          # hard filter before sort if any exclude token hits
2. tier                   ↓  (3 > 2 > 1 > 0)
3. textScore              ↓
4. yearBoost              ↓  (exact year > unknown > wrong year)
5. episodeBoost           ↓
6. trashPenalty           ↑  (less trash first)
7. seedBucket             ↓  (log10 seeders)
8. qualityBand            ↓  ONLY if preferQualityInRelevance config, else skip
9. cacheBoost             ↓  if debrid configured and status known
10. added                 ↓
```

**Default `preferQualityInRelevance = false`** initially (Phase B can flip to true after eval), matching the old Phase 3 open question — but quality still available via `s`.

### 4.4 Strict modes (filters, not sort)

| Mode | Behavior | Inspiration |
| --- | --- | --- |
| `strictAnd` | hide tier &lt; 2 | Jackett andmatch |
| `hideTrash` | hide trashPenalty &gt; 0 | MediaFusion CAM off / RTN trash |
| existing t/z/x | unchanged | minch |

UX: cycle key or config flag — see Phase C.

---

## 5. Phased implementation plan

### Phase A — Foundation hardening (low risk, high value)

> **Status: implemented** on branch `feature/search-relevancy-phase-a` (year/S-E boosts, trash demotion, title similarity, glued tokens, dotted versions, README).

**Theme:** Fix the biggest text failures without changing UX chrome.

| Task | Detail | Files | Tests |
| --- | --- | --- | --- |
| A1 | Expand stop-word list carefully (`or`, `to`? keep `from` for “Far From Home”) | `relevance.ts` | tokenize cases |
| A2 | **Year preference**: if query has year, boost exact parsed year; slight penalty for conflicting year | `relevance.ts` + `releasename.ts` | `dune 2021` ordering |
| A3 | **Season/episode preference**: if query has SxxEyy, boost matching parse | same | `breaking bad s05e14` |
| A4 | **Trash demotion** key in cascade | `releasename.ts` (`isTrashRelease`) + `relevance.ts` | CAM below WEB-DL same title |
| A5 | **Title cleaning + similarity** subscore | `relevance.ts` | spider-man vs spider something |
| A6 | **Glued-token match**: query `spider man` matches name token `spiderman` (and reverse: query `spiderman` matches `spider`+`man` via join) | `matchScore` | unit cases |
| A7 | Score cache: attach ephemeral `_rank` only inside ranker (do not mutate `TorrentResult` long-term); avoid double parse of release name when quality sort also needed | `relevance.ts` | perf sanity optional |
| A8 | README: default is relevance, not seeders | `README.md` | — |

**Acceptance (A):**

- Query `inception` → top rows all contain Inception; CAM not above BluRay when seeders similar.
- Query `dune 2021` → 2021 title above 2024 Part Two when both match “dune”.
- Query `ubuntu 24.04` still works (years as tokens; no media-only breakage).
- All existing relevance/releasename tests green; new cases added.

**Estimate:** ~1–2 focused PRs.

---

### Phase B — Query language + stricter text tiers

> **Status: implemented** on branch `feature/search-relevancy-phase-a` (`parseQuery`, phrases, excludes, tier 3, help/README).

**Theme:** Let users express intent like bitmagnet/Hydra.

| Task | Detail | Files | Tests |
| --- | --- | --- | --- |
| B1 | `parseQuery()` with phrases + excludes | new `src/sources/query.ts` | extensive |
| B2 | Wire `parseQuery` into `rankResults` / `matchScore` | `relevance.ts` | phrase must be contiguous |
| B3 | Exclude tokens remove or hard-sink matches | filter pre-pass | `-cam` kills CAM rows |
| B4 | Tier 3 = phrases satisfied + all must tokens | cascade | |
| B5 | Optional OR (`|`) if parse stays simple | query.ts | can defer |
| B6 | Help overlay: document `"phrase"` and `-word` | `HelpOverlay.tsx` | |

**Acceptance (B):**

- `"spider man" -cam` returns phrase matches without CAM.
- Unclosed `"` does not crash; best-effort phrase.
- Queries without operators behave identically to Phase A (compat tests).

**Estimate:** 1 PR.

---

### Phase C — UX controls & soft quality in default

> **Status: implemented** on branch `feature/search-relevancy-phase-a` (`f` match cycle, `relevance.*` config, preferQuality before seeders, size reasonableness, UI/README).

**Theme:** Surface power without clutter.

| Task | Detail | Files | Tests |
| --- | --- | --- | --- |
| C1 | Filter cycle or key for **strict AND** (hide tier &lt; 2) — e.g. extend `r` menu or new `f` cycle “match: soft/strict” | `filters.ts`, `Results.tsx`, store | filter tests |
| C2 | Config flags in `config.json`: `relevance.preferQuality`, `relevance.hideTrash`, `relevance.strictAnd` | `config.ts` | coerce tests |
| C3 | When `preferQuality` true, insert `qualityBand` into cascade after seed bucket (or *before* seed bucket for debrid-heavy users — pick one, document) | `relevance.ts` | |
| C4 | Size reasonableness: if resolution known, soft-penalize absurd sizes (e.g. 1080p feature &gt; 25 GB or &lt; 300 MB) — **media heuristic only when source/res tags present** | `relevance.ts` | software names exempt |
| C5 | Sort chip remains `relevance`; footer hint when strict filters active | UI | |

**Recommended default cascade after C** (still text-first):

```
tier → year → episode → textScore → trash → [qualityBand if preferQuality] → seedBucket → sizeScore → added
```

> **Decision (C3):** `preferQuality` inserts quality **before** seeder buckets (not after), so a low-seed Remux beats a high-seed 480p when text ties. Quality-after-seeds only broke same-`logSeeders` ties and was too weak as a user preference.

**Acceptance (C):** Config round-trip; strict mode count shows “N of M”; preferQuality changes order on fixture list without breaking non-media.

**Estimate:** 1–2 PRs.

---

### Phase D — Debrid cache as ranking signal

**Theme:** Use the integrations we already have.

| Task | Detail | Files | Tests |
| --- | --- | --- | --- |
| D1 | Optional batch “cached?” probe for visible top-K hashes (rate-limited, async) | debrid providers | mock providers |
| D2 | `cacheBoost` in cascade when status known | `relevance.ts` | |
| D3 | UI indicator (subtle) on cached rows — ranking alone is not enough UX | `Results.tsx` | |
| D4 | Never block search on debrid; cache is progressive enhancement | hooks | |

**Acceptance (D):** With TorBox/RD configured, cached exact matches float above uncached equals; without keys, behavior = Phase C.

**Estimate:** larger; depends on provider API batch support. Can ship D1–D2 for one provider first.

---

### Phase E — Eval harness & continuous relevancy

**Theme:** Prevent regressions; rank with evidence.

| Task | Detail |
| --- | --- |
| E1 | Golden fixture file: `test/fixtures/relevance-cases.json` — query + list of names/seeders + expected top-K order constraints |
| E2 | Offline scorer CLI: `npm run relevance:eval` prints NDCG-ish or pairwise pass rate |
| E3 | 20–30 hand-labeled cases covering: movies w/ year, TV S/E, anime brackets, software, noisy multi-audio names, CAM vs Remux, partial tokens, phrases, excludes |
| E4 | Optional: capture anonymized real fanout snapshots for replay |

**Acceptance (E):** CI runs eval; Phase A–C changes must not drop pass rate.

**Estimate:** can start in parallel with A.

---

### Phase F — Deferred / explicit non-goals

| Idea | Why defer / reject |
| --- | --- |
| Full Sonarr Custom Formats | Config explosion; *arr territory |
| ML / embeddings re-rank | Overkill offline; needs model deps |
| Postgres/Typesense index | minch is not a local DHT DB (bitmagnet’s job) |
| Auto-grab / decision engine | Product boundary |
| Porting RTN Python | Wrong language; ideas only |
| Indexer priority weights | Weak signal on public sources; dedupe already keeps healthiest hash |
| Changing Cardigann/fanout | Out of scope unless needed for cache probes |

---

## 6. Concrete API sketch (Phase A–B)

```ts
// src/sources/query.ts
export interface ParsedQuery {
  must: string[];
  phrases: string[][];
  exclude: string[];
  year: number | null;
  season: number | null;
  episode: number | null;
}

export function parseQuery(raw: string): ParsedQuery;
export function tokenize(text: string): string[]; // move/share from relevance.ts

// src/sources/relevance.ts
export interface RankOptions {
  preferQuality?: boolean;
  strictAnd?: boolean;     // filter
  hideTrash?: boolean;     // filter
}

export function rankResults(
  list: TorrentResult[],
  query: string,
  opts?: RankOptions,
): TorrentResult[];

// src/sources/releasename.ts
export function isTrashRelease(name: string): boolean;
export function cleanTitle(name: string): string; // strip tags → title-ish string
```

Keep `matchScore` exported for unit tests; internally switch to feature vector + cascade compare.

---

## 7. Suggested file change map

| File | Phases | Change |
| --- | --- | --- |
| `src/sources/query.ts` | B | **new** query parser |
| `src/sources/relevance.ts` | A–D | cascade, similarity, options |
| `src/sources/releasename.ts` | A, C | trash, cleanTitle, maybe audio/lang later |
| `src/sources/filters.ts` | C | strictAnd / hideTrash presets |
| `src/sources/search.ts` | C | maybe sort label helpers only |
| `src/config/config.ts` | C | `relevance` section |
| `src/ui/hooks/useSourceFanout.ts` | A, D | pass opts; optional cache merge |
| `src/ui/components/Results.tsx` | B–D | filters, badges |
| `src/ui/components/HelpOverlay.tsx` | B | syntax help |
| `test/relevance.test.ts` | A–C | expand heavily |
| `test/query.test.ts` | B | **new** |
| `test/fixtures/relevance-cases.json` | E | **new** |
| `README.md` | A | accuracy |
| `better-search-relevancy.md` | — | supersede / point here |

---

## 8. Worked examples (expected after Phase A–C)

### Example 1 — Exact title vs seeder bait

| Name | Seeders | Today | After A |
| --- | --- | --- | --- |
| Completely Unrelated Garbage 1080p | 50000 | bottom (tier 0) | bottom |
| Inception 2010 1080p BluRay | 5 | top | top |
| Inception 2010 CAM x264 | 4000 | 2nd (tier 2, more seeds) | below BluRay (trash key) |

### Example 2 — Year

Query: `dune 2021`

| Name | After A |
| --- | --- |
| Dune.2021.1080p.BluRay | 1 (year boost) |
| Dune.Part.Two.2024.1080p | lower (wrong year / partial) |
| Dune.1984.1080p | lower |

### Example 3 — Operators (Phase B)

Query: `"no way home" -cam 1080p`

- Must phrase contiguous `no way home`
- Exclude `cam`
- Token `1080p` required  
→ 1080p No Way Home WEB/BluRay at top; CAM and unrelated Spider titles out.

### Example 4 — Non-media

Query: `ubuntu 24.04`

- Tokens `ubuntu`, `24`, `04` (or `2404` depending on split — **must not break numbers**; verify tokenization of dotted versions)
- No trash/quality distortion  
→ Ubuntu ISOs still lead by text + seeders.

> **Note:** Tokenization of `24.04` → `24` + `04` is a known footgun; Phase A should add a test and possibly keep dotted version tokens as wholes when pattern looks like `digits.digits`.

---

## 9. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Quality-in-default hurts software/games | Only apply qualityBand when release parser found resolution/source **or** user set preferQuality; never demote unparseable names |
| Stricter matching hides good results | Default remains soft sink; strict is opt-in |
| Levenshtein cost on large lists | Cap at short cleaned titles; skip if token match already tier 0 |
| Debrid rate limits | Top-K only, cache TTL, never on critical path of first paint |
| Operator syntax surprises | Forgiving parser; help text; no-ops when unused |
| Double rank in fanout + Results | Cache features by `infoHash+query` in a WeakMap for the search generation |

---

## 10. Success metrics

| Metric | Target |
| --- | --- |
| Golden pairwise constraints pass rate | ≥ 95% on Phase E set |
| “First relevant row” for labeled queries | Top-3 contains a human-relevant hit for ≥ 90% of cases |
| Regression: existing unit tests | 100% green |
| Latency: rank 2k rows | &lt; 20 ms on modern laptop (keep TUI snappy while streaming) |
| Subjective: `minch "spider man no way home"` | First screen free of unrelated high-seed spam |

---

## 11. Recommended execution order

```
E1 (fixtures) ──► A1–A8 (foundation) ──► B (query language)
                         │
                         ├──► C (UX + config)
                         │
                         └──► D (debrid cache) [after C]
```

**First merge candidate:** Phase A only — pure ranking quality, no new keys, no config surface. Highest relevancy delta per line changed.

---

## 12. Open questions for product review

1. **Should `preferQualityInRelevance` default on or off?**  
   - Off = safer for non-media (recommended at first).  
   - On = closer to Torrentio/Comet media UX.

2. **Strict AND: filter key vs config-only?**  
   - A cycle key discovers better; config-only stays cleaner.

3. **Exclude syntax: `-word` only, or also `!word`?**  
   - Support both (bitmagnet uses `!`).

4. **Debrid cache boost before or after seeders?**  
   - Suggest: after text/year/trash, **before** seeders when provider configured (cache ⇒ playable).

5. **Retire or keep `better-search-relevancy.md`?**  
   - Keep as historical Phase 1–2 note; this doc is the living plan.

---

## 13. Summary

minch already cleared the biggest historical failure mode (seeders-only sort) with a Jackett/Sonarr-inspired tiered ranker and an opt-in quality sort. Peer projects show the next gaps clearly:

- **bitmagnet / Hydra** → query operators and excludes  
- **RTN / Comet** → title similarity + trash demotion  
- **Sonarr / Radarr** → cascade keys (year, revision/trash, size), log seeders (done)  
- **Torrentio / AIOStreams** → quality & cache as product expectations when debrid exists  
- **Jackett andmatch** → optional strict AND  

The plan above ports those ideas into minch’s pure-TS, zero-config architecture without becoming an *arr* or a search engine server. **Start with Phase A** (year, S/E, trash, title similarity, glued tokens); measure with a golden fixture set; then layer operators, UX toggles, and debrid cache boosts.

---

*Supersedes the forward-looking parts of `better-search-relevancy.md` (Phases 1–2 are done). Update this file as phases ship.*
