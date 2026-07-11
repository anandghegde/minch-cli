# Discovery source fixtures

These fixtures preserve the upstream envelopes and field names verified during
the Phase 0 contract spike. They are intentionally small and are not complete
catalog snapshots.

| Fixture | Capture basis | Endpoint | Records kept |
| --- | --- | --- | ---: |
| `tmdb-discover-movie.json` | Live shape captured 2026-07-10; values anonymized and edge cases added | `GET https://api.themoviedb.org/3/discover/movie?region=IN` | 5 movies |
| `tmdb-movie-release-dates-digital.json` | Live India type-4 shape captured 2026-07-10; IDs anonymized | `GET https://api.themoviedb.org/3/movie/{movie_id}/release_dates` | 2 country records |
| `tmdb-movie-release-dates-physical.json` | Live India type-5 shape captured 2026-07-10; IDs anonymized | `GET https://api.themoviedb.org/3/movie/{movie_id}/release_dates` | 1 country record |
| `tmdb-movie-watch-providers.json` | Live India provider shape captured 2026-07-10; provider values anonymized | `GET https://api.themoviedb.org/3/movie/{movie_id}/watch/providers` | 1 region record |
| `streaming-availability-countries-in.json` | Live India dictionary captured 2026-07-10 and pruned from 9 services | `GET https://api.movieofthenight.com/v4/countries/in?output_language=en` | 5 services |
| `streaming-availability-changes.json` | Live response shape captured 2026-07-10; values anonymized and edge cases added | `GET https://api.movieofthenight.com/v4/changes?country=in&amp;change_type=new&amp;item_type=show` | 5 changes and 5 joined shows |
| `india-feed-matrix.json` | Synthetic normalized snapshots derived from the validated India contracts | Offline aggregation fixture; no endpoint | 6 titles, 6 IN events, 5 provider rows |
| `bluray-new-releases.xml` | RSS shape captured 2026-07-10 at 06:11 UTC; first two title/format observations retained, other values sanitized or synthetic | `GET https://www.blu-ray.com/rss/newreleasesfeed.xml` | 5 items |

Sanitization removed authentication material, request metadata, account data,
irrelevant images, long descriptions, and unrelated response rows. Numeric and
string IDs prefixed with `fixture`, `100`, `900`, or `show-` are test values.
URLs containing a `fixture-` path are non-canonical placeholders.

The synthetic variants cover a missing date, a missing external ID, a missing
RSS GUID, and ambiguous duplicate titles. `original_language: "hi"` exercises
an Indian-language candidate but is not evidence of Indian origin; production
classification must still use an explicit origin-country field. TMDB type `5`
remains generic physical evidence, never Blu-ray evidence.

No Trakt fixture exists. ADR 001 forbids probing or implementing Trakt without
written approval, so inventing a captured response would misrepresent the
validated source contract.
