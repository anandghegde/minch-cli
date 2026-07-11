# Zero-Cost Release Discovery and Search Filtering Plan

> A resumable, phase-by-phase implementation plan for improving date/category filtering and adding recent OTT, Blu-ray, and India-specific release discovery to `minch-cli` without a paid data dependency.

## Plan control

| Field | Value |
| --- | --- |
| Plan status | Release-ready; post-release soak and relevance review remain non-blocking |
| Current phase | Phase 11 — Beta validation and release |
| Next task | Commit/tag v0.2.0, authenticate to npm, and publish; continue P11.1/P11.2 evidence after release |
| Last updated | 2026-07-11 |
| Monthly data budget | **$0 hard requirement** |
| Primary region | India (`IN`) |

### Status legend

- `[ ]` not started
- `[~]` in progress
- `[x]` completed and verified
- `[!]` blocked; record the reason in the execution log
- `[-]` deliberately skipped; record the decision in the execution log

### How to resume this plan

At the start of every implementation session:

1. Read **Plan control**, **Phase status**, and the last row of **Execution log**.
2. Confirm the worktree before editing; preserve unrelated user changes.
3. Continue the first `[~]` task. If none exists, continue the first `[ ]` task in the current phase.
4. Do not begin the next phase until the current phase's exit gate passes.
5. Before stopping:
   - update task markers;
   - update `Current phase` and `Next task` above;
   - add one concise execution-log row;
   - record test commands and their results;
   - name the safest next action.

Each phase is intended to be independently testable and committable. Avoid a single large cross-phase change.

## Phase status

| Phase | Outcome | Status | Depends on |
| --- | --- | --- | --- |
| 0 | Validate free source contracts and capture fixtures | `[x]` | — |
| 1 | Correct torrent date semantics and add torrent category filtering | `[x]` | — |
| 2 | Add the release-discovery domain model and adapter contracts | `[x]` | 0 |
| 3 | Add persistent cache, request ledger, and stale-while-revalidate | `[x]` | 2 |
| 4 | Add TMDb metadata and regional release adapter | `[x]` | 2–3 |
| 5 | Add restricted Blu-ray.com RSS with TMDB generic-physical fallback | `[x]` | 2–4 |
| 6 | Add India OTT change feed within the free allowance | `[x]` | 2–4 |
| 7 | Merge, deduplicate, classify, and rank discovery events | `[x]` | 4–6 |
| 8 | Evolve Trending into the Discover UI and connect it to search | `[x]` | 1, 7 |
| 9 | Add the India view, provider/language filters, and regional rules | `[x]` | 7–8 |
| 10 | Harden offline behavior, attribution, diagnostics, and docs | `[x]` | 3–9 |
| 11 | Run beta validation and release the $0 stack | `[~]` | 0–10 |

## 1. Goal and product decisions

The finished feature should let a user:

1. Apply a torrent date filter such as “last week” and see only rows whose known added date is inside that window. Undated torrents must not appear above dated matches—or silently pass a date constraint at all.
2. Filter torrent search/browse results by normalized categories such as Movies, TV, Anime, Games, Music, and Other.
3. Browse titles recently added to streaming services in India, including provider and addition date when the source supplies them.
4. Browse recent and upcoming Blu-ray/4K releases.
5. Browse an India-specific feed and narrow it by Indian title, provider, language, media type, and date window.
6. Select a discovered title and launch the existing torrent search using a clean title plus year.
7. Continue using cached discovery data when offline or when one upstream is unavailable.

### Fixed architectural decisions

- **Discovery is not torrent search.** OTT/Blu-ray/catalog records have no magnet, seeders, size, or torrent-added date and must not implement the existing `Source`/`TorrentResult` contract.
- **Known dates are honest dates.** Missing dates are represented explicitly and never interpreted as “now,” epoch zero, or recent.
- **Availability is not arrival.** A provider saying a title is currently available does not prove when it was added. Only a change event or an explicit source date can populate `streaming_added`.
- **Physical is not automatically Blu-ray.** TMDb release type `5` is stored as `physical`; only Blu-ray-specific evidence can label an event `bluray` or `uhd_bluray`.
- **The existing Trending tab becomes Discover.** Retain the internal `trending` view key initially to minimize churn, but display `Discover` and add feed selectors for Trending, OTT, Blu-ray, and India.
- **Bring-your-own free credentials.** Never bundle maintainer API keys in the npm package or repository.
- **No paid fallback.** Reaching a quota produces cached/partial results and a clear status; it never triggers billable usage.

### Non-goals for this plan

- A global, continuously synchronized streaming catalogue.
- Scraping JustWatch, Rotten Tomatoes, IMDb, Letterboxd, OTTPlay, Binged, or similar sites by default.
- User accounts, cloud synchronization, background daemons, notifications, or an always-on server.
- Guaranteeing that every provider publishes complete or perfectly timed India data.
- Automatically downloading or selecting a torrent from a discovery item.

## 2. The $0 source stack

