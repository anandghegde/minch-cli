# minch-cli 0.2.0

This beta release adds zero-cost release discovery while keeping torrent search
and discovery as separate domains.

## Highlights

- Discover feeds for TMDB Trending, India OTT changes, Blu-ray/4K claims, India
  OTT charts, and weekly Letterboxd community popularity.
- Date, provider, language, media, format, and Indian-origin filters.
- Clean title/year handoff from a discovery row to torrent search.
- Persistent stale-while-revalidate cache, per-source status, offline fallback,
  source attribution, and a hard local request budget.
- Correct torrent date semantics and normalized torrent category filtering.

## Release evidence

- Two refresh-interval-separated operational samples completed with 9 successful
  refreshes, no source errors, 134 unique titles, and 116 unique events.
- All five release-blocking acceptance metrics pass, including a conservative
  249-call 31-day Streaming Availability projection under the 300-call target
  and 450-call hard cap.
- The search-handoff review completed across 20 titles without adding provider
  or format noise to production queries.

## Known limitations and follow-up

- Discovery coverage and upstream dates remain source claims and may be
  incomplete.
- Blu-ray RSS evidence has unknown region unless the source states one.
- TMDB use remains limited to qualifying non-commercial use unless separately
  licensed.
- The seven-day operational soak and 30 OTT/20 physical human relevance review
  continue after release. Their incomplete status remains visible and is not
  reported as a pass.

See [Discovery setup and operations](discovery-setup.md) for credentials,
refresh behavior, data locations, attribution, and source limitations.
