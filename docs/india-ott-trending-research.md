# India OTT Trending Research

Research date: 12 July 2026

## Executive recommendation

Build a provider-aware **Trending in India** feed, but do not describe every
result as an official viewership ranking. There is no single public,
cross-platform endpoint that exposes what Indian subscribers watched across
Netflix, Prime Video, JioHotstar, Sony LIV, ZEE5, Sun NXT, Hoichoi, aha, and the
long tail of Indian services.

Use a layered model:

1. Use official platform charts when a platform publishes them. Netflix is the
   strongest example: its public Top 10 surface has an India selector, weekly
   movie/show and English/non-English views, rank, views, runtime, and hours
   viewed.
2. Use a licensed availability/discovery provider for the cross-OTT catalog,
   provider mapping, deep links, new additions, and any licensed popularity or
   Top 10 fields. Movie of the Night's Streaming Availability API is already
   integrated and advertises Top 10, Recently Added, Upcoming, deep links, and
   India support.
3. Use TMDB trending only as a broad cross-title popularity signal. TMDB
   trending is not India OTT consumption and current provider presence is not a
   provider-addition event.
4. Use JustWatch's India popularity pages as a validation benchmark or pursue a
   commercial API/data agreement. The public site exposes India popularity,
   provider filters, and “new on provider” pages; its business page explicitly
   positions API, historical availability, and consumer-intent data as
   commercial products.

The UI should label the evidence directly: **Official Top 10**, **India
popularity**, **New on provider**, **Trending signal**, or **Recently added**.
This prevents a third-party popularity score from being presented as a
platform's verified audience measurement.

## What “trending” means

These are different datasets and should remain different feed types:

| Feed label | Meaning | Strongest source | Suitable claim |
| --- | --- | --- | --- |
| Official Top 10 | A platform's published rank and measurement window | Platform-owned chart | “Netflix India Top 10 for 6/29–7/5” |
| India popularity | A third party's popularity or intent ranking for India | JustWatch or licensed equivalent | “Popular on JustWatch India” |
| Cross-OTT trending | Short-window title momentum independent of availability | TMDB trending, optionally blended | “Trending on TMDB; available on…” |
| New on provider | A title newly detected in a provider catalog | Streaming Availability API or provider feed | “Added to Netflix India on date X” |
| Recently added | A catalog item surfaced by a source's recent-addition list | Streaming Availability API | “Recently added according to source” |
| Editorial picks | A platform or publisher's curated slate/article | Official editorial pages | “Featured in Prime Video India editorial” |

“Current on Netflix” or “available on JioHotstar” only describes present
availability. It does not establish when a title arrived or how many people
watched it.

## India OTT landscape to model

At minimum, the provider dictionary should be data-driven and should cover the
major services visible in India discovery workflows:

- Netflix
- Amazon Prime Video
- JioHotstar, including the provider's current naming/identity returned by the
  selected availability source
- Sony LIV
- ZEE5
- Sun NXT
- Hoichoi
- aha
- ManoramaMAX
- MX Player / Amazon MX Player, keeping the source's exact identity
- MUBI
- Crunchyroll
- Lionsgate Play
- Hungama Play
- Discovery+
- EPIC ON
- ShemarooMe
- Tata Play and other aggregator/channel catalogs where the source distinguishes
  them from standalone subscription services

This list is not a hard-coded completeness promise. JustWatch's India page
currently exposes a much longer list, including regional and channel catalogs.
Streaming Availability's `/countries/in` response should remain the authority
for what the configured API can actually query. Persist the provider ID, label,
homepage, country, catalog type, and source observation time.

## Source assessment

### 1. Netflix official Top 10

