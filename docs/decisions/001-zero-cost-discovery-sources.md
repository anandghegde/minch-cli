# ADR 001: Zero-cost discovery sources

- Status: Accepted with source-specific conditions
- Decision date: 2026-07-10
- Last terms review: 2026-07-10
- Scope: Release discovery data used by `minch-cli`

## Context

`minch-cli` needs recent India streaming changes, regional release metadata, and physical-media release dates without a paid data dependency. Source contracts must allow a locally installed torrent-search application to display the data, keep a small cache, and attribute the provider. API keys belong to the user and are never shipped with the application.

This record is an engineering interpretation of the published source terms, not legal advice. A source marked restricted or unresolved must not be enabled more broadly without a new review.

## Decision summary

| Source | Decision | Credential | Published request allowance | Region support | Required credit |
| --- | --- | --- | --- | --- | --- |
| TMDB | Conditional go for non-commercial use | User API Read Access Token | No fixed contractual quota; the documentation describes a mutable upper limit around 40 requests/second | ISO 3166-1 `region`; validate `IN` responses in the live spike | TMDB logo and prescribed TMDB notice; JustWatch credit when watch-provider data is shown |
| Blu-ray.com RSS | Restricted pilot; permission remains unresolved | None | No published request quota; the feed publishes a 30-minute TTL, while this application will poll at most once per 24 hours | No trustworthy region field in the feed; store as unknown/global, never silently `IN` | Label and link every claim to Blu-ray.com |
| Trakt | No-go for this application without written approval | User Trakt Client ID | 1,000 unauthenticated application GETs per 5 minutes | Physical calendar region limitations remain to be verified; no India claim is allowed | Trakt branding requirements would apply if approval were obtained |
| Streaming Availability API | Conditional go for end-user display | User direct developer-platform key | A free plan is advertised, but no numeric request allowance is published in the accessible public documentation; the user's subscribed-plan dashboard is authoritative | 66 countries advertised; an authenticated `/countries/in` response must prove India support | Visible “Streaming Availability API by Movie of the Night” credit and link |

## TMDB

### Contract

