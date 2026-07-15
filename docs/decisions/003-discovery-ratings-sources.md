# ADR 003: discovery rating sources

Status: accepted for implementation; the official IMDb dataset remains opt-in.

minch may show source-native TMDB ratings and Streaming Availability blended
scores immediately, with their source labels intact. Exact IMDb enrichment is
best-effort: unrated titles and identities that cannot be resolved display
`NR`; a TMDB or blended score is never presented as IMDb.

The official `title.ratings.tsv.gz` dataset is an optional download to the
user's device for personal, non-commercial use. It is never bundled,
redistributed, exported, or copied into the discovery snapshot cache. Enabling
it requires an explicit user setting; it must not become the default until a
separate licensing review accepts that decision. The file is checked at most
daily, downloaded atomically, and the last good copy is retained after a
failed refresh. Exact values are fresh for 24 hours and retained stale for 30
days. Positive TMDB-to-IMDb identities are retained 180 days, negative
identities seven days, and a missing rating is rechecked after 24 hours or when
the dataset ETag changes.

MDBList is also optional and uses only a user-owned key. Its exact ratings use
the same 24-hour/30-day cache policy. A separate local daily ledger warns at
800 calls and stops before call 951; retries count as attempts. API keys and
complete authenticated URLs are never cached or printed.

Apify actors are rejected because they introduce an intermediary and unclear
redistribution boundaries. TMDB remains the labeled fallback, followed by the
labeled Streaming Availability aggregate score.

All IMDb surfaces carry: “Information courtesy of IMDb
(https://www.imdb.com). Used with permission.” Dataset and API use must be
reviewed again before monetization, redistribution, or any default-on change.
