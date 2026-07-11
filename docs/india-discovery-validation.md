# India discovery sampled-week validation

Validated on 10 July 2026 for the inclusive India-local window 4–10 July 2026.

## Method and privacy boundary

The validation command requested one page of India additions for Netflix, Prime
Video, and Hotstar/JioHotstar. It used the normal request ledger, disabled
retries, and had a 20-second timeout. Its output included aggregate counts only:
no title names, source payloads, credentials, descriptions, or deep links.

The aggregates were compared manually with these official editorial sources:

- [Netflix: New to Watch](https://about.netflix.com/en/new-to-watch) — a global
  editorial calendar, not an India catalogue change log.
- [Amazon India: Prime Video lineup](https://www.aboutamazon.in/news/entertainment/new-upcoming-shows-movies-prime-video-india) — an India editorial slate, not a
  complete additions feed.
- [JioStar press announcement](https://cdn.jiostar.com/jiostar/wp-content/uploads/2026/07/Mollywood-Times.pdf) — an official announcement dated immediately before the
  sampled window, used to check the lower date boundary.

No editorial text or title list was copied into this repository.

## Source sample

| Measure | Observed |
| --- | ---: |
| Request attempts | 1 |
| Page limit | 1 |
| Events | 25 |
| Events with source dates | 25 |
| Events without source dates | 0 |
| Movies / series | 17 / 8 |
| Netflix / Prime Video / Hotstar events on the returned page | 25 / 0 / 0 |
| Events with original-language metadata | 0 |
| More pages available | Yes |

The page was saturated and returned a continuation cursor. Therefore, provider
counts describe only the first page; zero Prime Video or Hotstar rows is not
evidence that either provider had no additions during the week.

## Comparison outcomes

- The global Netflix calendar contained releases throughout the sampled week.
  This is consistent with an active release cadence, but its global scope cannot
  prove India availability or a one-to-one event match.
- Amazon India's editorial slate covered the sampled period and described broad
  language/provider activity. The first API page did not expose Prime Video
  rows, but truncation makes this comparison inconclusive rather than a recorded
  mismatch.
- The official JioStar announcement fell one day before the inclusive lower
  boundary. Its absence from the 4–10 July sample is the expected date-window
  result, not a coverage failure.
- The sample contained both movies and series, and every returned event had a
  source-supplied date. Original-language metadata was absent for all 25 events,
  confirming that language and title-origin filters depend on cached enrichment
  and must preserve an explicit unknown state.

## Result and limitation

The sampled-week check passes the bounded-request, date, media-type, and
privacy mechanics. It does **not** establish complete provider coverage: a
single page cannot support that claim, and editorial calendars are not
catalogue change logs. The CLI must continue to surface truncation, unknown
metadata, supported-provider scope, and source-specific gaps instead of
presenting the feed as complete.

Run `npm run validate:discovery-india` only as an intentional live check. It
spends one Streaming Availability request and is not part of `npm test`.
