# Discovery live-contract spike

- Status: Complete for the Phase 0 gate; unresolved RSS behavior is not a production assumption
- Started: 2026-07-10
- Region under test: India (`IN`)
- Terms decision: [ADR 001](decisions/001-zero-cost-discovery-sources.md)
- Credential convention: [Discovery credentials](discovery-credentials.md)

This record distinguishes live evidence from documentation assumptions. No credential value, request authorization header, account identifier, or full upstream payload is recorded here.

## Configuration presence

The process environment was checked on 2026-07-10 without printing values:

| Variable | State |
| --- | --- |
| `TMDB_READ_TOKEN` | Set on resume; value not read or recorded |
| `TRAKT_CLIENT_ID` | Unset; also inactive under ADR 001 |
| `STREAMING_AVAILABILITY_API_KEY` | Set on resume; value not read or recorded |

No persisted discovery Settings contract exists yet, so the live runner used only the exported environment credentials. Values and authorization headers were never printed or persisted.

## Opt-in probe runner

Run `npm run spike:discovery` only after exporting the credential variables described below. The runner:

- uses the fixed direct Movie of the Night host and `X-API-Key` mapping from the credential contract;
- makes at most twelve TMDB calls and two Streaming Availability calls; candidate verification stops as soon as each required India shape is proven;
- uses a 15-second timeout and zero retries, so the request count is bounded and inspectable;
- queries one page only and does not follow the Streaming Availability cursor;
- emits a field-level JSON summary without authorization headers, raw payloads, poster paths, or credentials;
- redacts a credential even if a transport error unexpectedly echoes it;
- never calls Trakt or Blu-ray.com.

With no credentials configured, the runner exits successfully with `complete: false` and `totalRequestCount: 0`. Its output is diagnostic evidence to review and summarize here; it is not a fixture or cache file. The user confirmed a local envelope of 500 calls/month, a warning at 350, and a hard stop before request 451.

Use `npm run spike:discovery -- --tmdb-only` or `--streaming-only` to repeat one source without spending requests against a source whose evidence is already sufficient. `complete` then refers only to the requested source and requires semantic evidence, not merely successful HTTP responses.

## Probe status

| Source | Live request | Result | Remaining proof |
| --- | --- | --- | --- |
| TMDB | 4 calls in the initial combined probe, then 7 TMDB-only calls at 06:49 UTC | India Digital type 4, Physical type 5, and watch-provider shapes proven | None for the Phase 0 contract |
| Blu-ray.com RSS | Sent once during P0.1 on 2026-07-10 at 06:11 UTC | HTTP 200 RSS capture summarized below | A second poll no earlier than 24 hours later to test GUID stability and observed cadence |
| Trakt | Deliberately not sent | Prohibited for this application without written approval under ADR 001 | None unless written approval changes the source decision |
| Streaming Availability | 2 field-summary calls at 06:46 UTC plus 1 header-only allowance check | India country/providers, a real joinable `/changes` page, and local 500/350/450 budget policy proven | None for the Phase 0 contract |

## Blu-ray.com RSS evidence

The single permitted capture returned:

| Property | Observed value |
| --- | --- |
| HTTP status | `200` |
| Content type | `text/xml` |
| Content length | `43287` bytes |
| Last-Modified | `Thu, 09 Jul 2026 09:20:44 GMT` |
| ETag | `"6a4f67ec-a917"` |
| Root/channel | RSS 2.0; `Blu-ray.com - Movies - New Releases` |
| Feed `pubDate` / `lastBuildDate` | `Thu, 09 Jul 2026 05:20:44 -0400` for both |
| Feed TTL | `30` minutes |
| Language | `en-us` |
| Item date format | RFC-style timestamp with an explicit `-0400` offset; the first item used midnight local time |
| First item | `The Elephant Man (Blu-ray)`, dated `Tue, 07 Jul 2026 00:00:00 -0400` |
| First item identity | `guid` exactly equaled the canonical Blu-ray.com item link |
| First item category | `blu-ray` |
| Explicit format marker | A separate item was titled `The Elephant Man 4K (Blu-ray)`, proving that 4K is distinguishable in title text |

Conclusions supported by this capture:

