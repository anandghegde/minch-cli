# 1TamilMV Discover feed (Firecrawl)

- Status: Approved for implementation
- Date: 2026-07-15
- Scope: Latest-releases Discover subtab for https://www.1tamilmv.reisen/

## Summary

Add a **TamilMV** Discover subtab that lists the latest homepage posts as catalog title rows. Data is scraped via the user’s **Firecrawl** API key (premium credits assumed). Enter hands off to the existing torrent search with a cleaned title. Magnets and topic-page deep scrapes are **out of scope** for v1.

## Goals

1. Show a Discover-style latest-releases feed from the 1TamilMV homepage.
2. Use Firecrawl-first scraping with `FIRECRAWL_API_KEY`.
3. Include all languages present on the homepage listing (Tamil, Telugu, Hindi, Malayalam, Kannada, multi-audio, etc.).
4. Integrate with existing discovery cache, budget ledger, enable/disable, attribution, and search handoff.
5. Keep all automated tests offline (fixture HTML + mocked Firecrawl).

## Non-goals (v1)

- Scraping topic pages for magnets or download links
- Multi-page crawl / archive pagination
- Mirror rotation UI (optional config base URL only)
- Direct HTML-first hybrid fallback (may be added later)
- Treating 1TamilMV as an official release calendar or legal streaming source

## Product behavior

| Surface | Behavior |
| --- | --- |
| Discover feeds | New feed id `tamilmv`, label **TamilMV** |
| Feed order | `trending → ott → bluray → popular → charts → community → tamilmv` |
| Row content | Cleaned title, year when parseable, media type (movie/series), optional language/format |
| Enter | Existing `buildDiscoverySearchQuery(title)` → Search tab |
| Details | Source link to topic URL; evidence `tamilmv` / `source_claim` |
| Filters | Media and language filters apply when metadata is present |
| Dates | Homepage posts usually have no trustworthy release date; do not invent dates |

### Empty / error states

Reuse existing Discover empty reasons:

- **unconfigured** — no Firecrawl API key
- **disabled** — source in `disabledSources`
- **quota-no-cache** — budget exhausted and no snapshot
- **offline-no-cache** — Firecrawl/network failure and no snapshot
- **partial-no-events** / **no-events** — configured but empty parse or no events after filters

## Architecture

```
Discover UI (feed=tamilmv)
  → buildDiscoveryLoadTargets
  → createTamilmvAdapter
  → DiscoveryService (cache policy)
  → Firecrawl client POST /v2/scrape
  → parseTamilmvLatestHtml
  → DiscoverySnapshot { source: "tamilmv", titles, events }
  → aggregate → feeds.tamilmv
```

### New modules

| Module | Responsibility |
| --- | --- |
| `src/discovery/sources/firecrawl.ts` | Thin Firecrawl scrape client (auth, request, response parse) |
| `src/discovery/sources/tamilmv.ts` | Adapter: validate request, budget, scrape, parse, normalize, sanitize |

### Type / contract extensions

- `DiscoverySource`: add `"tamilmv"`
- `DiscoveryAdapterId`: add `"tamilmv"`
- `DiscoveryFeedKind`: add `"tamilmv_latest"`
- `DiscoveryCapability`: add `"tamilmv_latest"`
- `DISCOVERY_FEEDS` / `DiscoveryFeedClassification`: add `tamilmv`
- `REFRESH_POLICIES.tamilmv`: `freshForMs: 6h`, `retainForMs: 14d`
- `SOURCE_BUDGETS.tamilmv`: max **4 scrapes/day**, **60/month** (endpoint `scrape:homepage`)

### Config

| Key | Purpose |
| --- | --- |
| Env `FIRECRAWL_API_KEY` | Preferred credential (wins over config) |
| `discovery.firecrawl.apiKey` | Optional config fallback |
| `discovery.tamilmv.baseUrl` | Optional; default `https://www.1tamilmv.reisen/` |
| `discovery.disabledSources` | May include `"tamilmv"` |

Update `.env.example` with `FIRECRAWL_API_KEY=` only (no secret values).

### Request contract

When feed is `tamilmv`:

```ts
{
  region: "IN",
  feedKind: "tamilmv_latest",
  mediaTypes: ["movie", "series"],
  providerIds: [],
  pageLimit: 1,
  // no dateRange required for v1 homepage scrape
}
```

Adapter rejects other `feedKind` values and non-`IN` regions (or accepts only `tamilmv_latest` + `IN` and throws contract errors otherwise).

## Firecrawl integration

- Base URL: `https://api.firecrawl.dev`
- Endpoint: `POST /v2/scrape`
- Header: `Authorization: Bearer <key>`
- Body (v1):

```json
{
  "url": "https://www.1tamilmv.reisen/",
  "formats": ["html"]
}
```

- Prefer HTML for stable Invision Community selectors (`.ipsDataItem` / topic title links).
- If HTML is empty but markdown is present in a future format list, optional fallback parse may be added; v1 only requests `html`.
- Use shared resilient fetch helpers; map HTTP 401/403 to auth failure; respect abort signals.
- Never log or persist the API key; sanitize snapshots like other adapters.

## Parsing rules

