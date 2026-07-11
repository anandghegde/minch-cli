# Apify-Only Release Discovery Plan

> An alternative, resumable implementation plan for `minch-cli` in which every external release-discovery dataset is obtained through an Apify Actor. The CLI talks only to Apify's Actor/run/dataset APIs; it does not call TMDb, Trakt, JustWatch, FlixPatrol, Blu-ray.com, RSS feeds, or editorial sites directly.

## Plan control

| Field | Value |
| --- | --- |
| Plan status | Ready for proof-of-concept |
| Current phase | Phase 0 — Actor audit and capped proof runs |
| Next task | PA0.1 — create the Actor decision record and verify active pricing/input/output for the provisional Actors |
| Last researched | 2026-07-10 |
| Primary region | India (`IN`) |
| Cost posture | Paid-capable, budgeted, and fail-closed |
| Recommended pilot ceiling | **$4.50/month** so it can fit inside Apify Free's current $5 usage credit |
| Recommended production plan | Apify Starter only after the pilot proves coverage and reliability |

### Status legend

- `[ ]` not started
- `[~]` in progress
- `[x]` completed and verified
- `[!]` blocked; record the exact reason in the execution log
- `[-]` deliberately skipped; record the decision in the execution log

### How to resume this plan

At the start of each implementation session:

1. Read **Plan control**, **Phase status**, and the latest row in **Execution log**.
2. Inspect the worktree and preserve unrelated changes.
3. Continue the first `[~]` task; otherwise start the first `[ ]` task in the current phase.
4. Do not start a billable Actor run unless its task specifies a per-run cap and the local monthly budget permits it.
5. Do not advance a phase until its exit gate passes.
6. Before stopping, update task markers, `Current phase`, `Next task`, test results, cost-to-date, and the execution log.

Every phase is intended to be independently testable and committable. Actor proof runs are separate from production integration so a weak community Actor can be rejected without rewriting the application.

## Phase status

| Phase | Outcome | Status | Depends on |
| --- | --- | --- | --- |
| 0 | Audit Actors, terms, pricing, India support, and output contracts | `[ ]` | — |
| 1 | Fix local torrent date/category semantics shared with the $0 plan | `[ ]` | — |
| 2 | Add a cost-capped Apify gateway and run lifecycle | `[ ]` | 0 |
| 3 | Add Actor-aware discovery types, provenance, cache, and ledger | `[ ]` | 0, 2 |
| 4 | Integrate the FlixPatrol Actor for India streaming trends | `[ ]` | 2–3 |
| 5 | Integrate a JustWatch Actor for current India availability | `[ ]` | 2–3 |
| 6 | Build a Minch-owned Actor for genuine India OTT “new” pages | `[ ]` | 0, 2–3, 5 |
| 7 | Build a Minch-owned Actor for Blu-ray/4K release calendars | `[ ]` | 0, 2–3 |
| 8 | Add India editorial corroboration through an owned Actor | `[ ]` | 0, 2–3, 6 |
| 9 | Add lazy metadata enrichment and merge/ranking | `[ ]` | 4–8 |
| 10 | Build the Discover UI and torrent-search handoff | `[ ]` | 1, 9 |
| 11 | Add Actor replacement, monitoring, security, and cost operations | `[ ]` | 2–10 |
| 12 | Run a 14-day beta and choose the release budget | `[ ]` | 0–11 |

## 1. Scope and hard boundary

This is an alternative to [zero-cost-release-discovery-plan.md](./zero-cost-release-discovery-plan.md), not an add-on to it. They share product semantics and local filtering work, but they use different external-data transports.

### What “Apify-only” means

For release discovery:

- `minch-cli` may call Apify's public Store metadata API and authenticated Actor, task, run, and dataset APIs.
- `minch-cli` may read and write its own local normalized cache.
- Every request to a source website or upstream data API happens inside an Actor run.
- Health checks inspect Actor metadata or a previous Actor run; they never probe the target website from the CLI.
- Community Actors and Minch-owned Actors use the same local adapter contract.
- The existing torrent-indexer search remains unchanged. “Apify-only” applies to the new Trending/OTT/Blu-ray/India discovery data, not to torrent search itself.

### Product outcomes

The completed version should provide:

1. **Trending in India:** daily rank data by streaming platform from FlixPatrol, clearly labeled as chart popularity rather than release recency.
2. **Where to watch in India:** current provider offers from a JustWatch Actor.
3. **New on OTT in India:** dated entries from a dedicated “new releases” Actor; snapshot-only additions are labeled “newly observed,” never “released today.”
4. **Recent/upcoming Blu-ray and 4K:** dated physical-release records from a dedicated Actor.
5. **India releases:** availability region, Indian origin, and Indian language represented as distinct filters.
6. **Search handoff:** selecting a discovery title launches the existing torrent search using clean title plus year.
7. **Cost certainty:** each run has an Apify `maxTotalChargeUsd`, each source has a refresh floor, and the application has a monthly hard stop.

### Non-goals

- A full daily snapshot of the entire JustWatch India catalog.
- Treating a FlixPatrol chart date as a release date.
- Treating the first time Minch sees an offer as the actual platform launch date.
- Running arbitrary user-selected Store Actors without a reviewed schema and cost policy.
- Automatically switching to another paid Actor after failure.
- Bypassing logins, CAPTCHAs, paywalls, robots restrictions, or technical access controls.
- Assuming an Actor's presence in Apify Store grants rights to reuse the target site's data.

## 2. Research findings and provisional Actor registry

All Store Actors below are community-maintained unless explicitly described as Minch-owned. Their contracts and pricing can change independently of this repository.

### Provisional primary Actors