Source: [Netflix Top 10](https://www.netflix.com/tudum/top10)

The page is public and offers India as a country selector. It supports movies
and shows, English and non-English categories, weekly windows, rank, weekly
views, runtime, and hours viewed. Netflix also provides historical week
selection and a downloadable global Top 10 data workbook from the same surface.

Strengths:

- First-party measurement and clear weekly methodology.
- India-specific country selection.
- Separate movie/show and English/non-English views.
- Excellent user-facing evidence: rank, views, hours, week, and country.

Limitations:

- Netflix only; it cannot rank Prime Video, JioHotstar, or other providers.
- The public surface is an editorial web page, not a documented public API for
  minch. Automating it would need a separate terms and operational review.
- The data is weekly, not real-time.
- A title can appear in a Netflix chart without being available on another OTT.

Recommendation: treat this as a separate official-chart adapter only after
confirming permission for programmatic reuse. Do not silently scrape it into
the generic Streaming Availability adapter.

### 2. Streaming Availability API by Movie of the Night

Sources: [API overview](https://www.movieofthenight.com/about/api),
[changes resource](https://docs.movieofthenight.com/resource/changes),
[countries and services](https://docs.movieofthenight.com/guide/countries-and-services)

This is the best fit for minch's existing architecture. The API documents
country-specific catalogs, service IDs, show metadata, deep links, images,
Top 10, Recently Added, Upcoming, and popularity sorting. Its changes endpoint
supports `new`, `updated`, `removed`, `expiring`, and `upcoming`, filters by
country, catalog, show type, and a maximum 31-day date window, and returns
cursor pagination.

The current integration already uses India change events and provider
normalization. It correctly preserves source dates, provider IDs, media type,
unknown language/origin metadata, pagination warnings, cache state, and
attribution.

Strengths:

- One country-aware source for global and Indian services.
- Provider IDs and catalog-level filtering.
- Deep links, availability options, audio/subtitle metadata, and title IDs.
- First-party API terms allow commercial end-user display, subject to the
  provider's restrictions and attribution.
- No need to scrape individual OTT apps.

Limitations:

- The accessible public docs do not publish a numeric free-plan request quota;
  the configured account plan is authoritative.
- Coverage and freshness are source claims, not a guarantee of every provider's
  catalog.
- “Top 10” and “popularity” must be confirmed in the current API plan/schema
  before adding them to the contract. Existing `changes` support alone cannot
  produce popularity.
- The terms prohibit resharing, reselling, redistribution, database access,
  data exports, and downstream APIs. Keep the existing local, cache-first,
  end-user-only boundary.
- Image usage has plan-specific constraints; the existing CLI deliberately
  avoids provider image fetching.

Recommendation: extend this adapter with a bounded `provider_trending` or
`provider_top10` request only after a live contract spike proves the response
shape and plan entitlement. Reuse the existing budget, cache, attribution, and
diagnostic machinery.

### 3. TMDB

Sources: [Popularity and Trending](https://developer.themoviedb.org/docs/popularity-and-trending),
[Discover movie](https://developer.themoviedb.org/reference/discover-movie),
[Watch Providers](https://developer.themoviedb.org/reference/movie-watch-providers),
[API terms](https://www.themoviedb.org/api-terms-of-use)

TMDB's popularity score uses daily votes, views, favorites, watchlists, release
timing, total votes, and prior score. Trending is a shorter daily/weekly signal.
The API supports broad trending and discover queries. Discover can filter by
India region, release dates, providers, and watch region. Watch-provider data
is supplied through TMDB's JustWatch partnership.

Strengths:

- Already integrated for trending, regional metadata, and watch providers.
- Strong identity resolution through TMDB IDs.
- Useful fallback when provider-specific trending is unavailable.
- India-region filters can improve relevance for release and availability
  views.

Limitations:

- TMDB trending is not OTT-specific and should not be labeled “most watched in
  India”.
- Watch-provider presence is current availability, not an arrival timestamp.
- Watch-provider output is not a full deep-link catalog and requires JustWatch
  attribution.
- Developer API access is for qualifying non-commercial use. Commercial use,
  including a revenue-generating application or content destination, requires
  a separate written agreement.
- The terms prohibit caching longer than six months and require immediate purge
  after termination.

Recommendation: retain TMDB as the generic trending and identity layer. Add a
provider intersection: fetch TMDB trending, then retain titles whose India
provider snapshot contains the selected service. Label the result “Trending on
TMDB, available on [provider]”, never “provider trending”.

### 4. JustWatch

Sources: [JustWatch India](https://www.justwatch.com/in),
[Streaming API and data intelligence](https://www.justwatch.com/us/JustWatch-Streaming-API)

JustWatch's India public site is a useful product and validation reference. It
shows popular movies and TV shows, provider filters, provider-specific “new”
pages, availability, and a large India provider catalog. Its business page
advertises a unified where-to-watch API, coverage across 120+ countries,
historical availability, provider analytics, and consumer-intent data.

Strengths:

- Directly aligned with the user question: popularity by India and provider.
- Broad Indian provider coverage, including regional services and channels.
- Consumer intent and historical data are more relevant to “trending” than
  metadata-only signals.

Limitations:

- The public website is not evidence that its underlying data may be scraped or
  redistributed.
- The API/data product is commercial and requires a business conversation.
- The public page's ranking methodology is not an open, reproducible API
  contract.
- Availability data is also the source behind TMDB's provider endpoint, so it
  should not be double-counted as an independent popularity signal.

Recommendation: use the public site for manual benchmark comparisons and
product research. For a production cross-OTT popularity chart, request a
commercial API/data agreement rather than scraping.

### 5. Official OTT editorial sources

Examples include [Prime Video India editorial/news](https://www.aboutamazon.in/news/entertainment),
Netflix Tudum, and official JioStar/other provider announcements.

These sources are useful for release calendars, launch announcements, and
editorial context. They are not complete catalog-change feeds and generally do
not expose a comparable, machine-readable viewership rank across providers.

Recommendation: keep them out of the automated ranking pipeline. They can be
linked as source evidence for “editorial announcement” or used in manual
validation of a new-release feed.

### 6. Trakt and similar community APIs

Trakt has useful popularity and trending concepts, but the repository's source
decision already marks it no-go without written approval because its terms
restrict applications that promote copyright infringement or piracy. Given
minch's torrent-search and magnet workflow, do not add it as a workaround.

## Recommended product model

Add a `TrendEvidence` concept alongside `ReleaseEvent`; do not overload
`ReleaseEvent` to represent popularity. A minimal shape would be:

```ts
type TrendKind =
  | "official_top10"
  | "provider_popularity"
  | "cross_ott_trending"
  | "recently_added"
  | "editorial";

interface TrendEvidence {
  id: string;
  titleId: string;
  kind: TrendKind;
  region: "IN" | string;
  providerId?: string;
  providerLabel?: string;
  rank?: number;
  score?: number;
  scoreScale?: string;
  views?: number;
  hoursViewed?: number;
  windowStart?: string;
  windowEnd?: string;
  source: DiscoverySource | "netflix-top10" | "justwatch";
  sourceUrl?: string;
  observedAt: number;
  confidence: "official" | "source_claim" | "inferred";
}
```

Important invariants:

- `providerId` is optional because TMDB trending has no provider dimension.
- `region` is explicit; default to `IN` only for an India-targeted source
  request, never from title origin or language.
- `rank` is not interchangeable with `score`.
- `views` and `hoursViewed` are only populated for sources that publish them.
- `observedAt` is retrieval time, never a made-up release date.
- Every item carries source attribution and a source link.
- Unknown provider, language, origin, dates, and rank remain unknown.

## Ranking strategy

Do not combine unlike signals into a single “truth” score by default. Present
source-native sections first. If a combined view is needed, use a transparent
composite and show its inputs.

Suggested composite for “India momentum”:

```text
momentum =
  0.40 * normalized_provider_signal
  + 0.25 * normalized_official_chart_signal
  + 0.20 * normalized_tmdb_trending_signal
  + 0.10 * recency_signal
  + 0.05 * availability_confidence
```

Rules:

- Omit a component when the source is absent and renormalize weights.
- Do not treat rating as popularity. Ratings can be a secondary display field.
- Normalize within provider and media type so Netflix's published scale does
  not dominate a small regional service.
- Add a freshness decay to signals older than their source window.
- Keep official rank visible even if a composite rank is also displayed.
- Call the output “Minch India momentum” or “Combined discovery signal”, not
  “India's most watched”.

For the first release, avoid the composite entirely. A source-separated UI is
more accurate and easier to explain in a terminal.

## Proposed user experience in Discover

Add a provider selector and a signal selector:

- Region: India
- Provider: All, Netflix, Prime Video, JioHotstar, Sony LIV, ZEE5, and the
  configured provider dictionary
- Signal: All signals, Official Top 10, Popular, Trending, New this week
- Type: Movies, Series
- Language: Original language and audio language, with Unknown retained
- Date window: Today, 7 days, 30 days

Each row should show:

- Title and year
- Movie or series marker
- Provider badge(s)
- Signal label, such as `Netflix India #3` or `New on ZEE5`
- Measurement window or source date
- Optional rating, clearly labeled by rating source
- Availability/deep-link status where permitted
- Source attribution in detail/help views

Useful empty and warning states:

- “No official chart available for this provider; showing source popularity.”
- “Current availability found; arrival date is unknown.”
- “First page only; more results available.”
- “Provider dictionary is stale.”
- “Using cached results; source refresh is quota-paused.”
- “This title is trending on TMDB, not an official OTT chart.”

## Implementation plan for this repository

### Phase 0: contract spike

- Confirm the current Streaming Availability subscription exposes the Top 10,
  Recently Added, and popularity endpoints/fields.
- Call `/countries/in` and record the exact provider IDs and labels returned by
  the configured account; do not hard-code names such as Hotstar/JioHotstar.
- Capture only sanitized response shape, field names, pagination behavior, and
  provider counts in a local spike report. Never commit titles, credentials,
  deep links, or raw payloads.
- Confirm the plan's numeric allowance and image restrictions.
- Review source terms before enabling any new automated endpoint.

### Phase 1: source-native feed

- Add `TrendEvidence` and `trend` snapshots without changing release-event
  semantics.
- Add one provider-trending request for Streaming Availability if the contract
  spike succeeds.
- Reuse `DiscoveryService`, request validation, cache retention, request ledger,
  sanitization, source attribution, and diagnostic status.
- Keep one bounded page per provider on refresh, with explicit truncation.
- Add fixtures and parser tests for movie/series rows, missing rank, unknown
  dates, duplicate title IDs, provider aliases, and malformed rows.

### Phase 2: TMDB intersection

- Fetch TMDB daily/weekly trending from the existing adapter.
- Intersect with cached India provider availability rather than enriching every
  global trending row with a provider request.
- Expose the provenance text “Trending on TMDB; currently available on…”
- Preserve the current TMDB and JustWatch attribution notices.

### Phase 3: official charts

- Add Netflix Top 10 only after confirming programmatic-use permission and a
  stable acquisition method.
- Keep it as its own source and schema because its weekly measurements are not
  interchangeable with catalog changes.
- Extend to other OTTs only when they publish a documented, reusable India chart
  or provide a licensed feed.

### Phase 4: commercial data decision

- If cross-OTT India popularity is a core product promise, evaluate a
  commercial JustWatch agreement or another licensed provider with India
  consumer-intent data.
- Revisit TMDB licensing before monetization. The current TMDB developer terms
  do not authorize a revenue-generating destination without a written agreement.
- Revisit Movie of the Night terms before adding export, server-side proxying,
  public feeds, or multi-user aggregation.

## Cost, quota, and cache policy

Current repository policies are appropriate for a local CLI and should remain:

- User-owned credentials only; no maintainer key in the package.
- Cache-first refresh with stale data displayed while one coalesced refresh runs.
- One request page per target provider for the initial feed.
- Explicit `hasMore`/truncation diagnostics.
- Monthly Streaming Availability ledger and hard stop.
- TMDB retention below six months and current project retention much shorter.
- No raw API snapshots, public export, proxy endpoint, or bulk catalog mirror.
- Provider deep links may be shown only according to the selected source terms.

For a provider list of 10 services, a naive daily refresh is roughly 300
provider calls per month before retries and pagination. A provider-wide endpoint
or one combined catalog request is therefore materially preferable. If only
per-provider requests are available, refresh the selected provider eagerly and
refresh the rest on demand.

## Validation plan

Measure accuracy separately from availability coverage:

- Compare Netflix India rows against the official Netflix India Top 10 for four
  consecutive weeks.
- Compare provider “new” rows against official release announcements, marking
  inconclusive cases where the announcement is not a complete change log.
- Sample at least 10 titles per major provider across movies, series, Hindi,
  English, Tamil, Telugu, Malayalam, Bengali, and Marathi where available.
- Check title identity collisions, season-vs-series handling, duplicate
  providers, deep-link validity, and stale-cache labels.
- Record false positives, missed titles, unknown metadata, pagination
  truncation, and source disagreement. Do not turn a single page into a
  completeness claim.

Success criteria for an initial beta:

- Every displayed rank has a source, region, and measurement window.
- No current-availability row is described as a dated addition.
- Provider filters never depend on title language or origin inference.
- A source outage leaves cached results and a truthful warning.
- The UI distinguishes official, source-claimed, and inferred signals.
- No source terms are violated by scraping, redistribution, or unlicensed
  commercial use.

## Sources consulted

- [TMDB Popularity & Trending](https://developer.themoviedb.org/docs/popularity-and-trending)
- [TMDB Discover Movie](https://developer.themoviedb.org/reference/discover-movie)
- [TMDB Watch Providers](https://developer.themoviedb.org/reference/movie-watch-providers)
- [TMDB FAQ](https://developer.themoviedb.org/docs/faq)
- [TMDB API Terms](https://www.themoviedb.org/api-terms-of-use)
- [Streaming Availability API overview](https://www.movieofthenight.com/about/api)
- [Streaming Availability Changes](https://docs.movieofthenight.com/resource/changes)
- [Streaming Availability Countries and Services](https://docs.movieofthenight.com/guide/countries-and-services)
- [Netflix Top 10](https://www.netflix.com/tudum/top10)
- [Amazon India Entertainment](https://www.aboutamazon.in/news/entertainment)
- [JustWatch India](https://www.justwatch.com/in)
- [JustWatch Streaming API and data intelligence](https://www.justwatch.com/us/JustWatch-Streaming-API)