| Source | Role | Direct cost | Credential | Important limitation |
| --- | --- | --- | --- | --- |
| [TMDb API](https://developer.themoviedb.org/docs/faq) | Canonical title IDs, media type, poster, genres, countries, language, popularity, regional digital/physical dates, current watch-provider hints | $0 for qualifying non-commercial use with attribution | User TMDb read-access token | Commercial use requires separate permission; provider presence is not a provider-addition timestamp |
| [Blu-ray.com new-release RSS](https://www.blu-ray.com/rss/newreleasesfeed.xml) | Blu-ray/4K-specific release evidence | $0 public feed | None | No documented API/SLA; feed behavior and permitted reuse must be verified and polling must be gentle |
| [Trakt API](https://docs.trakt.tv/docs/authentication-oauth) | Excluded unless written approval supersedes ADR 002 | $0 public API with branding requirements | Reserved only; inactive | Current app terms make this integration ineligible |
| [Streaming Availability API](https://docs.movieofthenight.com/resource/changes) | India catalog changes: new, updated, removed, upcoming, and expiring titles by provider | Free allowance; implementation must stay within it | User direct developer-platform key | Free quota is finite; past/future change queries are limited to a 31-day window |

The plan deliberately does not depend on Firecrawl or Apify. They remain future experiments only if the four-source stack has a measured gap and the target site's terms permit automated access.

## 3. Target architecture

```text
TMDb ───────────────────────────────┐
Blu-ray RSS ────────────────────────┤
Trakt (disabled by ADR 002) ────────┼─► no adapter without written approval
Streaming Availability /changes ───┘          │
                                               ▼
                                    normalized ReleaseEvent[]
                                               │
                      ┌────────────────────────┴──────────────────────┐
                      ▼                                               ▼
              persistent snapshots                         merge/dedupe/rank
              + request ledger                                     │
                      │                                              ▼
                      └──────── stale-while-revalidate ─────► Discover UI
                                                                      │
                                                        “search torrents” action
                                                                      ▼
                                                        existing Torrent Search
```

### Proposed file layout

```text
src/discovery/
  types.ts                 # normalized title/event/evidence types
  adapter.ts               # DiscoveryAdapter contract
  dates.ts                 # date-only parsing and window helpers
  normalize.ts             # title/provider/language normalization
  merge.ts                 # identity matching and event dedupe
  rank.ts                  # deterministic feed ordering
  service.ts               # orchestration and partial-failure handling
  cache.ts                 # versioned persistent snapshots
  budget.ts                # per-source request accounting and hard caps
  config.ts                # source credential/config descriptors
  sources/
    tmdb.ts
    bluray.ts
    # trakt.ts intentionally absent while ADR 002 is in force
    streaming-availability.ts

src/ui/
  hooks/useDiscovery.ts
  components/Discover.tsx  # may replace/rename Trending.tsx in a later commit
  components/DiscoveryDetails.tsx

test/discovery/
  fixtures/
  dates.test.ts
  cache.test.ts
  budget.test.ts
  tmdb.test.ts
  bluray.test.ts
  # trakt.test.ts intentionally absent while ADR 002 is in force
  streaming-availability.test.ts
  merge.test.ts
  rank.test.ts
  service.test.ts
  discover-ui.test.tsx
```

### Normalized model

Keep a title and its release/availability events separate. A title can have multiple providers and release dates without being duplicated in the UI.

```ts
type MediaType = "movie" | "series" | "season" | "episode";
type ReleaseKind =
  | "streaming_added"
  | "streaming_upcoming"
  | "digital"
  | "physical"
  | "bluray"
  | "uhd_bluray";

type DatePrecision = "day" | "month" | "year" | "unknown";
type EvidenceConfidence = "exact" | "source_claim" | "inferred";

interface CatalogTitle {
  id: string;                         // stable internal ID
  title: string;
  originalTitle?: string;
  year?: number;
  mediaType: MediaType;
  tmdbId?: number;
  imdbId?: string;
  traktId?: number;
  originalLanguage?: string;          // ISO 639-1 when available
  originCountries: string[];          // ISO 3166-1 alpha-2
  genreIds: number[];
  posterUrl?: string;
  popularity?: number;
}

interface ReleaseEvent {
  id: string;                         // deterministic event identity
  titleId: string;
  kind: ReleaseKind;
  region: string;                     // e.g. IN; never silently global
  date?: string;                      // YYYY-MM-DD only
  datePrecision: DatePrecision;
  providerId?: string;
  providerLabel?: string;
  formatLabel?: string;               // e.g. 4K UHD, Blu-ray
  status: "past" | "today" | "upcoming" | "unknown";
  firstObservedAt: number;            // Unix milliseconds
  lastObservedAt: number;
  evidence: SourceEvidence[];
}

interface SourceEvidence {
  source: "tmdb" | "bluray" | "trakt" | "streaming-availability";
  sourceId?: string;
  sourceUrl?: string;
  observedAt: number;
  confidence: EvidenceConfidence;
}
```

Rules:

- Store calendar dates as `YYYY-MM-DD`, not midnight timestamps. This avoids timezone-shifting an India release into the previous day.
- `firstObservedAt` is diagnostic provenance, not a release date.
- A missing date stays `undefined` with `datePrecision: "unknown"`.
- Do not infer India origin from language alone. `originCountries.includes("IN")` defines an Indian title; language is a separate filter.
- Do not merge two records on normalized title alone when years conflict or are absent and the match is ambiguous.

## 4. Request and cache budget

The free Streaming Availability allowance is the binding constraint. Enforce the limit locally even if the provider would accept more calls.

### Default refresh policy

| Data | Fresh TTL | Stale data retained | Maximum automatic work |
| --- | ---: | ---: | ---: |
| Streaming changes, India | 12 hours | 45 days | 4 cursor pages per refresh |
| TMDb trending/discover lists | 12 hours | 7 days | 1 page per configured feed |
| TMDb selected-title details | 7 days | 30 days | Only on explicit selection or missing merge ID |
| Blu-ray RSS | 24 hours | 30 days | 1 fetch per refresh |
| Trakt physical calendar | Disabled | No data retained | No request without written approval |
| Provider/country dictionaries | 30 days | 90 days | 1 request when stale |

At two Streaming Availability refreshes per day and four pages per refresh, the theoretical maximum is 248 change requests in a 31-day month. Reserve the rest of the user-confirmed 500-request local envelope for provider dictionaries, retries, manual diagnostics, and contract changes. This envelope is not presented as a provider-published quota.

### Hard safeguards

- Default soft warning at 350 Streaming Availability calls/month.
- Hard stop at 450 calls/month, leaving a safety margin of 50.
- Count an attempted HTTP request before sending it, including retries.
- `429` must honor `Retry-After`; it must not busy-retry.
- A manual refresh respects TTL and budget. A separate future `--force` diagnostic may bypass TTL but never the hard monthly cap.
- Store usage by source and UTC billing month in `discovery-usage.json`.
- Never make one TMDb enrichment call per row during list rendering.
- Never fetch posters as part of terminal rendering; construct image URLs only for future consumers.

### Persistent files

Extend `src/config/paths.ts` with:

- `discoveryCacheFile` → data directory, `discovery-cache.json`
- `discoveryUsageFile` → data directory, `discovery-usage.json`

Use the existing atomic-write and serialized-write helpers. Version every persisted document so a future schema change can discard or migrate safely.

## 5. Detailed execution phases

## Phase 0 — Source contracts and fixture capture

**Purpose:** Prove that the free sources provide the fields this design relies on before building production adapters.

### Tasks

- [x] **P0.1 — Source/terms decision record**
  - Create `docs/decisions/001-zero-cost-discovery-sources.md`.
  - Record signup URL, credential type, non-commercial/commercial restriction, attribution requirement, published quota, region support, and contact/terms URL for each source.
  - Record that the application will not proxy or redistribute bulk datasets.
  - Confirm whether Blu-ray.com permits this low-frequency RSS use. If unclear, restrict use to feed titles/dates/links with attribution and record the unresolved risk.
- [x] **P0.2 — Safe credential conventions**
  - Define environment variables: `TMDB_READ_TOKEN`, `TRAKT_CLIENT_ID`, and `STREAMING_AVAILABILITY_API_KEY`.
  - Fix Movie of the Night access to the direct developer platform; RapidAPI keys/endpoints are unsupported and no selector is needed.
  - Add variable names—not values—to `.gitignore` documentation and future settings help.
- [x] **P0.3 — Live contract spike**
  - Query one minimal response from each configured API/feed.
  - Verify India is returned by the streaming `/countries` contract.
  - Verify the desired Indian provider/catalog IDs from the live dictionary instead of hard-coding assumed IDs.
  - Verify `/changes` pagination, timestamp units, `changeType`, `itemType`, title IDs, provider/catalog fields, and the included `shows` dictionary.
  - Verify TMDb `region=IN`, release types `4` (Digital) and `5` (Physical), and watch-provider response shape.
  - Verify Blu-ray RSS format, update cadence, date timezone/format, item GUID stability, and whether it distinguishes Blu-ray from 4K UHD.
  - Do not probe Trakt unless written approval supersedes ADR 001; its current app terms make the planned integration ineligible.
- [x] **P0.4 — Sanitized fixtures**
  - Save small, sanitized JSON/XML fixtures under `test/discovery/fixtures/`.
  - Keep 2–5 representative records per source: movie, series where supported, Indian title, missing date, missing external ID, and duplicate title.
  - Remove tokens, request headers, account identifiers, and irrelevant large payloads.
  - Note capture date and endpoint in a fixture README.
- [x] **P0.5 — Go/no-go review**
  - If Streaming Availability's current free contract cannot cover India change events, mark Phase 6 blocked and ship TMDb “currently available” as a clearly weaker view; do not label it “recently added.”
  - ADR 002 outcome: the India changes contract is a go; Blu-ray RSS is a restricted unknown-region pilot; Trakt is a no-go; TMDB type `5` is the only approved generic `physical` fallback.

### Verification

- Fixtures parse with `JSON.parse` or the existing XML parser.
- No secret-like string is present in `git diff` or fixture files.
- Every field in the normalized model has at least one confirmed upstream source or is explicitly optional.

### Exit gate

Proceed only when the source decision record and sanitized fixtures exist and the two critical claims are proven: an India `/changes` response has a real change timestamp, and at least one physical source has usable release dates.

### Resume point after Phase 0

Start P1.1. Keep the fixtures stable; production adapter tests must use them rather than live network calls.

## Phase 1 — Fix torrent date and category filtering first

**Purpose:** Resolve the two immediate search pain points independently of the new discovery stack.

### Tasks

- [x] **P1.1 — Change active date-window semantics**
  - Update `src/sources/filters.ts` so an active time filter includes a row only when `added` is finite and `added >= cutoff`.
  - Keep undated rows only when the time filter is `all`.
  - Do not use `added ?? 0` to decide membership.
- [x] **P1.2 — Make date sort consistently known-first**
  - Update date sorting in `src/sources/search.ts` so missing/invalid dates are always below known dates in both newest-first and oldest-first order.
  - Retain the stable tiebreaker for equal known dates.
- [x] **P1.3 — Share category normalization**
  - Move or generalize `classifyCategory` from `src/sources/trending.ts` into a reusable category module.
  - Preserve existing mappings and add fixture-driven aliases only when actual sources emit them.
  - Keep unknown/missing values in `other`; do not guess from torrent names in this phase.
- [x] **P1.4 — Add category to `FilterState`**
  - Add `all`, `movies`, `tv`, `anime`, `games`, `music`, `xxx`, and `other`.
  - Apply it with date, size, and seeder filters before ranking/sorting.
  - Add a `c` category cycle and an inline active-filter label. Avoid overloading keys already scoped to other screens.
- [x] **P1.5 — Explain missing dates**
  - When a date window is active, show a compact count such as `37 of 121 · 22 undated hidden` if space permits.
  - Update help text: “Date filters require a known source-added date.”
- [x] **P1.6 — Tests**
  - Add exact-boundary, one-second-outside, future-date, missing-date, `NaN`, and combined category/date cases.
  - Test known-first date ordering in both directions.
  - Update existing tests that currently assert undated rows survive an active time filter.

### Verification

```bash
npm test -- --run test/filters.test.ts test/search.test.ts test/trending.test.ts
npm run typecheck
```

Manual cases:

- “last week” contains no undated result.
- Resetting date to All restores undated results.
- Category plus date composes; changing sort never reintroduces a filtered row.
- `Other` shows unknown categories explicitly.

### Exit gate

The filter behavior is covered by unit tests, the TUI tells the user why undated rows disappeared, and all existing tests pass.

### Resume point after Phase 1

Start P2.1. Do not couple `TorrentResult.category` to the new discovery genre/provider taxonomy.

## Phase 2 — Discovery domain model and adapter contracts

**Purpose:** Establish a pure, testable boundary before any production networking.

### Tasks

- [x] **P2.1 — Add normalized types** in `src/discovery/types.ts` based on the model above.
- [x] **P2.2 — Add adapter contract**
  - `id`, `label`, `isConfigured()`, `capabilities`, and `fetch(request, options)`.
  - Return a typed snapshot containing titles, events, `fetchedAt`, source cursor if relevant, and non-fatal warnings.
  - Accept `AbortSignal` and dependency-injected fetch for tests.
- [x] **P2.3 — Define feed requests**
  - Region, feed kind, past/upcoming date range, media type, provider IDs, and page/cursor limit.
  - Validate maximum ranges before reaching an adapter.
- [x] **P2.4 — Date utilities**
  - Strict `YYYY-MM-DD` parser, India-local “today,” inclusive window checks, comparison with missing values, and status calculation.
  - Reject impossible dates rather than normalizing them silently.
- [x] **P2.5 — Provider/language normalization**
  - Canonical provider ID plus upstream aliases and display label.
  - ISO language code plus a display map for Hindi, Kannada, Tamil, Telugu, Malayalam, Bengali, Marathi, Punjabi, Gujarati, and English.
- [x] **P2.6 — Pure contract tests** using Phase 0 fixtures and fake adapters.

### Verification

- Domain modules import no Ink/React modules.
- No discovery type extends `TorrentResult` or `Source`.
- Date-only tests pass under multiple `TZ` values, including `Asia/Kolkata` and `UTC`.
- `npm run typecheck` passes.

### Exit gate

All four adapters can be described by the same contract without discarding provider, region, date precision, or evidence provenance.

### Resume point after Phase 2

Start P3.1 with fake snapshots; do not wait for live adapters.

## Phase 3 — Persistent cache, budget ledger, and orchestration shell

**Purpose:** Make zero-cost and offline behavior structural rather than an afterthought.

### Tasks

- [x] **P3.1 — Versioned cache format**
  - Store independent snapshots per source/request key.
  - Include schema version, fetched time, expiry, stale-until, request descriptor, normalized records, and source warnings.
  - Reject corrupt entries independently so one bad source does not discard all cache data.
- [x] **P3.2 — Atomic cache repository**
  - Reuse `writeJsonAtomic` and `serializeWrites`.
  - Coalesce concurrent refresh writes and test failure recovery.
  - Keep discovery cache separate from the existing five-minute in-memory torrent search cache.
- [x] **P3.3 — Monthly request ledger**
  - Track attempts by source, endpoint class, and UTC month.
  - Implement `canSpend`, `recordAttempt`, warning threshold, and hard cap.
  - Make limits configuration constants with conservative defaults, not user-settable above the known free quota in this phase.
- [x] **P3.4 — Stale-while-revalidate service**
  - Return fresh cache immediately.
  - Return stale-but-usable cache plus status while refreshing in the foreground/background appropriate to the TUI lifecycle.
  - On offline/timeout/quota failure, retain the last good snapshot.
  - Deduplicate concurrent identical refreshes.
- [x] **P3.5 — Partial-source state**
  - Model `ready`, `refreshing`, `stale`, `unconfigured`, `quota-paused`, and `failed` independently per adapter.
  - Aggregate warnings without turning one failure into an empty screen.
- [x] **P3.6 — Tests**
  - Fresh/stale/expired behavior, corrupt JSON, schema mismatch, atomic failure, concurrent refresh, month rollover, retry accounting, hard-cap refusal, abort, and partial failure.

### Verification

```bash
npm test -- --run test/discovery/cache.test.ts test/discovery/budget.test.ts test/discovery/service.test.ts
npm run typecheck
```

### Exit gate

A fake adapter can demonstrate fresh-cache, stale-cache, offline, partial-failure, and quota-paused behavior without any live HTTP call.

### Resume point after Phase 3

Start P4.1. Use the service/cache boundary from this phase; adapters must not write files directly.

## Phase 4 — TMDb foundation adapter

**Purpose:** Supply canonical metadata, identity, India release context, genres, origin country/language, and popularity.

### Tasks

- [x] **P4.1 — Credential/config descriptor**
  - Read `TMDB_READ_TOKEN` first, with an optional Settings value stored in owner-only `config.json` following existing secret handling.
  - Validate only by a cheap authenticated probe; never log the token.
- [x] **P4.2 — Typed client and response validation**
  - Use `fetchResilient`, authorization bearer header, abort signals, bounded pagination, and runtime guards for required fields.
  - Convert malformed rows into warnings instead of crashing the entire snapshot.
- [x] **P4.3 — Feed calls**
  - Weekly trending: `/trending/all/week`, excluding people.
  - India digital candidates: `/discover/movie` with `region=IN`, date range, and `with_release_type=4`.
  - India physical candidates: the same with release type `5`, stored as `physical` only.
  - Use `sort_by` and page limits explicitly so results are deterministic.
- [x] **P4.4 — Lazy enrichment**
  - Use details, regional release dates, external IDs, or watch-provider endpoints only when the list response lacks a field needed for identity/details.
  - Cache enrichment by media type + TMDb ID for seven days.
  - Never enrich every rendered row.
- [x] **P4.5 — Attribution metadata**
  - Expose `sourceLabel: TMDb`, source URL when possible, and the required notice/logo guidance in docs and Discover help/details.
- [x] **P4.6 — Fixture tests**
  - Movie/series mapping, person exclusion, missing dates, region handling, release type mapping, malformed rows, `401`, `429`, abort, and page cap.

### Important semantics

- TMDb release type `4` becomes `digital`, not necessarily “new on Netflix.”
- TMDb release type `5` becomes `physical`, not necessarily Blu-ray.
- TMDb watch providers describe current offers. They may enrich provider display but cannot create `streaming_added` events.

### Exit gate

With only a TMDb token, Discover can return normalized Trending and India digital/physical candidates, display clear attribution, and work from cache after the first successful fetch.

### Resume point after Phase 4

Start P5.1. Reuse TMDb IDs for cautious cross-source matching, but preserve every physical source's evidence separately.

## Phase 5 — Blu-ray RSS and generic physical fallback

**Purpose:** Produce an honest recent/upcoming physical-media feed with the most specific format available at $0.

### Tasks

- [x] **P5.1 — Blu-ray RSS adapter**
  - Fetch once per 24 hours using the existing User-Agent and resilient network helper.
  - Parse via the existing XML dependency; do not add a new parser.
  - Normalize GUID/link, title, release date, studio/year if supplied, and format markers.
  - Only map to `bluray` or `uhd_bluray` when the feed explicitly supports that conclusion.
- [x] **P5.2 — Feed hygiene**
  - Use a stable source GUID when available.
  - Reject malformed dates while retaining the title as an unknown-date event only in an unfiltered/all view.
  - Sanitize HTML descriptions and never render raw terminal control sequences.
- [-] **P5.3 — Trakt adapter**
  - Skipped by ADR 002: do not probe, configure, or implement Trakt without written approval for this application.
  - Use cached TMDB type `5` events as explicitly generic `physical` fallback; never relabel them as Blu-ray.
- [x] **P5.4 — Identity enrichment**
  - Prefer upstream TMDb/IMDb IDs.
  - If Blu-ray RSS lacks IDs, perform cautious local matching against cached TMDb candidates using normalized title + exact year.
  - Do not make unlimited TMDb searches; unresolved records remain standalone.
- [x] **P5.5 — Source precedence**
  - Same title/date/format: merge evidence.
  - Conflicting dates: preserve both claims internally, show the higher-confidence claim, and expose “sources disagree” in details.
  - Blu-ray-specific claim outranks generic physical classification, not necessarily a conflicting date.
- [x] **P5.6 — Tests**
  - RSS variants, 4K label, XML entities, missing GUID/date, duplicate item, malicious control text, generic physical fallback, conflicting date, and offline cached feed.

### Exit gate

The Blu-ray feed shows only known dates under active date windows, differentiates explicit 4K/Blu-ray from generic physical releases, and remains usable from cache when the RSS feed is down.

### Resume point after Phase 5

Start P6.1. Do not spend OTT quota while testing physical adapters.

## Phase 6 — India OTT change adapter within the free allowance

**Purpose:** Build a genuine “recently added in India” feed instead of deriving recency from current availability.

### Tasks

- [x] **P6.1 — Credential and fixed transport**
  - Support only the vendor's direct developer endpoint and `X-API-Key` authentication.
  - Reject marketplace/RapidAPI keys by documentation and never add a transport selector or fallback.
- [x] **P6.2 — Provider dictionary**
  - Fetch the current India country/catalog dictionary and cache it for 30 days.
  - Map live catalog IDs to display names such as Netflix, Prime Video, JioHotstar, Zee5, and SonyLIV; do not assume branding or IDs remain stable.
- [x] **P6.3 — Recent additions query**
  - Call the direct `/v4/changes` endpoint with `country=in`, `change_type=new`, `item_type=show`, the desired `from` timestamp, and `output_language=en`.
  - Omit `show_type` initially so movies and series share one cursor stream unless the live contract proves separate calls are necessary.
  - Consume at most four 25-item cursor pages per refresh.
  - Map the change timestamp—not current availability or observation time—to `streaming_added`.
- [x] **P6.4 — Upcoming feed, only after budget measurement**
  - Add one bounded `change_type=upcoming` request only for services the API documents as supporting it.
  - Keep upcoming visually and semantically separate from already-added titles.
  - Skip this call automatically when the request ledger reaches its warning threshold.
- [x] **P6.5 — Normalize included shows**
  - Join `changes[].showId` to the response's `shows` dictionary.
  - Preserve TMDb/IMDb IDs, type, year, original language, countries, genres, image metadata, provider link/deep link, and audio/subtitle metadata only when present.
  - Do not issue a second request per show.
- [x] **P6.6 — Cursor and event identity**
  - Event key includes country, catalog/provider, change type, item type, show ID, and timestamp.
  - Detect repeated cursors and stop.
  - Persist the newest successfully seen change timestamp/cursor as an optimization, while retaining a small overlap to prevent boundary loss.
- [x] **P6.7 — Quota/error behavior**
  - Stop before call 451 in a UTC month.
  - On `401/403`, mark unconfigured/auth-failed without deleting cache.
  - On `429`, record retry timing and show quota-paused.
  - On contract drift, retain the last valid snapshot and surface a source warning.
- [x] **P6.8 — Tests**
  - Multi-provider addition, movie/series, missing show dictionary entry, repeated cursor, four-page cap, 31-day boundary, duplicate event, `429`, hard cap, fixed direct host/header, and stale cache.

### Exit gate

The adapter can answer “what was newly added to supported streaming catalogs in India?” with a source timestamp, provider, and title while demonstrating a worst-case automatic request count below the local hard cap.

### Resume point after Phase 6

Start P7.1 using cached snapshots from all available adapters. Do not make aggregation responsible for refreshing sources.

## Phase 7 — Merge, classification, and ranking

**Purpose:** Turn partial, overlapping source snapshots into predictable feeds without inventing facts.

### Tasks

- [x] **P7.1 — Canonical identity**
  - Match by `(mediaType, tmdbId)` first, then IMDb ID.
  - Fallback only to normalized title + exact year + compatible media type.
  - Leave ambiguous matches separate and emit a diagnostic counter.
- [x] **P7.2 — Event dedupe**
  - Deduplicate identical provider/region/kind/date events while combining evidence.
  - Preserve meaningful distinctions: provider, release format, region, and conflicting date.
- [x] **P7.3 — Date filtering rules**
  - Active recent/upcoming windows require a known exact-enough date.
  - Unknown dates appear only in `All` and sort below every known date.
  - Past view sorts newest first; upcoming view sorts soonest first.
- [x] **P7.4 — Feed classification**
  - `Trending`: TMDb popularity/trending evidence; no claim of release recency.
  - `OTT`: `streaming_added` and optionally `streaming_upcoming` only.
  - `Blu-ray`: `bluray`, `uhd_bluray`, plus clearly labeled generic `physical` fallback if enabled.
  - `India`: region `IN` events, with an `Indian titles only` toggle based on `originCountries.includes("IN")`.
- [x] **P7.5 — Provider and media filters**
  - All/Movies/Series; provider; date window; release format; language; Indian-title toggle.
  - Genres come from canonical metadata and are separate from coarse media type.
- [x] **P7.6 — Ranking cascade**
  - Apply hard filters first.
  - Known event date in feed-appropriate direction.
  - Evidence confidence (`exact` > `source_claim` > `inferred`).
  - TMDb popularity as a late tiebreaker, never above event date.
  - Stable title/ID tiebreak for flicker-free streaming UI.
- [x] **P7.7 — Conflict diagnostics**
  - Counts for unresolved identity, unknown date, conflicting date, duplicate events, missing metadata, and source contribution.
- [x] **P7.8 — Golden tests**
  - Undated event never tops “last week.”
  - Older popular title never outranks a newer exact event solely due to popularity.
  - Current provider availability never becomes a recent-add event.
  - Hindi-language non-Indian title is not automatically classified as Indian.
  - Same movie on Netflix and Prime remains two provider events under one title.

### Exit gate

Given only fixture snapshots, the aggregator produces deterministic Trending, OTT, Blu-ray, and India feeds with no network or UI dependency.

### Resume point after Phase 7

Start P8.1. Treat the aggregated view model as the UI boundary; do not duplicate merge/filter logic in React components.

## Phase 8 — Discover UI and torrent-search handoff

**Purpose:** Expose the data without crowding the existing TUI or confusing catalog records with torrents.

### Recommended interaction

```text
[ Torrent Search ]  Discover  Real-Debrid  TorBox  Sources  Settings

Discover: [Trending] [OTT] [Blu-ray] [India]
Type:     [All] [Movies] [Series]   Window: [7d] [30d] [Upcoming]
Provider: [All] [Netflix] [Prime Video] [JioHotstar] ...

▸ 2026-07-10  Example Title (2026)  Netflix   Hindi
  2026-07-09  Another Film (2025)   Prime     Tamil

s search torrents · enter details · r refresh · ←→ filter
```

### Tasks

- [x] **P8.1 — Evolve the existing view incrementally**
  - First retain `View = "trending"` internally and change the user label to `Discover`.
  - Generalize or replace `useTrending` with `useDiscovery` after the new screen works.
  - Avoid renaming every file/view key in the same commit as behavior changes.
- [x] **P8.2 — Discovery screen state**
  - Feed, media type, date window, provider, language, format, Indian-title toggle, cursor, and details overlay.
  - Filter state is screen-local initially; persist preferences only after UX validation.
- [x] **P8.3 — Rows and statuses**
  - Show event date, clean title/year, provider or format, and language/source as width permits.
  - Show loading progress per adapter, last refreshed time, stale marker, quota-paused marker, and partial-source warning.
  - Never show seeders, torrent size, magnet actions, or fake relative age for discovery rows.
- [x] **P8.4 — Details overlay**
  - Full title, media type, event kind/date/region, provider/format, original language, origin countries, genres, source links, evidence, and disagreement warning.
  - Include required source attribution.
- [x] **P8.5 — Search handoff**
  - Bind `s` (or another conflict-free documented key) to `submitQuery(clean title + year)` and switch to Torrent Search.
  - Do not append provider, “Blu-ray,” language, or other tags unless the user explicitly chooses a future quality action.
  - Preserve the discovery screen's cursor/filter state when the user returns.
- [x] **P8.6 — Empty/config states**
  - No credentials: show exact environment-variable/Settings instructions and whichever credential-free feed is available.
  - No matching rows: distinguish “filters removed all rows,” “no recent events,” “offline with no cache,” and “source unconfigured.”
- [x] **P8.7 — UI tests**
  - Feed/filter switching, cursor clamping, narrow terminal, loading/stale/error states, details overlay, search handoff, and no accidental torrent action.

### Exit gate

A user can navigate all four feeds, understand freshness/source limitations, and launch a torrent query from a selected title. Existing Search, Sources, Settings, and debrid screens still work.

### Resume point after Phase 8

Start P9.1 with real India fixture coverage. Do not use language as a substitute for region or origin country.

## Phase 9 — India view and regional UX

**Purpose:** Make “India-specific” precise instead of one ambiguous label.

### Product definitions

- **Available in India:** an event/provider observation whose region is `IN`.
- **Indian title:** canonical metadata includes origin country `IN`.
- **Indian-language title:** original or available audio language matches a selected language. This is useful but is not equivalent to Indian origin.

The India feed defaults to **Available in India**. The `Indian titles only` toggle narrows it to origin country `IN`.

### Tasks

- [x] **P9.1 — India provider registry from live data**
  - Build display groups from the API's cached country/catalog dictionary.
  - Preserve unknown providers rather than dropping them.
  - Keep provider aliases data-driven so rebrands such as Hotstar/JioHotstar do not fragment the UI.
- [x] **P9.2 — Language filters**
  - Initial ordered list: All, Hindi, Kannada, Tamil, Telugu, Malayalam, Bengali, Marathi, Punjabi, Gujarati, English, Other.
  - Prefer original language for title classification; label audio availability separately when supplied.
- [x] **P9.3 — India feed composition**
  - OTT additions in region `IN` are primary.
  - India digital/physical TMDb events may appear with explicit kind labels.
  - Blu-ray global/unknown-region records do not enter India merely because a title is Indian; provide a separate title-origin filter in the Blu-ray feed if desired.
- [x] **P9.4 — Date/window choices**
  - Recent: 7 days and 30 days.
  - Upcoming: next 7 and 30 days where supported.
  - All cached: diagnostics/fallback, with unknown dates last.
- [x] **P9.5 — India fixture matrix**
  - Indian movie in Hindi; Indian series in a South Indian language; English-language Indian title; non-Indian Hindi title; global title newly added in India; provider rebrand alias; missing country/language.
- [x] **P9.6 — Manual validation**
  - Compare a small sampled week against provider apps or editorial calendars manually.
  - Record source coverage and mismatches, not scraped content.

### Exit gate

The UI clearly distinguishes availability region, title origin, and language, and the fixture matrix prevents these concepts from collapsing in future refactors.

### Resume point after Phase 9

Start P10.1. Treat observed data gaps as diagnostics/documentation unless a free contracted source can fill them.

## Phase 10 — Reliability, security, attribution, and documentation

**Purpose:** Make the feature safe to ship as a zero-config-friendly CLI with optional credentials.

### Tasks

- [x] **P10.1 — Offline and partial-failure audit**
  - Launch offline with cache, offline without cache, one failing adapter, all failing adapters, corrupt cache, and quota-paused OTT.
  - No state may collapse to a misleading empty “0 releases” message.
- [x] **P10.2 — Security/privacy audit**
  - Secrets never enter URLs when a header is supported, logs, notices, fixtures, cache, crash text, or source links.
  - Config remains owner-only; discovery cache contains no credentials.
  - Sanitize all upstream text for terminal escape/control characters.
- [x] **P10.3 — Rate-limit audit**
  - Verify retries count against local budget.
  - Verify refresh coalescing, TTL, cursor caps, and hard monthly stop.
  - Add a diagnostic view/command that reports calls used/limit without exposing keys.
- [x] **P10.4 — Attribution and legal docs**
  - Add source credits and required notices to README/help/details.
  - Document that data completeness and release dates are source claims.
  - Document TMDb non-commercial terms and the need to revisit licensing before monetization.
- [x] **P10.5 — User setup docs**
  - Key signup, environment variables, optional Settings entry, cache location, refresh policy, quota behavior, source limitations, and disabling an adapter.
  - Include a “minimum setup” path: credential-free Blu-ray RSS first, then TMDb, then optional OTT.
- [x] **P10.6 — Full automated checks**
  - All fixture/unit/UI tests, typecheck, build, and package-content inspection.
  - Live network tests remain opt-in and never run in the default test suite.

### Verification

```bash
npm test
npm run typecheck
npm run build
npm pack --dry-run
```

### Exit gate

All checks pass, setup and attribution are documented, no secret is packaged, and cached/partial failure behavior has been manually exercised.

### Resume point after Phase 10

Start P11.1 using a clean test state directory and a fresh monthly usage ledger.

## Phase 11 — Beta validation and release

**Purpose:** Measure whether the $0 stack solves the product problem before adding more sources or complexity.

### Tasks

- [x] **P11.1 — Release sample and post-release soak**
  - Require two samples separated by the normal refresh interval for beta release readiness.
  - Record request count, successful refreshes, stale periods, source errors, unique titles/events, unknown-date count, and ambiguous-merge count.
  - Continue the original seven-day/15-sample/seven-India-date observation window as a non-blocking post-release soak.
- [~] **P11.2 — Post-release human relevance sample**
  - For at least 30 OTT events and 20 physical releases, verify title, date, provider/format, region, and duplicate behavior.
  - Record errors by source and error type.
  - Keep incomplete evidence explicitly pending; do not treat it as a pass or block the beta release.
- [x] **P11.3 — Search-handoff sample**
  - Launch torrent search from at least 20 discovered titles across movies/series/languages.
  - Confirm clean title/year queries improve results and do not inject provider noise.
- [x] **P11.4 — Release acceptance metrics**
  - 0 undated torrents visible under an active date window.
  - 0 discovery rows falsely dated from `firstObservedAt`.
  - 0 current-availability records mislabeled as recently added.
  - Automatic Streaming Availability use stays under 300 requests in a 31-day projection and never exceeds the 450 hard cap.
  - One upstream failure still leaves other/cached feeds usable.
  - Track the 95% sampled high-confidence accuracy target as non-blocking post-release evidence until the human review completes.
- [x] **P11.5 — Release decision**
  - Ship if the metrics pass.
  - If a metric fails, fix normalization/cache/UI within this source stack first.
  - Consider another data source only when the execution log identifies a specific, repeated coverage gap that cannot be fixed locally.
- [~] **P11.6 — Final documentation state**
  - Mark phases complete, summarize known limitations, record the released version/commit, and set the next roadmap item.

### Exit gate

Two spaced operational samples and all release-blocking metrics pass, the full test/build/package suite is green, the monthly cost remains $0, and the plan's execution log names the release-ready version. The longer soak and human relevance review remain visible post-release work.

## 6. Testing strategy

### Test pyramid

1. **Pure unit tests:** dates, normalization, identity, dedupe, classification, ranking, request-budget arithmetic.
2. **Adapter fixture tests:** frozen upstream responses; no network.
3. **Service tests:** fake clock, fake filesystem/state directory, fake adapters, aborts, concurrency, partial failure.
4. **Ink UI tests:** navigation, filters, states, handoff.
5. **Opt-in live smoke tests:** one low-cost request per adapter, excluded from normal `npm test`.

### Required edge cases

- Empty/missing/malformed/future dates.
- Date exactly at the inclusive cutoff.
- India local date around UTC midnight.
- Same title and year with different media types.
- Remake with same title and different year.
- Provider addition on the same title at two services.
- Source disagreement on physical date.
- Catalog/provider rebrand.
- Cursor repeat and unexpectedly large pagination.
- Rate limit with and without `Retry-After`.
- Cache schema migration/corruption and interrupted atomic write.
- Terminal control characters in upstream title/description.
- Missing credentials and expired/invalid credentials.

## 7. Operational diagnostics

Expose enough information to explain the data without logging secrets:

```text
TMDb                     ready      refreshed 2h ago     3 requests
Blu-ray.com RSS          stale      refreshed 28h ago    feed timeout
Streaming Availability  ready      refreshed 6h ago     84/450 this month
```

Track these counters:

- request attempts, successes, failures, `429`s, and cache hits per source;
- fresh/stale snapshot age;
- rows received, accepted, rejected, and deduplicated;
- unknown dates and ambiguous identities;
- source disagreements;
- last successful refresh and last error code/message (sanitized).

Do not add general telemetry or transmit diagnostics anywhere. These are local only.

## 8. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Free tier/pricing changes | Local hard caps, source adapter isolation, contract decision record, cached partial UI |
| TMDb terms do not fit future monetization | Treat current use as non-commercial only; require licensing review before monetization |
| Blu-ray RSS changes or disappears | Fixture parser tests, 24-hour polling, cached data, TMDB generic physical fallback |
| OTT source misses a provider/change | Display supported provider coverage; measure gaps during beta; do not infer dates from current availability |
| API keys leak | Header auth, owner-only config, sanitization, fixture review, package inspection |
| Dates shift by timezone | Calendar-date representation and India-local boundary tests |
| False cross-source merge | External IDs first, exact year fallback, preserve ambiguous records separately |
| Too many top-level tabs | Reuse Trending as Discover with internal feed selectors |
| Discovery makes torrent search slower | Separate domain/cache/hooks; only search after explicit handoff |
| Quota exhausted by pagination/retries | Four-page cap, 12-hour TTL, attempted-call ledger, 350 warning/450 hard stop |
| Scraping/legal maintenance expands scope | No scraper in baseline; require a new decision record and measured gap |

## 9. Definition of done

This plan is complete only when all of the following are true:

- Torrent “last week” excludes unknown and out-of-window `added` dates.
- Torrent category filtering works and composes with date/size/seeder/match filters.
- Discover offers Trending, OTT, Blu-ray, and India feeds.
- OTT “recent” comes from a real India change event, not current availability.
- Blu-ray-specific labels have Blu-ray-specific evidence; generic data stays `physical`.
- India availability, Indian origin, and Indian language are separately represented.
- Missing dates never rank above known dates or pass active date windows.
- Source evidence, refresh age, stale state, attribution, and partial errors are visible.
- Discovery survives restart/offline mode from a versioned atomic cache.
- The local request ledger proves automatic usage remains within the free allowance.
- Selecting a discovery item launches a clean title/year torrent search.
- Default tests use fixtures only; full tests, typecheck, build, and package inspection pass.
- Setup, limitations, source terms, and credentials are documented.

## 10. Explicitly deferred follow-ups

Only consider these after Phase 11 measurements:

- Completing the seven-day operational soak and 30 OTT/20 physical human relevance review.

- An official JustWatch partner agreement.
- Watchmode paid endpoints.
- Firecrawl monitoring of a small permitted editorial calendar.
- Apify/JustWatch unofficial scraping.
- IMDb/Letterboxd/Rotten Tomatoes popularity or review signals.
- Background notifications, calendar export, watchlists, or a server-side index.
- Persisting every Discover UI preference.

Each follow-up requires its own cost, terms, privacy, and maintenance decision; none is necessary for the $0 release.

## Execution log

| Date | Phase/task | Result | Tests | Next action |
| --- | --- | --- | --- | --- |
| 2026-07-10 | Plan creation | Roadmap created from repository architecture and source research; implementation has not started | Documentation-only | P0.1 — create the source/terms decision record |
| 2026-07-10 | P0.1 | Added ADR 001 with credentials, terms, attribution, quotas, region limits, no-redistribution policy, restricted Blu-ray RSS use, and a Trakt no-go pending written approval | Primary-source documentation review; live Blu-ray RSS headers/XML inspected | P0.2 — define safe credential and transport conventions |
| 2026-07-10 | P0.2 | Added a names-only environment template, ignored local environment files, and documented precedence, masking, reserved Trakt state, and fixed direct Movie of the Night key handling | `git diff --check`; required-name/rule scan; `git check-ignore` for `.env`/`.env.local`; verified `.env.example` is tracked-eligible and all assignments are blank | P0.3 — probe only configured and contract-permitted live sources |
| 2026-07-10 | P0.3 (partial) | Recorded credential presence without values, preserved the day's permitted Blu-ray RSS evidence, and listed every proven/missing contract claim; TMDB and India changes remain unverified because their credentials are unset, while Trakt is skipped by ADR 001 | Credential presence-only check; prior live RSS HTTP/XML evidence reviewed; `git diff --check` | Export the TMDB token and complete Streaming Availability key/transport pair, then resume P0.3 after the RSS polling interval |
| 2026-07-10 | P0.3 (runner) | Added an opt-in, no-retry live probe with fixed hosts, same-layer OTT transport enforcement, bounded field-only summaries, no Trakt/RSS calls, and credential redaction | `npm test -- --run test/discovery-contract-spike.test.ts` (5 passed); `npm run typecheck`; unconfigured dry run made 0 requests | Export the required credentials and rerun P0.3; do not begin fixtures |
| 2026-07-10 | P0.3 blocked | Third consecutive check found TMDB and Streaming Availability unconfigured; the next allowed RSS comparison is after 2026-07-11 06:11 UTC, and all safe preparatory work is complete | Presence-only environment check at 06:26 UTC; no request sent | Export the three variables outside chat and resume P0.3 after the polling interval |
| 2026-07-10 | P0.3 resumed | User exported both credentials and fixed Streaming Availability to the direct developer platform; removed the transport variable and all RapidAPI runtime/design paths before probing | Presence-only credential check; direct-only diff pending verification | Verify direct-only contract, then run the bounded probe |
| 2026-07-10 | P0.3 direct probe | Streaming contract passed with India, 9 provider IDs, 25 joinable changes, cursor fields, and a real seconds timestamp; initial TMDB HTTP calls succeeded but did not prove India physical/provider details, so semantic completion was tightened and a TMDB-only bounded candidate probe added | 6 live requests, no retries or secrets; targeted runner tests (5 passed); typecheck | Run the TMDB-only semantic probe and record both outcomes |
| 2026-07-10 | P0.3 TMDB semantic probe | Proved India Digital type 4, Physical type 5, and watch-provider shapes with candidate validation; recorded that discover dates alone are insufficient row-level regional evidence | 7 live TMDB-only requests; runner tests (5 passed); typecheck; direct-only/search/whitespace checks; credential leak scan clean | Record dashboard allowance, then compare RSS after 2026-07-11 06:11 UTC |
| 2026-07-10 | P0.3 local budget | User confirmed a 500-call monthly envelope, warning at 350, hard stop before call 451, and 50-call safety margin; provider allowance remains undisclosed by response headers and is not claimed | Runner tests (5 passed); typecheck; `git diff --check` | Run the conditional RSS comparison after 2026-07-11 06:11 UTC |
| 2026-07-10 | P0.4 | Added small sanitized TMDB, Streaming Availability, and Blu-ray RSS fixtures with movie/series, Indian-language, unknown-date, missing-ID/GUID, and duplicate-title cases; documented capture provenance and the ADR-driven Trakt omission | `npm test -- --run test/discovery/fixtures.test.ts` (4 passed); `npm run typecheck`; `git diff --check` | P0.5 — decide source go/no-go outcomes and reconcile the remaining RSS risk |
| 2026-07-10 | P0.5 | Accepted ADR 002: TMDB conditional go, India changes go, restricted unknown-region Blu-ray RSS pilot, and Trakt no-go; audited normalized-field provenance and replaced later Trakt assumptions with generic TMDB physical fallback | Discovery fixture + contract-spike tests (9 passed); `npm run typecheck`; `git diff --check`; Phase 0 exit-gate review | P1.1 — require a finite known added date under an active date window |
| 2026-07-10 | P1.1 | Active date windows now require a finite known `added` timestamp at or after the inclusive cutoff; All still retains undated/invalid rows | `npm test -- --run test/filters.test.ts` (18 passed); `npm run typecheck`; `git diff --check` | P1.2 — make missing/invalid dates sort below known dates in both directions |
| 2026-07-10 | P1.2 | Date sorting now keeps finite dates above missing/invalid dates in both ascending and descending modes while retaining existing deterministic tiebreakers | `npm test -- --run test/search.test.ts` (11 passed); `npm run typecheck`; `git diff --check` | P1.3 — extract reusable category normalization without changing mappings |
| 2026-07-10 | P1.3 | Extracted reusable torrent category types, normalization, and filtering from Trending; existing aliases and `other` fallback remain unchanged | `npm test -- --run test/trending.test.ts` (10 passed); `npm run typecheck`; `git diff --check` | P1.4 — add category state, composition, cycle key, and active label |
| 2026-07-10 | P1.4 | Added the complete category union to search filter state, hard-filter composition, `c` cycling, reset/count behavior, `Other`, help/footer hints, and inline category summary | Filter + Trending suites (30 passed); `npm run typecheck`; `git diff --check` | P1.5 — show how many undated rows an active date window hides and explain why |
| 2026-07-10 | P1.5 | Active date windows now expose an undated-hidden count when width permits, count missing/non-finite dates consistently, and explain the known source-added-date rule in help | `npm test -- --run test/filters.test.ts` (21 passed); `npm run typecheck`; `git diff --check` | P1.6 — finish boundary/future/invalid/composed-filter and bidirectional-sort coverage |
| 2026-07-10 | P1.6 | Added exact-boundary, one-second-outside, future-date, missing/invalid, category+date composition, All-restoration, Other, and bidirectional known-first sort coverage; Phase 1 exit gate passes | Prescribed Filter/Search/Trending suites (43 passed); full suite (359 passed); `npm run typecheck`; `git diff --check` | P2.1 — add pure normalized discovery types without torrent/UI coupling |
| 2026-07-10 | P2.1 | Added pure normalized catalog-title, release-event, source-evidence, date/status, media/release-kind, and region types with explicit `ZZ` unknown-region semantics and no torrent/UI dependency | `npm test -- --run test/discovery/types.test.ts` (2 passed); `npm run typecheck`; dependency scan; `git diff --check` | P2.2 — define the shared adapter and snapshot contract |
| 2026-07-10 | P2.2 | Added the generic discovery adapter contract with identity/configuration, capabilities, injected fetch/abort options, normalized snapshots, cursors, timestamps, and non-fatal warnings | `npm test -- --run test/discovery/adapter.test.ts` (1 passed); `npm run typecheck`; `git diff --check` | P2.3 — define source-independent feed requests and validate their bounds |
| 2026-07-10 | P2.3 | Added typed region/feed/date/media/provider/page/cursor requests with pre-adapter validation for real dates, ordering, 31/366-day windows, four pages, provider count/shape, and cursor bounds | Discovery request + adapter suites (5 passed); `npm run typecheck`; `git diff --check` | P2.4 — centralize strict date-only parsing, India today, windows, comparison, and status |
| 2026-07-10 | P2.4 | Added strict non-normalizing date-only parsing, India-local today, inclusive windows, known-first comparison, and release status; request validation now reuses the date parser | Date + request suites under `TZ=UTC` and `TZ=Asia/Kolkata` (10 passed each); `npm run typecheck`; `git diff --check` | P2.5 — normalize provider aliases and supported language labels |
| 2026-07-10 | P2.5 | Added canonical provider IDs/labels with preserved upstream aliases and unknown-provider fallback, plus ISO/display normalization for the ten required languages | `npm test -- --run test/discovery/normalize.test.ts` (4 passed); `npm run typecheck`; `git diff --check` | P2.6 — exercise the common contract with fixture-backed fake adapters and audit the Phase 2 gate |
| 2026-07-10 | P2.6 | Added fixture-backed TMDB/Blu-ray/Streaming fake adapters that preserve region, provider, date precision, format, cursor, and evidence through one contract; represented Trakt only as an unconfigured ADR no-go stub | All discovery suites under `TZ=UTC` and `TZ=Asia/Kolkata` (28 passed each); `npm run typecheck`; domain dependency scan; `git diff --check` | P3.1 — define independently recoverable versioned cache entries |
| 2026-07-10 | P3.1 | Added a versioned cache document with stable source/request keys, request descriptors, normalized snapshots, expiry/stale bounds, and independent deep runtime validation/rejection per entry | `npm test -- --run test/discovery/cache.test.ts` (4 passed); `npm run typecheck`; `git diff --check` | P3.2 — persist entries atomically with serialized/coalesced writes and recovery |
| 2026-07-10 | P3.2 | Added a separate discovery-cache path and repository with atomic JSON, serialized/coalesced writes, mixed-corruption recovery, dirty-state retry, lookup/removal, and flush | Cache format/repository + atomic suites (10 passed); `npm run typecheck`; `git diff --check` | P3.3 — persist and enforce monthly request attempts by source/endpoint |
| 2026-07-10 | P3.3 | Added an owner-only versioned UTC-month ledger with per-source/endpoint attempts, fixed 350/450 Streaming thresholds, pre-451 refusal, rollover, concurrent cap safety, and structural Trakt blocking | Budget + atomic suites (7 passed); `npm run typecheck`; `git diff --check` | P3.4 — orchestrate fresh/stale/expired cache and deduplicated refreshes |
| 2026-07-10 | P3.4 | Added fresh-cache short-circuiting, stale immediate return plus lifecycle refresh promise, foreground miss/expired refresh, last-good retention on failure, success-only writes, and identical-refresh dedupe | Service + cache repository suites (7 passed); `npm run typecheck`; `git diff --check` | P3.5 — expose independent adapter states and aggregate warnings without blanking peers |
| 2026-07-10 | P3.5 | Added independent ready/refreshing/stale/unconfigured/quota-paused/failed states, settled stale-refresh transitions, source-attributed warnings, and partial aggregation that keeps usable peers | State + service suites (8 passed); `npm run typecheck`; `git diff --check` | P3.6 — fill resilience edge cases and prove the fake-adapter Phase 3 gate |
| 2026-07-10 | P3.6 | Added corrupt-JSON recovery and abort propagation coverage; audited fresh/stale/expired, schema/corruption, atomic recovery, dedupe, rollover/retries/caps, offline retention, partial failure, and quota-paused behavior | Prescribed Phase 3 suites (21 passed); all discovery suites (49 passed); `npm run typecheck`; `git diff --check` | P4.1 — add TMDB credential precedence and safe configuration descriptor |
| 2026-07-10 | P4.1 | Added environment-first TMDB resolution, owner-only config coercion/edit/clear support, compact masked Settings integration, and one body-free `/authentication` probe with token-safe outcomes | TMDB config + config persistence + app integration suites (18 passed); `npm run typecheck`; `git diff --check` | P4.2 — add bounded resilient TMDB transport and row-level runtime guards |
| 2026-07-10 | P4.2 | Added resilient bearer TMDB transport with injected fetch/abort/sleep, per-attempt ledger metering, four-page hard bound, token-safe failures, and runtime guards for list/release/provider payloads with row warnings | TMDB client + budget suites (8 passed); `npm run typecheck`; `git diff --check` | P4.3 — map weekly trending and India digital/physical feeds with exact regional evidence |
| 2026-07-10 | P4.3 | Added one-page weekly Trending and deterministic India type-4/type-5 movie discovery calls; excluded people and mapped candidates with honest unknown dates/inferred evidence until regional detail is verified; type 5 remains `physical` | TMDB adapter + client suites (7 passed); `npm run typecheck`; `git diff --check` | P4.4 — lazily verify regional dates/providers/IDs with seven-day enrichment caching |
| 2026-07-10 | P4.4 | Added explicit field-selective metadata/external-ID/regional-release/watch-provider enrichment, seven-day cache by media type + TMDB ID, per-field dedupe, and unsupported-series release warnings; provider presence creates no recent-add event | TMDB enrichment + feed suites (6 passed); `npm run typecheck`; `git diff --check` | P4.5 — expose TMDB source URLs/notices and document required attribution |
| 2026-07-10 | P4.5 | Added cache-safe TMDB attribution metadata, canonical title links, exact notice, approved-logo guidance, JustWatch provider notice, and terminal/graphical implementation documentation | TMDB adapter + cache + service suites (13 passed); `npm run typecheck`; `git diff --check` | P4.6 — fill TMDB malformed/auth/quota/abort/page-cap cases and prove the Phase 4 gate |
| 2026-07-10 | P4.6 | Added 401, 429/Retry-After, per-retry metering, abort, and first-fetch/cache coverage; audited movie/series/person, missing dates, region/type semantics, malformed rows, enrichment, attribution, and page caps | Targeted TMDB suites (14 passed); all discovery suites (66 passed); `npm run typecheck`; `git diff --check` | P5.1 — implement the restricted, unknown-region Blu-ray RSS adapter |
| 2026-07-10 | P5.1 | Added one-fetch resilient/metered Blu-ray RSS mapping under the 24-hour cache policy, advertised-day parsing, explicit Blu-ray/4K classification, generic fallback, `ZZ` region, unknown-date retention, and attribution links | Blu-ray + cache suites (7 passed); `npm run typecheck`; `git diff --check` | P5.2 — add stable identity fallbacks, invalid-date retention, and terminal-safe text hygiene |
| 2026-07-10 | P5.2 | Added HTML/control/ANSI-safe RSS text, unsafe-link rejection, GUID-first/link/hash identity fallbacks, and explicit unknown-date retention without losing titles | `npm test -- --run test/discovery/bluray.test.ts` (4 passed); `npm run typecheck`; `git diff --check` | P5.3 — confirm the existing ADR skip and proceed without Trakt code/network work |
| 2026-07-10 | P5.3 | Confirmed ADR 002’s deliberate Trakt skip; no host/header/adapter/fixture exists and the ledger retains a zero hard cap | Source/fixture scan; no network request or code path added | P5.4 — cautiously match RSS records to cached TMDB titles by normalized title + exact year |
| 2026-07-10 | P5.4 | Added direct-ID preference and zero-network cached-TMDB enrichment requiring normalized title + exact year + one unique identity; missing/conflicting/ambiguous records stay standalone | `npm test -- --run test/discovery/bluray.test.ts` (6 passed); `npm run typecheck`; `git diff --check` | P5.5 — merge same-date/format evidence and preserve conflicting physical claims |
| 2026-07-10 | P5.5 | Added canonical physical claim grouping, UHD separation, identical region/date/format evidence merge, same-date Blu-ray specificity, and conflicting-claim retention with confidence-based display/disagreement state | Physical + Blu-ray suites (10 passed); `npm run typecheck`; `git diff --check` | P5.6 — fill XML/entity/duplicate/malicious/fallback/offline cases and prove the Phase 5 gate |
| 2026-07-10 | P5.6 | Added single-item/entity variants, exact GUID duplicate suppression, generic physical fallback, active-window unknown exclusion, and offline stale RSS coverage; audited IDs/dates/4K/sanitization/conflicts and ADR Trakt skip | Physical + Blu-ray suites (13 passed); all discovery suites (79 passed); `npm run typecheck`; `git diff --check` | P6.1 — implement the fixed direct developer-host/key transport only |
| 2026-07-10 | P6.1 | Added environment-first/owner-only streaming key resolution and one fixed direct-host `X-API-Key` client with path confinement, no marketplace header/selector/fallback, per-attempt metering, resilient fetch, abort, and token-safe errors | Streaming client + discovery/config persistence suites (20 passed); `npm run typecheck`; `git diff --check` | P6.2 — parse the live India service dictionary and cache provider IDs/labels for 30 days |
| 2026-07-10 | P6.2 | Added India country/service guards, live-name-preserving canonical providers (including unknown/rebranded services), adapter attribution, and persistent 30-day-fresh/90-day-retained dictionary caching | Provider dictionary + normalize/cache/state suites (14 passed); `npm run typecheck`; `git diff --check` | P6.3 — query and map bounded India `new` show changes using source timestamps |
| 2026-07-10 | P6.3 | Added exact India `new`/`show` queries with no `show_type`, optional live catalogs, India-midnight `from`, bounded cursor work, movie/series joins, and exact source-second `streaming_added` dates; millisecond/observation substitutions are rejected | OTT client/dictionary/change suites (7 passed); `npm run typecheck`; `git diff --check` | P6.4 — add bounded supported-service upcoming calls below the warning threshold |
| 2026-07-10 | P6.4 | Added one-page future-window upcoming requests limited to documented providers, separate known/unknown-date events, and pre-request soft-threshold refusal at 350 attempts | Upcoming + provider suites (6 passed); `npm run typecheck`; `git diff --check` | P6.5 — retain included show IDs/type/year/language/countries/genres/images and option metadata without N+1 calls |
| 2026-07-10 | P6.5 | Joined included show dictionaries in-page and preserved original/external identity, type/year, normalized language/country/genre data, role-specific HTTPS images, provider deep links, access type, and optional audio/subtitle languages without per-show requests | `npm test -- --run test/discovery/streaming-changes.test.ts` (4 passed); `npm run typecheck` | P6.6 — add cursor-loop protection, event dedupe, and overlap-safe resume metadata |
| 2026-07-10 | P6.6 | Retained the full country/provider/change/item/show/timestamp event identity, deduplicated events across pages, broke repeated-cursor loops without republishing the bad continuation, and persisted a source-seconds refresh watermark with a one-hour safety overlap | Streaming changes + cache suites (9 passed); `npm run typecheck` | P6.7 — classify auth, quota/retry, and contract failures while retaining valid cache |
| 2026-07-10 | P6.7 | Added cache-retaining `auth-failed` classification for 401/403, parsed terminal `Retry-After` timing into quota-paused states, surfaced contract drift distinctly, and confirmed the atomic ledger refuses call 451 | State + streaming client suites (12 passed); existing budget cap/concurrency coverage; `npm run typecheck` | P6.8 — complete the streaming edge-case matrix and prove the Phase 6 exit gate |
| 2026-07-10 | P6.8 | Completed the OTT matrix for multi-provider movie/series joins, missing shows, repeated cursors, duplicate events, four-page/31-day bounds, 429 timing, pre-network hard caps, fixed direct transport, and streaming-specific stale-cache retention; the adapter answers India additions from source timestamps within a four-call automatic maximum | Focused matrix (34 passed); all discovery suites (99 passed); `npm run typecheck`; `git diff --check` | P7.1 — implement conservative canonical identity over cached snapshots |
| 2026-07-10 | P7.1 | Added pure cached-snapshot canonicalization with media-scoped TMDB-first and conflict-safe IMDb matching, exact normalized-title/year fallback, deterministic metadata union, source-title remapping, and ambiguous/unresolved counters; ambiguous identities remain separate | Identity + normalization + Blu-ray suites (16 passed); `npm run typecheck` | P7.2 — merge duplicate canonical events without erasing meaningful distinctions |
| 2026-07-10 | P7.2 | Added post-identity event canonicalization that merges exact semantic duplicates, unions evidence/languages and observation bounds, and retains provider, region, kind, format, access-mode, and conflicting-date distinctions | Event identity + canonical title + physical suites (11 passed); `npm run typecheck` | P7.3 — implement exact-known-date window filtering and direction-aware stable sorting |
| 2026-07-10 | P7.3 | Added honest aggregated date selection: active windows require in-range day precision, All retains imprecise/unknown dates below every known date, past sorts newest-first, upcoming soonest-first, and ties are stable | Aggregate date + date-domain suites (9 passed); `npm run typecheck` | P7.4 — classify the four feeds without inventing recency, region, or format claims |
| 2026-07-10 | P7.4 | Persisted cache-validated snapshot feed provenance, then classified actual TMDB trending titles without release claims, streaming-only OTT events, explicit Blu-ray/UHD with opt-in generic physical fallback, and region-IN events with origin-country-only Indian narrowing | Feed classification + adapter/cache suites (31 passed); `npm run typecheck` | P7.5 — add canonical feed filters while keeping genre separate from media type |
| 2026-07-10 | P7.5 | Added one pure hard-filter pass for media type, canonical genre, provider, day-precise range, release format, normalized original/audio language, and Indian origin; provider/format/date filters require event evidence and coarse media remains independent of genre | Aggregate filter/feed/date suites (16 passed); `npm run typecheck` | P7.6 — add the deterministic date/confidence/popularity/title ranking cascade |
| 2026-07-10 | P7.6 | Added post-filter deterministic ranking: known event date in feed direction, exact/source-claim/inferred confidence, popularity only as a late tiebreaker, then stable title and ID; older popularity cannot outrank newer release evidence | Aggregate ranking/filter/date suites (13 passed); `npm run typecheck` | P7.7 — add aggregate conflict and contribution diagnostics |
| 2026-07-10 | P7.7 | Added canonical diagnostics for ambiguous/unresolved identity, unknown dates, semantic date-conflict groups, collapsed duplicates, orphaned event metadata, and zero-filled per-source snapshot/title/event/evidence contribution counts | Diagnostic + event + identity suites (7 passed); `npm run typecheck` | P7.8 — prove the fixture-only deterministic four-feed golden scenarios |
| 2026-07-10 | P7.8 | Added the pure `aggregateDiscoverySnapshots` UI boundary and fixture-only golden scenarios proving deterministic four-feed output, honest last-week dates, date-over-popularity ranking, no availability-to-arrival conversion, origin-based Indian classification, and two-provider events under one title | Aggregate suites (30 passed); all discovery suites (129 passed); `npm run typecheck`; `git diff --check` | P8.1 — evolve Trending into Discover incrementally |
| 2026-07-10 | P8.1 | Changed the user-facing wide/compact tab and help labels to Discover/Disc while retaining the internal `trending` view key, tab order, route, component, and hook names for incremental migration | Navigation + app render tests (2 passed); `npm run typecheck` | P8.2 — add screen-local discovery state before replacing legacy browse rendering |
| 2026-07-10 | P8.2 | Added reducer-backed screen-local state for feed, media, date window, provider, language, format, Indian-title toggle, row cursor, and details visibility; result-changing actions reset/clamp selection and close stale details, while reset preserves the current feed | Discovery state + navigation suites (5 passed); `npm run typecheck` | P8.3 — render canonical discovery rows and per-adapter freshness/status summaries |
| 2026-07-10 | P8.3 | Replaced the routed legacy torrent-browse renderer with canonical Discover rows, feed-specific bounded/cache-backed targets, incremental per-target progress, last-refresh and ready/stale/auth/quota/partial status text, and date/title/provider-format/language/source columns with no torrent metrics or actions | Discover content/state/navigation/app/date suites (15 passed); `npm run typecheck`; `git diff --check` | P8.4 — add the full discovery details overlay and disagreement disclosure |
| 2026-07-10 | P8.4 | Added Enter/Esc discovery details with full canonical title/event/region/provider-format/language/country/genre metadata, audio/subtitles, evidence confidence, safe source links, cached required attribution, and same-claim conflicting-date warnings | Discover details/content + state suites (8 passed); `npm run typecheck` | P8.5 — implement clean title/year torrent-search handoff with preserved Discover state |
| 2026-07-10 | P8.5 | Bound `s` to the existing search submission path using only sanitized title plus optional year, switched to Torrent Search through that contract, and kept Discover mounted/inactive off-tab so cursor/filter/details state survives return without background source calls | Discover content/app/state/navigation suites (12 passed); `npm run typecheck`; `git diff --check` | P8.6 — add precise configuration, filtered-empty, no-event, and offline-no-cache guidance |
| 2026-07-10 | P8.6 | Added distinct filtered-empty, no-event-window, offline/no-cache, and unconfigured/auth guidance; named exact TMDB/Streaming environment variables and Settings fields, advertised credential-free Blu-ray, and added owner-only Streaming Availability key edit/clear support in Settings | Discover empty-state + app/settings suites (12 passed); `npm run typecheck`; `git diff --check` | P8.7 — finish the UI interaction matrix and prove the Phase 8 gate |
| 2026-07-10 | P8.7 | Completed interaction coverage for feed/media/window switching, cursor/state preservation, narrow terminals, loading/stale/quota/offline/config states, details open/close, clean search handoff, and ignored torrent-only keys; verified existing Search, Sources, Settings, and debrid screens remain green | Discover UI matrix (18 passed); full suite (498 passed); `npm run typecheck`; `git diff --check` | P9.1 — build India provider UI groups from the cached live dictionary |
| 2026-07-10 | P9.1 | Added the 30-day cached live provider-dictionary target to OTT/India, merged normalized provider IDs with unioned upstream aliases and latest live labels, preserved unknown services, and exposed an All/live `p` cycle scoped so provider state cannot filter Trending/Blu-ray | Discover/provider/normalize suites (19 passed); `npm run typecheck` | P9.2 — add ordered language choices with original/audio distinctions |
| 2026-07-10 | P9.2 | Added the exact All/Hindi/Kannada/Tamil/Telugu/Malayalam/Bengali/Marathi/Punjabi/Gujarati/English/Other order, original-or-explicit-audio filtering including Other, and row labels that keep original language primary while marking additional audio separately | Discover language + aggregate filter/normalize suites (24 passed); `npm run typecheck` | P9.3 — enforce precise India feed composition and unknown-region exclusion |
| 2026-07-10 | P9.3 | Exposed the default Available-in-India mode and `i` origin-country narrowing, kept regional OTT primary with explicit TMDB Digital/Physical labels, and proved non-Indian IN availability remains by default while `ZZ` Indian Blu-ray claims never leak into India | Discover India + feed/golden suites (26 passed); `npm run typecheck` | P9.4 — align 7/30-day recent/upcoming and all-cached choices |
| 2026-07-10 | P9.4 | Added explicit Recent/Upcoming 7d/30d and All cached labels, exact inclusive request bounds, no fake Trending window, and retained-cache selection that merges relevant recent/upcoming/provider/regional snapshots while excluding expired and wrong-region entries; unknown dates remain last | Discover window/cache + aggregate date/golden/cache suites (30 passed); `npm run typecheck` | P9.5 — add the full India fixture matrix |
| 2026-07-10 | P9.5 | Added a credential-free normalized India snapshot matrix covering Hindi movie, Tamil series, English Indian title, non-Indian Hindi title, global IN arrival, Hotstar/JioHotstar alias history, unknown provider, and missing country/language; proved origin/language/media/provider behavior without inference | India matrix + fixture/golden suites (13 passed); `npm run typecheck` | P9.6 — record manual sampled-week coverage and mismatches without copying content |
| 2026-07-10 | P9.6 | Recorded a privacy-bounded 4–10 July India sample: one ledgered/no-retry page returned 25 dated movie/series events and a continuation cursor; compared aggregate coverage with official Netflix, Amazon India, and JioStar editorial sources, documenting truncation, first-page provider skew, missing language metadata, and why no completeness claim is possible; added an aggregate-only opt-in validator and report safety test | Validation report test + India matrix (4 passed); full suite (508 passed); `npm run typecheck`; `git diff --check`; one opt-in live request | P10.1 — audit offline and partial-failure states without misleading empty results |
| 2026-07-10 | P10.1 | Exercised offline with/without retained cache, one/all adapter failures, invalid cache JSON, and quota-paused OTT across cache/service/state/Ink boundaries; degraded empty feeds now say results are unavailable/incomplete and distinguish offline, quota, partial, unconfigured, filtered, and genuine empty-window states instead of claiming zero results | Reliability matrix (38 passed); `npm run typecheck`; `git diff --check`; audit recorded in `docs/discovery-reliability-audit.md` | P10.2 — audit secret handling, cache privacy, permissions, and terminal sanitization |
| 2026-07-10 | P10.2 | Added a universal cache/render snapshot sanitizer plus credential-aware authenticated-adapter scrubbing, token-safe transport errors, secret-bearing source-link removal, C0/C1/bidi control removal, credential-field cache rejection, owner-only cache writes, sanitized direct-cache reads, and final Ink text hygiene; recorded a names-only live-state scan with two configured credentials and zero workspace/cache/ledger hits | Security/cache/config/format matrix (92 passed); `npm run typecheck`; `git diff --check`; static query/fixture scans clean; audit recorded in `docs/discovery-security-audit.md` | P10.3 — audit rate-limit accounting/coalescing/caps and add local usage diagnostics |
| 2026-07-10 | P10.3 | Audited per-attempt retry metering, identical-refresh coalescing, fresh/stale/expired and provider-dictionary TTLs, request/cursor page bounds, Retry-After, concurrent attempt-450 admission, and pre-451 refusal; added read-only `minch --discovery-status` with per-source used/limit/remaining counters and no credential/network/TUI access | Rate-limit matrix (51 passed); `npm run typecheck`; `git diff --check`; command run twice remained at Streaming 1/450; audit recorded in `docs/discovery-rate-limit-audit.md` | P10.4 — add source attribution and licensing/completeness documentation |
| 2026-07-10 | P10.4 | Centralized the exact TMDB/JustWatch/source-claim notices; added credits and source links to CLI/Ink help, all loaded attribution metadata plus additional notices and completeness caveat to Discover details, and a README discovery/accuracy/legal section covering Movie of the Night, Blu-ray.com, source-claimed dates, TMDB non-commercial terms, and the pre-monetization licensing gate | Attribution surface/details/help suites (29 passed); `npm run typecheck`; `git diff --check`; manual `--help` output; current official TMDB FAQ/API terms and Movie of the Night attribution terms reviewed | P10.5 — document setup, cache/refresh/quota behavior, limitations, and adapter disabling |
| 2026-07-10 | P10.5 | Added a complete credential-free Blu-ray → TMDB → optional OTT setup guide with official signup links, env/Settings precedence, platform cache/config paths, TTL/retention table, quota/diagnostic behavior, limitations, and safe reset notes; implemented persistent independent adapter toggles (including credential-free Blu-ray), disabled-source cache exclusion/status, and cursor-windowed Settings rows so every toggle remains reachable | Setup/config/state/Settings matrix (55 passed); `npm run typecheck`; `git diff --check`; documentation requirement test | P10.6 — run full tests, typecheck, build, and package-content inspection |
| 2026-07-10 | P10.6 | Passed the complete offline suite/type/build/package gate; production CLI version/help/usage commands run successfully; package inspection caught and fixed omitted linked docs, then proved the 97-file payload includes setup docs but excludes source/tests/env/plans and contains zero occurrences of either configured credential | `npm test` (531 passed); `npm run typecheck`; `npm run build`; built CLI smoke; `npm pack --dry-run`; 97-file package manifest and configured-value scan clean; `git diff --check` | P11.1 — start the seven-day beta with clean state and durable local metrics |
| 2026-07-10 | P11.1 started | Added an isolated 12-hour beta runner/report with 10-hour no-op guard, seven-day/15-sample/7-India-date finalization gate, owner-only cache/ledger/report, counter-only output, hashed unique identities, and status/finalize commands; first sample used fresh ignored state and policy-deferred Blu-ray, recording TMDB 3 + OTT 5 attempts, 5 successful refreshes, 0 errors/stale periods, 123 unique titles, 106 events, 20 unknown dates, and 0 ambiguous merges | Beta/report tests (2 passed); `npm run typecheck`; `git diff --check`; first live sample + immediate no-op/status; three beta files mode 0600 with zero credential/report-content leaks | Continue P11.1 after 2026-07-11 04:15 UTC with Blu-ray still skipped until 06:11 UTC |
| 2026-07-10 | P11.1 scheduler guard | Audited the running beta before sample 2 was due and added an owner-only cross-process lock so overlapping schedulers cannot duplicate refreshes; a one-hour stale-lock boundary permits crash recovery, and the early-run no-op remains request-free | Beta lock/report suite (3 passed); `npm run typecheck`; `git diff --check`; live early no-op retained sample 1 and request totals | Continue P11.1 after 2026-07-11 04:15 UTC with Blu-ray still skipped until 06:11 UTC |
| 2026-07-11 | P11.1 time-blocked | Third consecutive continuation found the same required elapsed-time blocker: authoritative UTC was 2026-07-10 18:36, sample 2 remained 9h39m early, and the healthy report stayed at 1/15 samples with unchanged request/error metrics; no early call or synthetic observation was made | Read-only UTC clock + beta status; report remained 1 sample, TMDB 3, OTT 5, Blu-ray 0, errors 0 | Resume after 2026-07-11 04:15 UTC; keep Blu-ray skipped until 06:11 UTC |
| 2026-07-11 | P11.2 started | Added a deterministic canonical relevance-review workflow with provider/format and media interleaving, five-field pass/error/unverifiable judgments, source/error aggregates, an event-level high-confidence metric, a 30/20 completion gate, and owner-only resumable local evidence; initialized 30 OTT rows from 86 cached events without network work, retaining every raw source timestamp and proving all 30 India-date conversions match, while physical remains 0/20 until the permitted Blu-ray poll | Relevance + beta suites (5 passed); `npm run typecheck`; `git diff --check`; live-cache init and timestamp audit; mode-0600 review state | Review the queued 30 OTT rows; after 06:11 UTC refresh Blu-ray once, reinitialize to add 20 physical rows, then finalize P11.2 |
| 2026-07-11 | P11.2 blocked | Third consecutive continuation found the same external evidence blocker: authoritative UTC was 03:03, sample 2 remained early until 04:15, Blu-ray remained policy-deferred until 06:11, and the required human judgments remained 0/30 OTT and 0/20 physical; no judgment or upstream observation was synthesized | Read-only beta/relevance status; request totals unchanged; `git diff --check` | A human reviews the queued OTT rows; resume after 04:15 for sample 2 and after 06:11 for the one permitted Blu-ray refresh |
| 2026-07-11 | P11.3 | Added a resumable owner-only 20-title handoff review using the shared production query builder and bounded enabled public sources; the live sample covered 13 movies, 7 series, and 9 known languages, with 10 passes, 5 ambiguous/wrong-work errors, and 5 no-result unverifiable rows. Production queries appended provider/format noise 0/20 times; a validation-only paired baseline across all 13 eligible rows returned 126 relevant results for clean title/year queries versus 0 with discovery metadata appended (6 clean wins, 7 ties, 0 noisy wins) | Handoff/Discover suites (22 passed); full suite (538 passed); `npm run typecheck`; `npm run build`; `git diff --check`; 20 live clean launches + 13 paired noise baselines; owner-only final review state | P11.1 — take sample 2 now that the 10-hour guard has elapsed; continue P11.2 human review and post-06:11 Blu-ray evidence separately |
| 2026-07-11 | P11.1 sample 2 | Took the first due 12-hour follow-up after the 10-hour guard; retained the pre-06:11 Blu-ray skip and recorded a healthy partial run with cumulative TMDB 6 + OTT 9 attempts, 9 successful refreshes, 1 stale period, 0 source errors, 134 unique titles, 116 events, 25 unknown dates, and 0 ambiguous merges | Live beta sample + status; no early call; next sample scheduled for 16:30 UTC | After 06:11 UTC refresh Blu-ray for P11.2; take P11.1 sample 3 after 16:30 UTC |
| 2026-07-11 | P11.4 started | Added a read-only pass/fail/pending acceptance evaluator that directly exercises production torrent-date, discovery-date, availability-only, and partial-failure boundaries; audits all 210 retained cache events (170 dated) for source-specific date/change evidence; combines them with the live beta, relevance review, and ledger; projects 31-day Streaming use from bootstrap plus maximum recurring work; and refuses finalization while evidence is incomplete. Current evidence passes 5/6 metrics with zero cache provenance violations, a 249-call projection, and the enforced 450 cap; high-confidence accuracy and the seven-day window remain pending | Acceptance/reliability matrix (49 passed); full suite (543 passed); `npm run typecheck`; `npm run build`; `git diff --check`; live cache/status audit + expected finalize refusal | After 06:11 UTC refresh Blu-ray and extend P11.2; retain P11.4 as in progress until the 30/20 review and seven-day beta complete |
| 2026-07-11 | P11.2 physical-refresh guard | Added a dedicated counter-only Blu-ray RSS refresh for the isolated beta cache because the beta sample guard correctly forbids an early sample solely to fill physical evidence; it shares the scheduler lock, enforces the recorded 06:11 UTC not-before boundary, uses the normal ledger and 24-hour cache, and calls neither TMDB nor Streaming Availability. A live early invocation refused before any request and left Blu-ray attempts at 0; fixture execution proves one permitted fetch then a zero-request repeat. Stabilized the existing concurrent-download test to validate per-entry bytes instead of race-dependent filename ownership after the full gate exposed that unrelated flaky assertion | Physical/cache/relevance/beta matrix (21 passed); manager suite repeated 10 times; full suite (545 passed); `npm run typecheck`; `npm run build`; `git diff --check` | Run `refresh:discovery-physical` once after 06:11 UTC, then `review:discovery -- init`; do not create beta sample 3 before 16:30 UTC |
| 2026-07-11 | Phase 11 external wait confirmed | Authoritative UTC remained 04:43 after all safe preparation: beta stayed healthy at 2/15 samples, Blu-ray attempts remained 0 before the 06:11 boundary, and relevance judgments remained 0/30 OTT plus 0/20 physical. The repeated blocker is now solely external elapsed time plus required human source review; no early request or synthetic judgment was made | Read-only clock, beta/relevance status, Blu-ray ledger, and `git diff --check`; implementation gate remains 545 passing tests from the preceding run | A human records the queued OTT judgments; after 06:11 run the physical refresh/init and review those rows; resume the beta after 16:30 UTC and continue through 17 July |
| 2026-07-11 | P11 release gate revised | Accepted two refresh-interval-separated samples as the beta-release operational gate and moved the seven-day soak plus 30/20 human relevance review to explicit non-blocking post-release evidence; acceptance now marks every metric as release-blocking or informational, retained accuracy as pending rather than passing it, and finalized successfully with all five blocking metrics green. Prepared v0.2.0 release notes and version metadata | Targeted gate tests (8 passed); full suite (545 passed); `npm run typecheck`; `npm run build`; built `--version`/`--help`; live acceptance status/finalize; `npm pack --dry-run` (100 files); package scan found 0 occurrences of either configured credential; `git diff --check` | Commit/tag v0.2.0 and authenticate to npm before publishing; continue the soak and relevance review afterward |