- The feed is XML/RSS and has a structure compatible with the repository's existing XML dependency; fixture parsing remains a P0.4 verification item.
- Release dates include a numeric timezone offset and must be converted to a calendar date without shifting the advertised local day.
- At least one captured item has a source URL usable as an event source ID and attribution link.
- Blu-ray and 4K variants can be separate items. The 4K classification is explicit in the item title, but the capture does not yet prove a dedicated UHD category field.
- The advertised 30-minute TTL is not permission to poll every 30 minutes. ADR 001's one-request-per-24-hours restriction remains authoritative.

Not yet proven by a single capture:

- whether a GUID remains unchanged across feed rebuilds;
- actual update cadence versus the advertised TTL;
- whether every 4K item uses the same title marker;
- whether malformed/missing dates or GUIDs occur in the live feed;
- release region, which the captured feed does not state and must remain unknown/global.

## TMDB live evidence

The initial 31-day query returned 96 Digital candidates but no Physical candidate. Its first Digital candidate had no `IN` entry in regional release details, so a successful discover response alone is not sufficient row-level evidence. The bounded TMDB-only probe then checked candidates until it proved:

- Digital: the second candidate had an `IN` regional release with type `4` and the exact date `2026-07-10`.
- Physical: a widened spike-only window (`2024-07-10` through `2027-07-10`) returned 15 candidates; the first had an `IN` release with type `5` and date `2026-05-10`.
- Watch providers: a provider-filtered discovery candidate exposed an `IN` result with a TMDB link plus `rent` and `buy` buckets. Sample provider objects contained numeric IDs and display names.
- Release-date responses use top-level `id` plus a country `results` array. Watch-provider responses use top-level `id` plus a country-code-keyed `results` object.

Product implications:

- TMDB type `5` remains generic `physical`; it is not Blu-ray evidence.
- A discover-list `release_date` is only a candidate date. Because the first Digital result lacked matching India release details, production code must not publish an exact India event solely from that list field.
- Watch providers prove current offers only and must never create a `streaming_added` event.
- The sparse 31-day Physical result confirms TMDB cannot replace the Blu-ray-specific feed by itself.

## Streaming Availability live evidence

The direct `/v4/countries/in` response identified India and nine current service IDs:

| ID | Display name |
| --- | --- |
| `netflix` | Netflix |
| `prime` | Prime Video |
| `apple` | Apple TV |
| `hotstar` | JioHotstar |
| `zee5` | Zee5 |
| `sonyliv` | SonyLiv |
| `mubi` | Mubi |
| `curiosity` | Curiosity Stream |
| `crunchyroll` | Crunchyroll |

One direct India `new`/`show` changes page proved:

- top-level `changes`, `shows`, `hasMore`, and `nextCursor` fields;
- 25 changes joined successfully to 18 show-dictionary entries;
- `hasMore: true` and a two-part cursor string;
- `changeType: new`, `itemType: show`, `showId`, `showType`, `streamingOptionType`, `link`, nested `service`, and `timestamp` fields;
- a real seconds timestamp of `1783665832` (`2026-07-10T06:43:52Z`), observed before the request rather than synthesized from fetch time;
- a nested service object with `id`, `name`, `homePage`, `imageSet`, and `themeColorCode` fields;
- included show identity/title/type plus IMDb/TMDB IDs; the sampled show did not include origin-country or original-language fields, so those remain optional/enrichment data.

The critical India change-timestamp claim is proven. A separate header-only request returned HTTP 200 but no rate-limit or request-allowance headers. The provider-published allowance therefore remains undisclosed by the API; this is not presented as a provider claim. The user confirmed the conservative local policy: 500 calls/month, warn at 350, stop before call 451, and retain a 50-call margin. Lower upstream enforcement degrades to cached/quota-paused behavior and never authorizes paid usage.

## Go/no-go disposition

[ADR 002](decisions/002-phase-0-discovery-go-no-go.md) accepts Blu-ray RSS only as
a restricted pilot and explicitly does not rely on observed rebuild cadence or
permanent GUID stability. The first capture proves the Phase 0 physical-date
claim; production identity has documented fallbacks and polling remains capped at
once per 24 hours. TMDB and Streaming Availability met their Phase 0 contracts,
while Trakt remains a no-go.