- Signup: [create a TMDB account](https://www.themoviedb.org/signup), then request API access from the account's API settings.
- Credential: the API Read Access Token, sent as an `Authorization: Bearer` header. The application variable will be `TMDB_READ_TOKEN`.
- Cost and use: the developer API is free for qualifying non-commercial use. Commercial use requires a separate written agreement with TMDB.
- Attribution: include an approved TMDB logo and the notice required by the [TMDB API terms](https://www.themoviedb.org/api-terms-of-use) in a visible Credits/About surface. TMDB's [FAQ and attribution guidance](https://developer.themoviedb.org/docs/faq) is also authoritative.
- Watch-provider caveat: TMDB watch-provider results originate from JustWatch and carry an additional [JustWatch attribution requirement](https://developer.themoviedb.org/reference/movie-watch-providers). Provider presence describes current availability, not when a title arrived.
- Quota: TMDB no longer publishes the legacy 40-per-10-seconds quota. Its [rate-limit guidance](https://developer.themoviedb.org/docs/rate-limiting) describes a changeable upper limit around 40 requests/second and requires respectful handling of `429` responses.
- Region support: `region` accepts an ISO 3166-1 country code and composes with `with_release_type`; types `4` and `5` mean Digital and Physical. See [TMDB region support](https://developer.themoviedb.org/docs/region-support).
- Other restrictions relevant here: do not cache TMDB content longer than six months; do not bulk scrape, sublicense, sell, or redistribute TMDB content; purge cached TMDB content if the license ends.
- Terms/contact: [API terms](https://www.themoviedb.org/api-terms-of-use), [API support forum](https://www.themoviedb.org/talk/category/5047958519c29526b50017d6), and the commercial-use contact identified in the FAQ.

### Decision

Use TMDB only when the user supplies a token and the application remains within TMDB's non-commercial developer terms. Do not ship a maintainer token. Keep normalized cache retention well below six months. Treat physical release type `5` as `physical`, never as Blu-ray evidence. If the project becomes revenue-generating, disable TMDB for that distribution until a written commercial agreement exists.

## Blu-ray.com new-release RSS

### Contract

- Endpoint: [Blu-ray.com New Releases RSS](https://www.blu-ray.com/rss/newreleasesfeed.xml).
- Credential/cost: none; the feed is publicly reachable.
- Published behavior observed on 2026-07-10: RSS 2.0, a 30-minute feed TTL, stable-looking item links used as GUIDs, dated items, explicit Blu-ray/4K title markers, and a copyright notice reserving all rights. These observations are contract-spike inputs, not permission to reuse the feed.
- Quota and region: no request quota or SLA is published. The feed does not expose a reliable release region, so normalized records must use an unknown/global region rather than `IN`.
- Terms/contact: no public terms specifically authorizing third-party RSS reuse were located. Use [Blu-ray.com's contact page](https://www.blu-ray.com/contact/index.php) to request confirmation; its [privacy policy](https://www.blu-ray.com/contact/privacy.php) is not a content-reuse license.

### Decision and unresolved risk

Permission for low-frequency application use is unclear. Until written confirmation exists:

- fetch no more than once per 24 hours and use conditional requests when possible;
- retain only the item title, release date, format marker, GUID/link, and observation metadata;
- identify Blu-ray.com beside the data and link users to the original item;
- do not copy descriptions, images, reviews, specifications, or bulk catalogue data;
- do not expose a data export, proxy, mirrored feed, or redistribution endpoint;
- retain cached feed items for at most 30 days.

If this restricted use is later determined to be disallowed, disable the adapter and continue with cached data only for the allowed wind-down period. A generic physical source may replace it only when that source's own terms allow this application.

## Trakt

### Contract

- Signup/application: create a Trakt account and [register an API application](https://trakt.tv/oauth/applications/new).
- Credential: public endpoints use the application's Client ID in the `trakt-api-key` header; OAuth is not needed for public calls. See [authentication](https://docs.trakt.tv/docs/authentication-oauth) and [required headers](https://docs.trakt.tv/docs/required-headers).
- Cost/quota: the public API and branding page describe free use. Current [rate limits](https://docs.trakt.tv/docs/rate-limiting) allow 1,000 unauthenticated application GET requests per five minutes and require honoring `Retry-After` on `429`.
- Attribution: an approved integration must follow [Trakt branding requirements](https://trakt.tv/branding).
- Region support: the planned physical calendar must be treated as generic/unknown-region until a live contract probe proves otherwise.
- Terms/contact: the [Create an App terms](https://docs.trakt.tv/docs/create-an-app) govern API apps and direct API questions to Trakt's developer community.

### Decision: not eligible without written approval

Trakt's application terms say Trakt data cannot be used in applications or websites that promote copyright infringement or piracy. `minch-cli` describes itself as a torrent finder and exposes magnet actions. That makes the planned Trakt fallback incompatible on the published terms, regardless of whether an individual torrent is lawful.

Do not register a Trakt application, make live Trakt requests, ship a Trakt adapter, or instruct users to add a Client ID unless Trakt grants written approval for this specific project. Keep `TRAKT_CLIENT_ID` reserved in the design only so an approved future adapter has an unambiguous credential name. If approval is not obtained, Phase 5 must use an allowed source or remain Blu-ray-RSS-only; generic TMDB `physical` events are not Blu-ray evidence.

## Streaming Availability API by Movie of the Night

### Contract

- Signup: use the [Movie of the Night Developers Platform](https://developers.movieofthenight.com/) as described by the [authentication guide](https://docs.movieofthenight.com/guide/authentication).
- Credential/transport: `STREAMING_AVAILABILITY_API_KEY` is always a direct developer-platform key, sent only to `https://api.movieofthenight.com/v4` in `X-API-Key`. RapidAPI keys and endpoints are deliberately unsupported, so no transport selector or fallback exists.
- Cost/quota: the public documentation advertises a free plan with no payment information and feature parity with paid plans, but it does not publish a numeric request allowance on an accessible public page and live responses exposed no allowance headers. The confirmed 500/350/450 figures below are local safety policy, not a provider-quota claim.
- Region support: the API advertises 66 countries. The [countries contract](https://docs.movieofthenight.com/resource/countries) returns live country/service dictionaries, and the [changes contract](https://docs.movieofthenight.com/resource/changes) accepts an ISO country plus past/future changes within a 31-day window. India and its provider IDs must be confirmed from an authenticated response, not hard-coded from documentation examples.
- Data use: the provider's [API terms](https://github.com/movieofthenight/streaming-availability-api/blob/main/TERMS.md) allow commercial end-user display but prohibit resharing, reselling, redistributing, database access, data exports, and downstream APIs.
- Attribution: visible user-facing credit must identify Streaming Availability API by Movie of the Night and link to [the provider's API page](https://www.movieofthenight.com/about/api). Attribution continues for retained data after a subscription ends; images cannot be used after subscription end.
- Image allowance: the terms publish a 1 GB monthly image bandwidth limit for the Free plan. This CLI will not fetch or render provider images.
- Contact: [Movie of the Night contact form](https://www.movieofthenight.com/contact).

### Decision

Use only the direct developer platform. Use data only in the local end-user interface and versioned local cache. Never expose raw snapshots or bulk export. The user confirmed a conservative local envelope of 500 attempted calls per UTC month, a warning at 350, and a hard stop before call 451, leaving a 50-call margin. This is a local safety policy, not a claim about an undisclosed provider quota; lower upstream enforcement produces cached/quota-paused behavior and never authorizes paid usage.

## Application-wide data handling

The application will not proxy, resell, mirror, or redistribute bulk datasets from any discovery source. It will make bounded user-device requests, store only the minimum normalized records needed for offline use, and show source attribution and source links. Cache files are internal application state, not a public data export. Maintainer credentials, user credentials, request headers, and account identifiers must never enter the package, fixtures, logs, cache, or source links.

## Follow-up gates

1. P0.2 defines credential conventions and the fixed direct transport without adding values to the repository.
2. P0.3 records the configured Streaming Availability plan's numeric allowance and live India support before any quota constants are finalized.
3. P0.3 must not call Trakt unless written approval has been obtained.
4. P0.5 decides whether the unresolved Blu-ray.com permission is acceptable for beta; otherwise the physical feed falls back only to contract-compatible `physical` data.
5. Re-review this ADR before monetization, before adding any redistribution/export feature, or when a source changes its terms or free allowance.
