# Discovery attribution requirements

Discovery screens, help, details, diagnostics, and future graphical surfaces
must preserve the attribution metadata returned by each adapter. A source URL
must remain available even when the rest of a snapshot is served from cache.

Every surface must also state that discovery dates, formats, and availability
are source claims and that coverage may be incomplete. Current availability is
not an arrival date; local `firstObservedAt` is never a release date.

## TMDB

- Display the source label as **TMDB** or **The Movie Database** and link it to
  <https://www.themoviedb.org>.
- Place this notice prominently in Discover help/details and in an About or
  Credits surface: “This product uses the TMDB API but is not endorsed or
  certified by TMDB.”
- Graphical surfaces must use an approved TMDB logo from
  <https://www.themoviedb.org/about/logos-attribution>. Do not alter its color,
  aspect ratio, rotation, or orientation; keep it less prominent than the
  minch-cli identity and do not imply endorsement.
- Terminal-only views that cannot render the approved bitmap/vector mark must
  still show the TMDB label, link, and notice. Package documentation or any
  graphical distribution surface must additionally use an approved logo.
- When TMDB watch-provider data is displayed, also identify **JustWatch** as the
  provider of that availability data. A provider’s current presence is never a
  provider-addition timestamp.
- Use title links such as `https://www.themoviedb.org/movie/{id}` or
  `https://www.themoviedb.org/tv/{id}` when an ID is known.

TMDB developer access remains limited to qualifying non-commercial use. Review
licensing before any revenue-generating distribution, and never cache TMDB
content beyond the limits recorded in ADR 001.

## Streaming Availability API by Movie of the Night

- Display **Streaming Availability API by Movie of the Night** and link to
  <https://www.movieofthenight.com/about/api> beside its data and in Credits.
- Retained cached data keeps its attribution after a subscription ends.
- Do not expose a raw snapshot, bulk export, proxy, or downstream API.

## Blu-ray.com

- Identify **Blu-ray.com** and retain the original item/source link for every
  RSS claim when the link is safe.
- Describe dates as advertised source dates and the region as unknown when the
  feed supplies no trustworthy region.
- The restricted pilot does not copy descriptions, artwork, reviews, or a bulk
  catalogue and must be disabled if the source asks the project to stop.

## Licensing review gate

Re-review the current terms before monetization, redistribution/export work, a
new graphical distribution, or any source/allowance change. TMDB must remain
disabled for a revenue-generating distribution until a separate written
commercial agreement permits it.