Source: homepage latest list items (observed 2026-07-15 as Invision `ipsDataItem` rows with long release titles and `/forums/topic/…` links).

For each item:

1. Read title text + topic href.
2. HTML-entity decode; `sanitizeDiscoveryText` / discovery security sanitize.
3. Allow only `https:` links whose hostname is the configured base host (default `www.1tamilmv.reisen` or `1tamilmv.reisen`). Drop unsafe links with a warning.
4. Extract:
   - **year** — first `(19xx|20xx)` in title when present
   - **mediaType** — `series` if title matches season/episode markers (`S\d+`, `EP`, `COMPLETE` as series pack); else `movie`
   - **formatLabel** — first of `WEB-DL`, `TRUE WEB-DL`, `BluRay`/`BLURAY`, `PreDVD`, `HDRip`, `Remux`/`REMUX`, else omit
   - **audioLanguages** — detect language tokens (Tamil, Telugu, Hindi, Malayalam, Kannada, Eng/English) when listed; map to ISO 639-1 (`ta`, `te`, `hi`, `ml`, `kn`, `en`)
   - **display title** — strip quality/audio/size tail after the primary format/language release marker; remove trailing size/quality brackets; keep human-readable name + year context as needed for search handoff
5. Build stable ids (deterministic hash of source + topic id or title+year+mediaType).
6. Dedupe by topic id preferred; else normalized title+year+mediaType.
7. Emit one `ReleaseEvent` per title:
   - `kind: "digital"`
   - `region: "IN"`
   - **no invented calendar date**; `datePrecision: "unknown"`; `status` consistent with unknown date helpers used elsewhere
   - `formatLabel` when known
   - `audioLanguages` when known
   - evidence: `{ source: "tamilmv", sourceUrl, confidence: "source_claim", observedAt }`
8. Malformed rows → `warnings[]`; do not fail the whole snapshot if at least one valid row exists. Zero valid rows after parse → empty titles/events with a parse warning (or contract error only if Firecrawl returned unusable payload).

### Attribution

```ts
{
  source: "tamilmv",
  sourceLabel: "1TamilMV",
  sourceUrl: "https://www.1tamilmv.reisen/",
  notice: "Latest listing scraped via Firecrawl from 1TamilMV; not an official release calendar. Coverage and mirrors change frequently.",
}
```

## Aggregate & UI

- Classification: events with evidence source `tamilmv` (or snapshot `feedKind === "tamilmv_latest"`) → `feeds.tamilmv` only; do not mix into ott/trending.
- Ranking: preserve homepage order when possible (stable sort by observation / source order); undated rows must remain visible on the TamilMV tab even when date windows would drop unknown dates on other feeds — **TamilMV feed should include unknown-date events** when the user is on this tab (either by defaulting date window to `all` on feed switch, or by special-casing undated inclusion for this feed). Prefer: **default date window to `all` when switching to `tamilmv`**, and document that date filters are best-effort for this source.
- `SOURCE_LABELS.tamilmv = "1TamilMV"`
- Diagnostics / contribution maps include `tamilmv`.

## Security

- Snapshot path must run `sanitizeDiscoverySnapshot` before cache and UI.
- Strip secrets (Firecrawl key) if ever echoed.
- Restrict outbound scrape URL to configured TamilMV base URL only (no open redirect of user-controlled scrape targets in v1).
- Topic links only rendered if host-allowlisted.

## Testing

| Area | Coverage |
| --- | --- |
| Parser | Fixture HTML with multi-language WEB-DL, series `S01 EP`, BluRay, unsafe link drop |
| Firecrawl client | Mock 200 HTML, 401, network error |
| Adapter | Unconfigured, disabled, budget exceeded, happy path snapshot |
| Aggregate | Events only in `feeds.tamilmv` |
| UI / screen state | Feed in list; labels; optional empty unconfigured reason |
| Config | Parse `firecrawl` + `tamilmv` + disabled source id |

No live Firecrawl or live 1TamilMV network in `npm test`.

## Implementation order

1. Types, config, budget, request feedKind, refresh policy
2. Firecrawl client + unit tests
3. TamilMV parser + fixture + unit tests
4. Adapter + service wiring + aggregate/diagnostics
5. `useDiscovery` load target + Discover UI labels/navigation
6. Settings enable/disable + `.env.example` + short discovery setup note
7. Full test pass

## Risks

| Risk | Mitigation |
| --- | --- |
| Homepage HTML structure changes | Isolated parser + fixture; clear warnings; Firecrawl still returns page |
| Domain/mirror moves | `discovery.tamilmv.baseUrl` config |
| Firecrawl credit spend | 6h cache + 4/day budget |
| Title parse noise | Conservative cleaners; search handoff still useful with partial clean |
| Legal/ToS | Same class of public torrent index use as existing Cardigann sources; attribute site; no redistribution API |

## Success criteria

1. With a valid `FIRECRAWL_API_KEY`, Discover → TamilMV lists cleaned latest titles.
2. Enter runs a normal multi-source torrent search on the cleaned title.
3. Without a key, the tab shows the unconfigured empty state.
4. Offline unit tests pass; no credentials in repo.
5. Source can be disabled in Settings without crashing other feeds.
