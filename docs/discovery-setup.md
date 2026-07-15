# Discovery setup and operations

Discovery is local, cache-first, and usable in stages. No maintainer API key is
bundled, and there is no paid fallback.

## Minimum setup path

1. **Start credential-free with Blu-ray RSS.** Launch `minch`, open Discover,
   and select the Blu-ray feed. The restricted Blu-ray.com RSS adapter is on by
   default, polls at most once per 24 hours, and labels its region unknown.
2. **Add TMDB for Trending and regional metadata.** [Create a TMDB account](https://www.themoviedb.org/signup),
   request developer API access in [account API settings](https://www.themoviedb.org/settings/api),
   and copy the API Read Access Token. TMDB's developer API is for qualifying
   non-commercial use; review licensing before monetization.
3. **Optionally add India OTT changes.** Create a free direct developer-platform
   subscription at <https://developers.movieofthenight.com/> and copy its key.
   RapidAPI keys/endpoints are deliberately unsupported.
4. **Optionally add India OTT and community signals.** Create an Apify token at
   <https://console.apify.com/> and set `APIFY_API_TOKEN`. The Popular feed uses
   the `moving_beacon-owner1/streaming-catalog-scraper` Actor in India `popular`
   mode. India Charts uses the `crawlerbros/flixpatrol-streaming-charts-scraper`
   Actor for separate Netflix, Prime Video, JioHotstar, and ZEE5 India chart
   requests. Community uses Letterboxd's bounded weekly-popular mode. These are
   source-claimed popularity signals, not official cross-platform viewership;
   FlixPatrol is not affiliated with the named OTT services. Apify platform and
   Actor usage may be billable after free usage.
5. **Optionally add TamilMV latest listings.** Create a Firecrawl API key at
   <https://www.firecrawl.dev/> and set `FIRECRAWL_API_KEY`. Discover → TamilMV
   scrapes the 1TamilMV homepage for latest topic titles (via Firecrawl), cleans
   them for search handoff, and does not fetch magnets. Firecrawl usage is
   billable under your Firecrawl plan. Listings are source claims from a public
   torrent index mirror, not an official release calendar.

Missing credentials disable only their own adapters. Search, credential-free
Blu-ray discovery, and cached results from other enabled sources continue.

## Configure credentials

Environment variables take precedence over Settings:

```bash
export TMDB_READ_TOKEN='<TMDB API Read Access Token>'
export STREAMING_AVAILABILITY_API_KEY='<Movie of the Night direct-platform key>'
export APIFY_API_TOKEN='<Apify API token>'
export FIRECRAWL_API_KEY='<Firecrawl API key>'
export MDBLIST_API_KEY='<optional user-owned MDBList key>'
minch
```

Alternatively, open **Settings** and edit **TMDB read token**, **Streaming
Availability key**, **Apify API token**, or **Firecrawl API key**. Values are masked and stored atomically in owner-only
`config.json`. An environment-backed field is read-only in Settings; unset the
variable before editing or clearing its persisted fallback. minch reads
`process.env` and does not automatically load `.env.example`.

Trakt is intentionally unavailable under the current terms decision. Do not
register or configure a Trakt application for minch without written approval.

## Enable or disable an adapter

Settings contains independent **TMDB discovery**, **Streaming Availability
discovery**, **Apify discovery**, **TamilMV discovery**, and **Blu-ray RSS discovery** rows. Select one and press `space` or
`enter` to toggle it. This works even when an environment credential exists.

Disabling an adapter stops its network/cache refresh path and excludes its
retained snapshots from **All cached**. It does not delete the cache file or a
saved credential. Re-enable the row to use it again; clear the corresponding
key separately if the credential should also be removed.

## Local files

| Platform | Config directory | Data directory | Log directory |
| --- | --- | --- | --- |
| macOS | `~/Library/Preferences/minch` | `~/Library/Application Support/minch` | `~/Library/Logs/minch` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/minch` | `${XDG_DATA_HOME:-~/.local/share}/minch` | `${XDG_STATE_HOME:-~/.local/state}/minch` |
| Windows | `%APPDATA%\minch\Config` | `%LOCALAPPDATA%\minch\Data` | `%LOCALAPPDATA%\minch\Log` |

Files:

- `config.json` — settings and optional credentials (`0600` on POSIX systems).
- `discovery-cache.json` — normalized snapshots only; no credentials (`0600`).
- `discovery-usage.json` — UTC-month request counts only (`0600`).
- `discovery-ratings-cache.json` — normalized ratings and identity metadata (`0600`).
- `discovery-ratings-usage.json` — UTC-day MDBList attempts (`0600`).
- `imdb-title-ratings.tsv.gz` — optional official dataset; never redistributed (`0600`).
- `minch.log` — structured session, navigation, discovery-load, and crash diagnostics (`0600`).

Run `minch --log-file` to print the exact diagnostic log path. The log rotates
at 2 MiB, keeps one previous file as `minch.log.1`, redacts configured
credentials, and does not record search text.

For isolated tests or portable state, set `MINCH_STATE_DIR`; files then live at
`$MINCH_STATE_DIR/config/config.json` and
`$MINCH_STATE_DIR/data/` under the filenames listed above. Deleting
`discovery-cache.json` resets discovery data; deleting `discovery-usage.json`
is not a quota bypass and should only be done for a clean test state, never to
evade the fixed safety policy.

## Refresh and retention policy

| Source/record | Fresh for | Retained for | Automatic request bound |
| --- | ---: | ---: | ---: |
| TMDB discovery | 12 hours | 7 days | one list page per target |
| Streaming Availability changes | 12 hours | 45 days | up to four pages for additions; one for upcoming |
| India provider dictionary | 30 days | 90 days | one page |
| Blu-ray.com RSS | 24 hours | 30 days | one RSS request |
| 1TamilMV (Firecrawl) | 6 hours | 14 days | up to three listing pages (home + forums + activity) |
| TMDB title enrichment | 7 days | in-memory session cache | only missing fields |
| Exact rating | 24 hours | 30 days | cache-aware enrichment |
| IMDb dataset | checked daily | last good file | one coalesced download |

## Ratings

Source-native TMDB and blended ratings require no exact-IMDb provider and stay
clearly labeled. In Settings, **IMDb ratings source** can remain Off or select
the optional official dataset or MDBList. The dataset is for personal,
non-commercial user-device use and is not packaged. MDBList requires a
user-owned key and warns at 800 calls/day, stopping before call 951. Offline
stale ratings may be shown for up to 30 days. `NR` means no trustworthy rating
or resolved identity, not a score of zero. Clearing keys or switching providers
does not erase cached ratings; delete the ratings files above to remove them.

Fresh cache avoids the network. Stale cache is shown immediately while one
coalesced refresh runs. Expired last-good data is retained on a failed refresh
and clearly marked stale/partial. Press `r` in Discover for a cache-aware manual
refresh; it cannot bypass TTL coalescing, page limits, or the request ledger.

## Quota behavior and diagnostics

Every attempted Streaming Availability request, including retries, is recorded
before the network call. minch warns at 350 attempts in a UTC month and stops
before attempt 451 (450 hard cap). At or above the cap, it shows cached/partial
results and `quota-paused`; it never switches to billable usage. Upstream 429
responses preserve `Retry-After` timing. TamilMV/Firecrawl scrapes warn at 80
attempts per UTC month and hard-cap at 120 (homepage + forums + activity).

Run this read-only command without starting the TUI or contacting a network:

```bash
minch --discovery-status
```

It reports local calls used/limit/remaining per source and never reads or prints
API keys.

## Source limitations

- Discovery dates and availability are source claims; coverage can be
  incomplete or change after publication.
- Current provider availability is not proof of a recent addition. Only change
  events with source timestamps become `streaming_added`.
- TMDB type 5 means generic **Physical**, not Blu-ray. Only explicit RSS
  evidence receives Blu-ray/4K labels.
- Blu-ray RSS has no trustworthy region and is stored as `ZZ`/Unknown region.
- TamilMV rows are latest forum listings scraped via Firecrawl; they are not
  official theatrical/OTT release dates. Topic magnets are not fetched in v1.
- India availability, Indian title origin, and original/audio language are
  separate fields. Missing origin/language remains unknown.
- A source failure never makes another source disappear. Offline/no-cache,
  unconfigured, auth-failed, quota-paused, stale, partial, and genuine empty
  windows have distinct messages.
- The free source stack does not promise a complete global catalogue, scrape
  provider apps, export source datasets, or automatically choose/download a
  torrent.

See [discovery attribution](discovery-attribution.md), the
[source/terms decision](decisions/001-zero-cost-discovery-sources.md), and the
[local reliability audit](discovery-reliability-audit.md) for the exact policy
boundaries.