| Purpose | Actor | Stable Actor ID | Observed state on 2026-07-10 | Decision |
| --- | --- | --- | --- | --- |
| Cross-platform India trends | [Flixpatrol Streaming Charts Scraper](https://apify.com/jungle_synthesizer/flixpatrol-streaming-charts-scraper) | `anhB45cm5vOhhK5DC` | 9 total users, no reviews; 42 succeeded and 5 failed in its displayed 30-day run stats; recently modified | **Provisional**; benchmark before trusting |
| Current India streaming offers | [JustWatch Streaming Availability Scraper](https://apify.com/jungle_synthesizer/justwatch-where-to-watch-streaming-availability-scraper) | `ins4ViTaQtP2dFExC` | 3 total users, no reviews; 32/32 displayed recent runs succeeded | **Provisional primary** for current offers only |
| Lazy metadata enrichment | [TMDB Scraper: Movies, TV Shows, Cast & Episodes](https://apify.com/thescrapelab/Apify-tmdb-scraper) | `DRQtfohdSsr0K1Mdy` | 16 total users; 63 succeeded and 1 failed in displayed recent stats | **Provisional** because it is far cheaper than the other TMDb Actor found |
| Netflix-only chart cross-check | [Netflix Top 10 Scraper](https://apify.com/bright_oven/netflix-top10) | `eUaGWwxRsPOXjbLS9` | 6 total users; 60/60 displayed recent runs succeeded | **Optional validation**, not a separate UI feed |

### Actors to build and own

| Proposed Actor | Why it is needed | Target access | Default visibility |
| --- | --- | --- | --- |
| `minch/justwatch-new-india` | Existing JustWatch Actors return current offers but no trustworthy provider-added date | Approved JustWatch India “new” pages or their public page data contract | Private during beta; public only after terms/output review |
| `minch/bluray-release-calendar` | No credible general Blu-ray.com release Actor was found; the Store result was SteelBook-only | Approved public Blu-ray/4K release pages or feed | Private during beta |
| `minch/india-ott-calendar` | No maintained OTTPlay/Binged/India editorial Actor was found | Only explicitly approved, allowlisted public editorial calendar pages | Optional and private |

The owned Actors may consume websites or APIs internally, but the CLI still receives all data through Apify datasets. Keep their source in this repository under `actors/` and version their output schemas.

### Explicitly rejected as baseline

| Actor | Reason |
| --- | --- |
| `moving_beacon-owner1/streaming-catalog-scraper` | Currently charges about `$0.01` per result; too expensive for broad snapshots and still does not solve trusted addition dates |
| `parseforge/tmdb-movies-tv-scraper` | Observed Free-tier event price was about `$0.01867` per item versus roughly `$0.00099` for the selected TMDb Actor |
| `ramsford/streaming-box-office-monitor` | `$0.75` per platform scan or `$2` per multi-platform report, low adoption, and India coverage is not established |
| `lulzasaur/steelbookbluray-scraper` | Covers SteelBook collectibles rather than the complete Blu-ray calendar; observed price is about `$0.01` per result |
| Rotten Tomatoes/Letterboxd review Actors | Ratings/reviews do not establish OTT or physical release dates and add legal/cost/merge complexity |
| Generic Google/AI search Actors | Search snippets are weak evidence for exact release events and are difficult to deduplicate reliably |

### Critical semantic findings

- The FlixPatrol Actor emits `chart_date`, rank, points, days in Top 10, and peak rank. `chart_date` is a popularity observation date, not an OTT release date.
- The selected JustWatch Actor queries `popularTitles` and emits one row per offer, including provider, format, price, deeplink, TMDb/IMDb IDs, country, and title metadata. It does not emit a provider-addition date.
- A JustWatch catalog snapshot can support `firstObservedAt`; it cannot independently support `streamingAddedAt`.
- The selected FlixPatrol and JustWatch Actors are new and lightly adopted. Build pinning, fixture validation, and replacement support are required, not optional.
- No general Blu-ray release Actor or India OTT editorial Actor met the baseline during this research. Those gaps should be filled with small owned Actors rather than misusing unrelated Store Actors.

## 3. Pricing and budget model

Apify's [current platform pricing](https://apify.com/pricing) lists:

- Free: `$0/month` with `$5/month` in usage credit.
- Starter: `$29/month` with `$29/month` in usage credit, then pay as you go.
- Free/Starter compute: `$0.20` per compute unit (`1 GB RAM-hour`).
- Residential proxy traffic: `$8/GB` on Free/Starter; therefore residential proxy use is disabled by default.

Apify's API supports [`maxTotalChargeUsd`](https://docs.apify.com/api/v2/act-runs-post) on each Actor run. This plan requires it on every run, regardless of Actor pricing model.

### Observed community Actor prices

Pricing below was read from Apify's Actor metadata on 2026-07-10. The cost engine must discover active pricing at runtime rather than embedding these values forever.

| Actor | Price used for planning | Notes |
| --- | ---: | --- |
| FlixPatrol | `$0.10/run + $0.002/record` | The Store metadata showed `$0.0012/record` currently and a scheduled increase to `$0.002` on 2026-07-15; projections use the higher scheduled price |
| JustWatch availability | `$0.10/run + $0.0005/offer` | Metadata showed `$0.001/offer` currently and a scheduled decrease to `$0.0005` on 2026-07-18; projections use the scheduled price |
| Selected TMDb Actor | About `$0.00099/result` | AI analysis is a separate expensive event and must remain disabled |
| Netflix Top 10 cross-check | About `$0.00002/result` | Optional, cheap, Netflix-only |
| Owned Actors | Platform usage, normally `$0.20/CU` on Free/Starter | Actual runtime, memory, storage, transfer, and proxy use determine cost |

FlixPatrol/JustWatch start-event estimates assume one start event. Some Actor start events scale with allocated GB, so proof runs must confirm the actual invoice events.

### Cost formulae

```text
PPE run cost = start events + (result count × active result-event price)

Owned Actor compute units = memory in GB × runtime in hours
Owned Actor compute cost  = compute units × plan CU price

Monthly source cost = runs/month × measured average run cost
```

Example owned Actor: `512 MB` for `5 minutes` is approximately `0.0417 CU`, or `$0.0083` compute at `$0.20/CU`, before storage/transfer/proxy charges.

### Recommended operating profiles

#### Pilot: target under `$4.50/month`

| Workload | Frequency/limit | Projected or capped monthly cost |
| --- | --- | ---: |
| FlixPatrol India | 3 runs/week, 60 records/run | About `$2.86` |
| Owned JustWatch-new Actor | Daily, HTTP-only, cap decided after benchmark | Target `≤ $0.75` |
| Owned Blu-ray Actor | 3 runs/week, HTTP-only | Target `≤ $0.30` |
| Lazy TMDb enrichment | 200 results/month | About `$0.20` |
| Storage/transfer buffer | — | `$0.25` |
| **Target** | — | **About `$4.36`** |

Do not declare the pilot Free-plan-safe until the owned Actor proof runs confirm their actual compute and proxy usage. The local hard stop should initially be `$4.50`, below the advertised `$5` credit.

#### Balanced: recommended production workload

| Workload | Frequency/limit | Monthly upper estimate |
| --- | --- | ---: |
| FlixPatrol India | Daily, 120 records/run | `$10.54` |
| JustWatch current offers | Weekly, 500 offers/run | `$1.75` |
| Owned JustWatch-new Actor | Daily, `$0.05` run cap | `$1.55` cap |
| Owned Blu-ray Actor | Daily, `$0.05` run cap | `$1.55` cap |
| TMDb enrichment | 1,000 results/month | `$0.99` |
| Storage/transfer contingency | — | `$1.00` |
| **Upper estimate** | — | **About `$17.38`** |

This fits within the current Starter plan's `$29` included usage. Do not purchase Starter until the 14-day beta projects more than `$5/month` of useful runs.

#### High-frequency catalogue monitoring: not recommended

Daily 1,000-offer JustWatch snapshots plus twice-daily FlixPatrol runs can approach `$40–50/month` before proxies and yield weak “new release” semantics. Use the dedicated new-release Actor instead of brute-force catalogue diffs.

### Mandatory budget controls

- A global monthly budget in USD, default `$4.50` on the pilot profile.
- Per-source monthly allocation and per-run `maxTotalChargeUsd`.
- A pricing fingerprint containing pricing model, active event names/prices, actor ID, and checked time.
- Pause a source when pricing changes outside the reviewed envelope.
- `maxItems` in both Actor input and Apify run parameters when supported.
- Monthly warning at 75%; hard refusal at 100%.
- A failed/timed-out Actor may still cost money; record platform-reported cost for every terminal run.
- Never enable residential proxies automatically.
- Never retry a billable run automatically after terminal failure. A retry requires an explicit policy and remaining budget.

## 4. Target architecture

```text
                         Apify Store metadata API
                                   │
                           pricing/build gate
                                   │
                                   ▼
minch-cli ──► Apify run API ──► reviewed community or Minch-owned Actor
    │                              │
    │                              └──► target source (inside Actor only)
    │
    ├── poll run status
    ├── read bounded dataset
    ├── validate Actor-specific schema
    ├── normalize title/event/evidence
    ├── atomic local cache + cost ledger
    └── Discover UI ──► explicit title/year handoff ──► Torrent Search
```

### Proposed repository layout

```text
src/apify/
  types.ts                 # Actor metadata/run/dataset types
  client.ts                # authenticated REST client
  pricing.ts               # active-price selection and fingerprinting
  runs.ts                  # launch/poll/resume/abort lifecycle
  registry.ts              # reviewed Actor descriptors
  budget.ts                # monthly and per-run cost policy

src/discovery/
  types.ts
  adapter.ts
  cache.ts
  normalize.ts
  merge.ts
  rank.ts
  service.ts
  actor-adapters/
    flixpatrol.ts
    justwatch.ts
    justwatch-new.ts
    bluray.ts
    india-editorial.ts
    tmdb.ts

actors/
  README.md
  shared/
    schema.ts
    sanitize.ts
    evidence.ts
  justwatch-new-india/
    package.json
    src/main.ts
    input_schema.json
    dataset_schema.json
  bluray-release-calendar/
    package.json
    src/main.ts
    input_schema.json
    dataset_schema.json
  india-ott-calendar/
    package.json
    src/main.ts
    input_schema.json
    dataset_schema.json

test/apify/
test/discovery/
test/discovery/fixtures/<actor-id>/<schema-version>/
```

Actor packages must remain separate from the CLI runtime package so Crawlee/Apify dependencies do not bloat the `minch` npm bundle.

### Reviewed Actor descriptor

```ts
interface ActorDescriptor {
  purpose: "trending" | "availability" | "ott-new" | "bluray" | "india-editorial" | "metadata";
  actorId: string;
  actorSlug: string;
  build: string;                    // tested build number/tag, never implicit latest
  schemaVersion: number;
  input: Record<string, unknown>;
  maxItems: number;
  maxTotalChargeUsd: number;
  minRefreshMs: number;
  monthlyAllocationUsd: number;
  allowedPricingEvents: string[];
  pricingFingerprint: string;
  enabledByDefault: boolean;
}
```

Users may disable a descriptor. Arbitrary Actor IDs or free-form Actor inputs are out of scope until there is a safe advanced configuration design.

### Normalized provenance

Every normalized record must retain both the Actor and the actual target source:

```ts
interface ActorEvidence {
  actorId: string;
  actorSlug: string;
  actorBuild: string;
  actorRunId: string;
  datasetId: string;
  targetSource: "flixpatrol" | "justwatch" | "bluray.com" | "trakt" | "tmdb" | "editorial";
  sourceUrl?: string;
  scrapedAt: number;
  confidence: "exact" | "source_claim" | "observed" | "inferred";
}
```

Apify is transport/execution provenance; it does not replace attribution to FlixPatrol, JustWatch, Blu-ray.com, or an editorial publisher.

## 5. Run lifecycle

Every run follows this state machine:

```text
idle
  │
  ├─ cache fresh ─────────────────────────────────────────► ready
  │
  └─ stale ─► pricing check ─► monthly budget check ─► launch
                                                        │
                       ┌────────────────────────────────┤
                       ▼                                ▼
                    running ── persist run ID ──► poll/resume after restart
                       │
          ┌────────────┼────────────┬─────────────┐
          ▼            ▼            ▼             ▼
       succeeded     failed      timed-out      aborted
          │            │            │             │
   bounded dataset     └──── retain last good cache ────┘
          │
     validate/normalize
          │
   atomic cache + actual cost
          │
        ready
```

Rules:

- Start asynchronously with `POST /v2/actors/{actorId}/runs` and an Authorization header.
- Supply pinned `build`, `maxItems`, `maxTotalChargeUsd`, bounded memory, and timeout.
- Persist the run ID before polling. On process restart, resume that run rather than launching a duplicate.
- Poll with bounded exponential backoff; stop on Apify terminal states.
- Retrieve only the default dataset tied to the successful run ID, never an unscoped “last dataset.”
- Apply dataset page/item/byte caps locally even if the Actor ignores its own `maxItems` input.
- Validate all rows before replacing the previous snapshot.
- If the CLI abandons a user-started run, explicitly ask the lifecycle layer to abort it; do not assume dropping the HTTP connection stops billing.
- Cache the last valid result locally because Apify dataset retention is not the product's persistence layer.

## 6. Detailed phases

## Phase 0 — Actor audit and capped proof runs

**Purpose:** Establish that each candidate actually supports India, returns the documented fields, and stays inside a small cost cap before writing production adapters.

### Tasks

- [ ] **PA0.1 — Actor/source decision record**
  - Create `docs/decisions/002-apify-only-discovery.md`.
  - Record Actor ID/slug, owner, build, last modification, usage/review stats, maintenance notice, active/future price, input schema, output schema, target website, and target-site terms/attribution.
  - Record explicitly that a community Actor is not an SLA or a data license.
- [ ] **PA0.2 — Dedicated Apify token**
  - Create a scoped, expiring token for Minch with only the required Actor/run/storage rights where Apify permits.
  - Use `APIFY_TOKEN`; never put it in a URL, fixture, log, Actor input, or dataset.
  - Set an Apify account usage limit in addition to the application's local cap.
- [ ] **PA0.3 — Public metadata audit**
  - Query Apify Store/Actor metadata without starting runs.
  - Resolve the active pricing record by effective date.
  - Capture a pricing fingerprint and scheduled price changes.
  - Reject `UNDER_MAINTENANCE`, unrunnable, KYC-blocked, or unreviewed permission-expanding Actors.
- [ ] **PA0.4 — FlixPatrol proof run**
  - Use India only, one or two platforms, enrichment off, and `maxItems ≤ 20`.
  - Apply `maxTotalChargeUsd ≤ $0.15`.
  - Verify the actual India country slug, chart categories, dates, stable title identifiers/URLs, and charged events.
- [ ] **PA0.5 — JustWatch proof run**
  - Use `country=IN`, one Indian provider discovered from live Actor behavior, `FLATRATE`, and `maxItems ≤ 25`.
  - Apply `maxTotalChargeUsd ≤ $0.15`.
  - Confirm provider IDs/names, title IDs, TMDb/IMDb IDs, offer duplication, deep links, and absence of an addition date.
- [ ] **PA0.6 — TMDb Actor proof run**
  - Enrich at most five known titles with AI analysis disabled.
  - Apply `maxTotalChargeUsd ≤ $0.03`.
  - Confirm origin countries, original language, genre, release year/date, external IDs, and charged result count.
- [ ] **PA0.7 — Actor fixtures**
  - Save 2–10 sanitized rows plus Actor metadata and a run-cost summary under versioned fixture directories.
  - Preserve `actorId`, `build`, `schemaVersion`, target source, capture date, and run input without credentials.
- [ ] **PA0.8 — Selection gate**
  - Require valid India output, deterministic bounded input, stable external identity, acceptable target terms, and successful capped runs.
  - If FlixPatrol fails, the Netflix Top 10 Actor may validate Netflix charts, but it does not replace cross-platform India trends.
  - If the JustWatch Actor fails, benchmark another JustWatch Store candidate; never silently switch in production.

### Exit gate

Proceed only when the selected community Actor builds, schemas, costs, and target terms are documented; all proof runs stayed within a combined `$0.50`; and sanitized fixtures exist.

### Resume point

Start PA1.1. Preserve proof-run cost receipts in the decision record, not just estimated prices.

## Phase 1 — Shared local torrent filter corrections

**Purpose:** Resolve the original date/category pain points regardless of the discovery transport.

This phase is the same product requirement as Phase 1 in the $0 plan. If it was already implemented and verified there, mark this phase `[-]` and link the completing commit/test evidence in the execution log.

### Tasks

- [ ] **PA1.1 — Active torrent date filters require a valid `added` date.** Undated torrents appear only under `All`.
- [ ] **PA1.2 — Date sort is known-first** in both directions; missing dates are always last.
- [ ] **PA1.3 — Share normalized torrent categories** across Search and Trending/Discover without guessing from names initially.
- [ ] **PA1.4 — Add category to `FilterState`** and compose it with date/size/seeder/match filters.
- [ ] **PA1.5 — Show how many undated rows were hidden** by an active date constraint.
- [ ] **PA1.6 — Add boundary, missing-date, invalid-date, sort, category, and combined-filter tests.**

### Exit gate

“Last week” contains no undated torrent; category/date filters compose; the TUI explains hidden undated rows; all local tests pass.

### Resume point

Start PA2.1. Do not mix `TorrentResult` with Actor discovery records.

## Phase 2 — Apify gateway, pricing gate, and run lifecycle

**Purpose:** Create one secure and cost-bounded path to all external discovery data.

### Tasks

- [ ] **PA2.1 — Apify configuration**
  - Add `APIFY_TOKEN` environment support and optional owner-only Settings persistence.
  - Add global monthly budget, profile (`pilot`/`balanced`), and per-source enable flags.
- [ ] **PA2.2 — Minimal REST client**
  - Reuse `fetchResilient` rather than adding a large runtime dependency unless the official client materially simplifies safe polling.
  - Authorization header only; typed errors; abort-aware calls; redact tokens and dataset access keys.
- [ ] **PA2.3 — Actor metadata/pricing resolver**
  - Select the active `pricingInfos` entry by date.
  - Normalize PPE, pay-per-result, rental, and pay-per-usage models.
  - Compare against the reviewed fingerprint and pause on unexpected paid events or price increases.
- [ ] **PA2.4 — Monthly cost ledger**
  - Track reserved maximum before launch and actual platform-reported cost after terminal state.
  - Release unused reservation only after the terminal run is inspected.
  - Roll over by UTC billing month.
- [ ] **PA2.5 — Async run orchestration**
  - Launch with pinned build, max item/charge, memory, timeout, and input.
  - Persist in-flight state before polling.
  - Resume, abort, and terminal-state handling.
- [ ] **PA2.6 — Bounded dataset reader**
  - Read the successful run's dataset with explicit offset/limit.
  - Cap total items and decoded bytes; reject HTML/error bodies disguised as results.
- [ ] **PA2.7 — Tests**
  - Pricing effective dates and scheduled changes; unknown event; cap refusal; monthly rollover; concurrent launch dedupe; restart/resume; success/failure/timeout/abort; ignored maxItems; oversized dataset; redaction; `401`, `402`, `403`, `429`.

### Exit gate

A fake Actor can traverse launch → persisted run → poll → dataset → actual cost, while every attempt is protected by both a per-run cap and monthly ledger.

### Resume point

Start PA3.1. Actor-specific adapters may use only this gateway, never raw Apify fetches.

## Phase 3 — Discovery model, Actor provenance, cache, and service

**Purpose:** Normalize heterogeneous Actor outputs while retaining enough evidence to explain every date and charge.

### Tasks

- [ ] **PA3.1 — Domain types**
  - Separate `CatalogTitle`, `ReleaseEvent`, `ChartObservation`, and `ProviderOffer`.
  - Use date-only `YYYY-MM-DD` for release/chart dates and Unix milliseconds for scrape/observation times.
- [ ] **PA3.2 — Date semantics**
  - `chartDate`: ranking observation only.
  - `streamingAddedDate`: source explicitly claims provider addition.
  - `firstObservedAt`: Minch snapshot diff only.
  - `releaseDate`: digital/physical/title release depending on explicit kind.
  - Unknown dates remain unknown and never pass an active recent window.
- [ ] **PA3.3 — Actor evidence**
  - Persist Actor ID/slug/build/run/dataset plus target source/URL and confidence on every record.
  - Keep run cost on snapshot metadata rather than duplicating it per row.
- [ ] **PA3.4 — Versioned atomic local cache**
  - Separate snapshots by Actor descriptor and normalized feed.
  - Retain last good data on Actor failure/schema drift/pricing pause.
  - Reuse existing atomic/serialized write helpers.
- [ ] **PA3.5 — Stale-while-refresh service**
  - Fresh cache returns without a run.
  - Stale cache remains visible while an allowed Actor run proceeds.
  - No cache + paused budget produces a clear unavailable state, not an empty release list.
- [ ] **PA3.6 — Snapshot differ**
  - Compare provider offers by country + title ID + provider + monetization + format.
  - Emit `availability_first_observed` and `availability_removed_observed` events only.
  - Never call these events provider release/removal dates.
- [ ] **PA3.7 — Tests**
  - Timezones, unknown dates, cache corruption/migration, actor schema drift, stale data, pricing pause, partial adapters, snapshot addition/removal, and target/Actor provenance.

### Exit gate

Fixtures from two different Actors normalize into distinct chart, offer, and release-event types without losing date meaning or provenance.

### Resume point

Start PA4.1. Keep Actor-specific field names inside adapters.

## Phase 4 — FlixPatrol Actor for India trends

**Purpose:** Add cross-platform popularity without misrepresenting it as release discovery.

### Tasks

- [ ] **PA4.1 — Pin the proven Actor build and price fingerprint.**
- [ ] **PA4.2 — India task/input**
  - Use only confirmed India country slug.
  - Start with Netflix, Prime Video, and any other platform proven present in India.
  - Set enrichment off for frequent runs; use lazy metadata Actor instead.
  - Pilot `maxItems=60`; balanced `maxItems=120`.
- [ ] **PA4.3 — Normalize chart rows**
  - Platform, country, chart date, category, rank, points, days in Top 10, peak rank, title/slug, optional type/country/genre.
  - Identity includes platform + country + chart date + category + title slug.
- [ ] **PA4.4 — Ranking/UI semantics**
  - Default newest chart date, platform, category, then rank ascending.
  - Label screen `Trending`, never `New releases`.
  - Expose chart source and scrape freshness.
- [ ] **PA4.5 — Reliability policy**
  - Because the observed success rate was below 95%, require two successful pilot weeks before default-enable.
  - One failure retains cache; repeated failures pause and prompt Actor review.
- [ ] **PA4.6 — Tests**
  - Movies/TV, rank/points, duplicate charts, missing enrichment, bad date, India filter, unsupported platform, schema drift, and cost/item caps.

### Exit gate

The Trending feed can show India charts with correct platform/rank/date labels and projected cost consistent with the selected profile.

### Resume point

Start PA5.1. Do not reuse chart entries as current availability without JustWatch evidence.

## Phase 5 — JustWatch Actor for current India availability

**Purpose:** Answer “where can I watch this in India now?” and establish stable provider/title IDs for later release-event merging.

### Tasks

- [ ] **PA5.1 — Pin the proven Actor build and price fingerprint.**
- [ ] **PA5.2 — Bounded India inputs**
  - `country=IN`, `FLATRATE` first, explicit provider slugs confirmed in proof runs, movie/show types, bounded `maxItems`.
  - Never use unlimited mode.
- [ ] **PA5.3 — Normalize offers**
  - JustWatch entity ID, IMDb/TMDb ID, title/type/year/genres/scores, provider ID/name, monetization, format, price/currency, deeplink, country.
  - Collapse duplicate quality/price rows only in presentation; preserve actionable offers internally.
- [ ] **PA5.4 — Current availability view**
  - Display provider, monetization, format, and deeplink in details.
  - Label snapshot time as “checked,” not “added.”
- [ ] **PA5.5 — Optional observation diff**
  - Run weekly in pilot/balanced profiles.
  - Newly seen offers may appear in a diagnostic/newly-observed feed with explicit wording.
  - Never mix observation events into genuine OTT-new results.
- [ ] **PA5.6 — Tests**
  - Same title/provider multiple formats; rent/buy vs subscription; provider rename; missing IDs; title collision; bounded pagination; snapshot diff; malformed deeplink; cost cap.

### Exit gate

The application can resolve current India provider offers and distinguish snapshot observation time from provider addition time.

### Resume point

Start PA6.1. Use the JustWatch entity/provider IDs and fixtures to design the owned new-release Actor output.

## Phase 6 — Minch-owned India OTT-new Actor

**Purpose:** Obtain genuine dated “new on provider” entries without brute-force catalogue snapshots.

### Tasks

- [ ] **PA6.1 — Terms and technical contract spike**
  - Inspect public JustWatch India `new` and provider-new pages manually.
  - Confirm allowed automated access, data visible without login, date grouping, pagination, provider filters, and stable title IDs.
  - Stop if the approach requires authentication bypass, private tokens, or defeating technical controls.
- [ ] **PA6.2 — Owned Actor package**
  - Create `actors/justwatch-new-india` using HTTP/Cheerio where possible; browser automation only if essential.
  - Restrict inputs to `country=IN`, reviewed providers, date window ≤31 days, and bounded pages/items.
  - No arbitrary URLs or JavaScript from user input.
- [ ] **PA6.3 — Output contract**
  - `schemaVersion`, country, provider ID/name, title, media type, year, JustWatch ID, IMDb/TMDb IDs when present, explicit addition date/date precision, source URL, scrapedAt.
  - If a page provides only ordering and no date, output `date=null`; never substitute scrape time.
- [ ] **PA6.4 — Dedupe and checkpoints inside Actor**
  - Stable event key; bounded concurrency; retry policy; per-provider diagnostics; no duplicate output charge for identical rows in one run.
- [ ] **PA6.5 — Actor tests and local dry run**
  - Frozen HTML/JSON fixtures, date groups, pagination, provider rename, missing date/ID, block page, layout drift, terminal-control sanitization.
- [ ] **PA6.6 — Deploy private and pin build**
  - Start at 256–512 MB, direct/datacenter network, no residential proxy.
  - Measure five runs before selecting refresh interval and `maxTotalChargeUsd`.
- [ ] **PA6.7 — CLI adapter**
  - Normalize explicit dates as `streaming_added`; unknown dates remain undated.
  - Merge with current offers only when IDs/provider/region agree.
- [ ] **PA6.8 — Failure policy**
  - A block/layout change preserves last good cache and marks the Actor degraded.
  - Do not fall back to calling JustWatch directly from the CLI.

### Exit gate

At least seven consecutive capped runs produce dated India/provider additions with fixture-backed parsing, no prohibited access technique, and a measured monthly projection inside the selected profile.

### Resume point

Start PA7.1. Keep current-offer and new-release adapters independent so one can fail without corrupting the other.

## Phase 7 — Minch-owned Blu-ray/4K Actor

**Purpose:** Add complete physical-release discovery rather than relying on the Store's SteelBook-only Actor.

### Tasks

- [ ] **PA7.1 — Source/terms selection**
  - Evaluate Blu-ray.com release calendar/feed and at least one fallback physical calendar.
  - Record region, format specificity, update cadence, permitted polling, attribution, and stable identifiers.
- [ ] **PA7.2 — Owned Actor package**
  - Create `actors/bluray-release-calendar` with allowlisted source modes only.
  - Input: region, start/end date bounded to 60 days, explicit format filters, max items.
  - Prefer lightweight HTTP/XML/HTML parsing.
- [ ] **PA7.3 — Output contract**
  - Title, year, release date, region, exact format (`bluray`, `uhd_bluray`) only when stated, studio/distributor when present, edition, source ID/URL, scrapedAt, schemaVersion.
  - Generic DVD/physical data stays `physical`.
- [ ] **PA7.4 — Source disagreement**
  - Preserve separate evidence claims rather than overwriting one date.
  - Mark conflicting claims for the aggregator/details view.
- [ ] **PA7.5 — Actor and adapter tests**
  - Blu-ray vs 4K, combo packs, editions, duplicate dates, missing year/date, region, XML/HTML variation, block page, source disagreement, bounded range/items.
- [ ] **PA7.6 — Deploy, benchmark, and pin**
  - Private Actor during beta; no residential proxy by default.
  - Measure cost at pilot and balanced frequencies.

### Exit gate

The Actor produces format-specific, dated physical releases under a measured cap, and no SteelBook-only or generic event is mislabeled as the complete Blu-ray feed.

### Resume point

Start PA8.1. Physical release events may be global/other-region; do not put them in India solely because the title is Indian.

## Phase 8 — India editorial corroboration Actor

**Purpose:** Fill India OTT calendar gaps and cross-check provider/date claims while preserving editorial provenance.

This phase is optional. It must not block the core FlixPatrol + JustWatch + Blu-ray path.

### Tasks

- [ ] **PA8.1 — Source shortlist and permission review**
  - Evaluate OTTPlay, Binged, OTTweek, provider newsroom pages, and other public editorial calendars.
  - Approve only sources with stable public pages and acceptable automated-use terms.
- [ ] **PA8.2 — Evidence policy**
  - Editorial date/provider is `source_claim`, not automatically exact.
  - Preserve article title, publisher, URL, publication date, claimed release date, provider, language, and quoted field provenance without copying full articles.
- [ ] **PA8.3 — Owned allowlisted Actor**
  - One input mode per approved publisher with bounded calendar/list pages.
  - No arbitrary crawl or article-body corpus.
  - Output structured claims only; avoid copyrighted text beyond minimal factual fields.
- [ ] **PA8.4 — Corroboration rules**
  - Match by external ID where available, otherwise title + year + compatible type/provider.
  - Two agreeing independent claims can raise confidence; disagreement remains visible.
  - Editorial data never overwrites an exact provider/new-page event silently.
- [ ] **PA8.5 — Tests and benchmark**
  - Indian languages, movie/series, future/past, article publication vs release date, syndication duplicate, source disagreement, missing provider, changed layout, cost.

### Exit gate

At least one approved source adds measurable India coverage without violating the cost/terms policy; otherwise mark the phase `[-]` and document the gap.

### Resume point

Start PA9.1. Keep confidence/provenance visible through merging.

## Phase 9 — Lazy metadata, identity merge, feeds, and ranking

**Purpose:** Combine Actor datasets into useful feeds while minimizing paid enrichment and avoiding false date claims.

### Tasks

- [ ] **PA9.1 — Lazy TMDb Actor policy**
  - Enrich only records lacking origin country/language/genre/external IDs and only when visible/selected or needed for an ambiguous merge.
  - Batch unique titles/IDs where the Actor supports it.
  - Disable AI analysis; cap monthly result count by profile.
- [ ] **PA9.2 — Identity cascade**
  - Media type + TMDb ID; then IMDb ID; then JustWatch entity ID; then normalized title + exact year + compatible media type.
  - Never merge ambiguous title-only records.
- [ ] **PA9.3 — Separate domain records**
  - One canonical title can own chart observations, current offers, streaming-add events, physical-release events, and editorial claims.
  - Dedupe within the same event type/provider/region/date; do not collapse distinct evidence types.
- [ ] **PA9.4 — Feed definitions**
  - `Trending`: FlixPatrol charts.
  - `OTT New`: explicit `streaming_added` claims from owned Actor; optionally an explicitly separate `Newly observed` subsection.
  - `Where to Watch`: current JustWatch offers.
  - `Blu-ray`: exact Blu-ray/4K plus clearly labeled generic physical fallback.
  - `India`: region `IN`; optional `Indian titles only` based on origin country `IN`.
- [ ] **PA9.5 — Filters**
  - Media type, event window, provider, language, origin, genre, physical format, and evidence confidence.
  - Active date windows require known dates.
- [ ] **PA9.6 — Ranking**
  - Apply hard filters first.
  - Trending: chart date desc, rank asc, points desc.
  - OTT recent: addition date desc, confidence desc, popularity late.
  - Upcoming: release date asc.
  - Blu-ray past: date desc; upcoming: date asc.
  - Unknown dates last in `All` only.
- [ ] **PA9.7 — Conflict/coverage metrics**
  - Ambiguous identity, unknown date, provider mismatch, source disagreement, rows per Actor/source, rejected schema rows, enrichment spend per accepted merge.
- [ ] **PA9.8 — Golden tests**
  - Chart date never becomes release date.
  - First-observed offer never becomes streaming-added.
  - Same title on two providers retains two events.
  - Hindi-language non-Indian title is not Indian origin.
  - Undated records do not pass a seven-day window.
  - Actor/source provenance survives merge.

### Exit gate

Frozen Actor fixtures deterministically produce the five feeds without network calls, semantic date leakage, or unbounded enrichment.

### Resume point

Start PA10.1. React components consume aggregated view models and never interpret Actor-specific fields.

## Phase 10 — Discover UI and torrent-search handoff

**Purpose:** Expose Actor-backed discovery while making freshness, source, and cost status understandable.

### Recommended layout

```text
[ Torrent Search ]  Discover  Real-Debrid  TorBox  Sources  Settings

Discover: [Trending] [OTT New] [Where to Watch] [Blu-ray] [India]
Type:     [All] [Movies] [Series]   Window: [7d] [30d] [Upcoming]
Provider: [All] [Netflix] [Prime Video] [JioHotstar] ...

▸ 2026-07-10  Example Title (2026)  Netflix   Hindi
  2026-07-09  Another Film (2025)   4K UHD    Blu-ray.com

s search torrents · enter details · r refresh · $ cost/status
```

### Tasks

- [ ] **PA10.1 — Evolve existing Trending into Discover** while retaining the internal `trending` view key initially.
- [ ] **PA10.2 — Add feed/filter/cursor/details state** without mixing it into torrent result state.
- [ ] **PA10.3 — Show correct date labels**
  - `Charted`, `Added`, `Observed`, `Releases`, or `Checked` depending on record type.
  - Never display a generic unlabeled “date” that hides semantics.
- [ ] **PA10.4 — Source and Actor details**
  - Human UI emphasizes target source; details/diagnostics include Actor slug/build/run, scrape time, and evidence confidence.
- [ ] **PA10.5 — Cost/status panel**
  - Month spend/limit, reserved amount, last run actual cost, next eligible refresh, pricing-paused, running, stale, and failure states per Actor.
- [ ] **PA10.6 — Manual refresh**
  - Show the maximum possible charge before confirmation when a refresh will launch a paid run.
  - Fresh-cache refresh does not bill.
- [ ] **PA10.7 — Search handoff**
  - Explicit action sends clean title + year to Torrent Search.
  - No provider/Actor/source tags enter the query automatically.
- [ ] **PA10.8 — Tests**
  - All feeds and date labels; narrow terminal; partial/stale/pricing-paused/running states; cost confirmation; details; search handoff; no accidental launch on navigation.

### Exit gate

Users can distinguish trend, current availability, actual addition, observation, and physical release; no paid Actor starts merely by moving between tabs.

### Resume point

Start PA11.1. Preserve the last good cache while testing Actor replacement scenarios.

## Phase 11 — Actor operations, replacement, security, and documentation

**Purpose:** Make community Actor churn and paid execution manageable in production.

### Tasks

- [ ] **PA11.1 — Actor health score**
  - Metadata notice, last modification, recent success/failure stats, schema fixture compatibility, price fingerprint, last five local run outcomes.
  - Health informs diagnostics; never auto-selects an unreviewed replacement.
- [ ] **PA11.2 — Build upgrade workflow**
  - Detect new build; run one capped canary against fixtures/expected invariants; compare schema and row counts; require explicit promotion of pinned build.
- [ ] **PA11.3 — Replacement workflow**
  - Candidate audit → capped proof run → new fixture → adapter/normalizer → seven-day shadow comparison → explicit switch.
  - Preserve old cache and descriptor for rollback.
- [ ] **PA11.4 — Owned Actor CI/deploy**
  - Unit/fixture tests per Actor package.
  - Build/push only on explicit release workflow.
  - Pin deployed build in CLI registry after smoke test.
- [ ] **PA11.5 — Security audit**
  - Scoped token, header auth, owner-only config, redaction, no secrets in Actor input/output, source text sanitization, dataset byte caps.
  - Inspect Actor permission levels and reject unexpected full permissions.
- [ ] **PA11.6 — Cost audit**
  - Reconcile local ledger against Apify usage for beta runs.
  - Test active and scheduled pricing changes, failed-run costs, account limit, per-run caps, and monthly hard stop.
- [ ] **PA11.7 — Terms/attribution docs**
  - Target-site terms and attribution remain separate from Apify terms.
  - Document that community Actors can break/change price and that Minch is not affiliated with target sources.
- [ ] **PA11.8 — Setup docs**
  - Apify account/token, pilot and balanced profiles, expected costs, cache, manual refresh charges, source limits, disabling Actors, and token rotation.
- [ ] **PA11.9 — Full checks**
  - CLI tests/typecheck/build/package inspection plus each owned Actor's independent tests/build.

### Exit gate

A price change, schema change, failed build, unavailable Actor, or leaked/rotated token produces a safe paused/partial state rather than surprise spend or data corruption.

### Resume point

Start PA12.1 using the pilot profile and a fresh billing month/ledger where practical.

## Phase 12 — 14-day beta and release choice

**Purpose:** Determine whether the Actor-only approach provides enough value to justify its cost and maintenance surface.

### Tasks

- [ ] **PA12.1 — Pilot profile for 14 days**
  - Record every Actor run, input size, output size, terminal state, actual charge, target-source freshness, and cache use.
- [ ] **PA12.2 — Coverage sample**
  - At least 30 India OTT-new events, 30 current offers, 30 FlixPatrol chart entries, and 20 Blu-ray/4K releases where available.
  - Verify title, media type, date semantics, provider/format, India region/origin/language, and duplicate behavior.
- [ ] **PA12.3 — Reliability metrics**
  - Success rate by Actor/build, schema rejection rate, stale hours, source disagreements, missing dates, ambiguous identities, and manual interventions.
- [ ] **PA12.4 — Cost metrics**
  - Actual cost per useful unique event, per feed, and per successful refresh.
  - 31-day projected total under pilot and balanced schedules.
  - Failed-run and enrichment waste.
- [ ] **PA12.5 — Acceptance targets**
  - Zero chart dates mislabeled as releases.
  - Zero first-observed offers mislabeled as provider addition dates.
  - Zero undated items under active date windows.
  - At least 95% correct title/date/provider-or-format on sampled high-confidence release events.
  - Community primary Actor success rate ≥95% during beta or an explicit degraded/manual policy.
  - Pilot projected spend ≤`$4.50`; balanced projected spend ≤`$20` and within Starter credit.
  - One Actor failure leaves cached/other feeds usable.
- [ ] **PA12.6 — Release choice**
  - **Free-credit pilot release:** useful coverage under `$4.50/month`.
  - **Starter release:** enough added freshness/coverage to justify `$29/month` subscription with usage inside included credit.
  - **Do not ship Actor-only:** costs or community churn exceed the benefit; retain the direct $0 plan.
- [ ] **PA12.7 — Final plan state**
  - Mark completed/skipped phases, record released commit/version, selected budget profile, pinned Actor builds/prices, and known gaps.

### Exit gate

Release only when semantic accuracy, reliability, cost reconciliation, source terms, and full test/build checks pass.

## 7. Testing strategy

### Default tests never run paid Actors

1. Pure unit tests for pricing, budget, dates, normalization, merge, and ranking.
2. Actor-adapter tests against versioned sanitized datasets.
3. Gateway tests against a fake Apify HTTP server.
4. Owned Actor parser tests against frozen target pages/responses.
5. UI tests against fake discovery service states.
6. Explicitly opt-in capped live smoke tests, excluded from `npm test`.

### Required edge cases

- Active vs scheduled Actor pricing records.
- Actor adds a new paid event or changes price.
- Price fingerprint changes while cache is fresh/stale.
- `maxItems` ignored by Actor.
- Run succeeds with empty dataset, or dataset contains an error row.
- Run fails after charging start/scrape events.
- CLI exits while run continues; next start resumes instead of duplicating.
- Actor build disappears or is under maintenance.
- Dataset schema changes field types/names.
- Provider rebrand and duplicate offer formats.
- Chart date versus release date versus scraped time.
- India timezone around UTC midnight.
- Source page returns a block/CAPTCHA page.
- Unknown/malformed dates and terminal control text.
- Monthly budget rollover and concurrent reservations.
- Actor token missing, expired, rotated, or insufficiently scoped.

## 8. Operational diagnostics

Example local status:

```text
Apify budget             $2.94 / $4.50 this month     $0.15 reserved
FlixPatrol charts        ready   build 0.1.x   $0.22 last run   next in 31h
JustWatch availability   stale   build 0.1.x   $0.35 last run   weekly
India OTT new            ready   owned build 0.2.x    $0.01 last run
Blu-ray calendar         failed  owned build 0.1.x    cached 2d  layout changed
TMDb enrichment          ready   84 / 200 results this month
```

Keep these diagnostics local. Do not add telemetry.

Track:

- actor ID/slug/build/run/dataset;
- pricing fingerprint and check time;
- reserved maximum and actual charge;
- run status/duration/memory/items/bytes;
- source rows accepted/rejected/deduplicated;
- fresh/stale snapshot age;
- unknown dates, ambiguous identities, and source conflicts;
- target source and attribution URL;
- sanitized last error.

## 9. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Community Actor is new/low-adoption | Proof run, pinned build, fixtures, shadow replacement, cached partial UI |
| Actor price changes | Metadata preflight, effective-date resolver, fingerprint pause, per-run/month caps |
| Actor returns many offer rows | Input and API maxItems, dataset item/byte cap, no unlimited mode |
| FlixPatrol data mistaken for releases | Separate `ChartObservation`; explicit `Charted` label; golden test |
| JustWatch snapshot mistaken for addition date | Separate `ProviderOffer`/`firstObservedAt`; dedicated OTT-new Actor |
| No complete Blu-ray Store Actor | Owned bounded Actor; SteelBook actor excluded |
| India editorial pages are unstable or disallowed | Optional phase, allowlist, terms gate, cached degradation, no bypass |
| Actor run continues after CLI exits | Persist run ID; resume/abort lifecycle; no duplicate launch |
| Failed run still costs money | Reserve before run, record actual terminal charge, no automatic billable retry |
| Residential proxy surprises | Disabled by default; any exception requires explicit budget/terms decision |
| Apify dataset expires | Atomic local cache is canonical product persistence |
| Token leak | Scoped token, Authorization header, owner-only config, redaction, package/fixture audit |
| Actor source and target attribution confused | Persist and show both Actor provenance and target source evidence |
| Starter purchased too early | 14-day Free-credit pilot and measured 31-day projection first |

## 10. Definition of done

- All discovery target data reaches the CLI through reviewed Apify Actor datasets.
- No direct TMDb/JustWatch/FlixPatrol/Blu-ray/editorial fetch exists in the CLI.
- Every billable run has pinned build, max items, timeout, memory, per-run charge cap, and monthly allocation.
- Active pricing is checked and fingerprinted before launch.
- In-flight runs survive local restart without duplicate charges.
- FlixPatrol chart dates are never presented as releases.
- JustWatch current offers are never presented as provider-addition dates.
- The owned OTT-new Actor produces explicit India/provider addition dates or leaves them unknown.
- The owned physical Actor distinguishes Blu-ray, 4K UHD, and generic physical evidence honestly.
- India availability, Indian origin, and Indian language are separate.
- Missing dates never pass active date filters or sort above known dates.
- Actor and target-source provenance survive normalization/merge and appear in details.
- Community Actor failure, price change, or schema drift preserves cached/partial feeds.
- The 14-day beta reconciles local and Apify charges and stays inside the chosen budget.
- Default tests are network- and billing-free; full CLI and owned Actor tests/builds pass.
- Setup, cost, terms, attribution, source limits, Actor pinning, and replacement are documented.

## 11. Decision checkpoint versus the direct $0 plan

After Phase 12, compare this plan with the direct-source plan on:

| Dimension | Apify-only question |
| --- | --- |
| Integration simplicity | Is one Apify gateway simpler than several direct clients after run/pricing complexity is included? |
| Data quality | Did owned Actors provide better India OTT and Blu-ray dates? |
| Reliability | Did community Actor churn create more downtime than direct APIs/RSS? |
| Cost | Is the measured cost per useful unique release acceptable? |
| Maintenance | Are owned parser Actors easier to repair independently of the CLI? |
| User setup | Will users accept an Apify account/token and possible Starter subscription? |
| Legal/attribution | Are target-site permissions and attribution defensible? |

It is valid to ship neither stack unchanged. A future hybrid may use Apify only for scraping-only gaps while retaining free direct APIs, but that requires its own explicit plan; do not silently mix architectures during this implementation.

## Execution log

| Date | Phase/task | Result | Tests/cost | Next action |
| --- | --- | --- | --- | --- |
| 2026-07-10 | Plan creation | Apify-only alternative laid out; provisional community Actors identified; custom OTT-new/Blu-ray/India gaps documented; no Actor was run and no implementation started | Read-only Store research; `$0` spent | PA0.1 — create the Actor/source decision record |

