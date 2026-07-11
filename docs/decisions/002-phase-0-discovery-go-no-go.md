# ADR 002: Phase 0 discovery go/no-go

- Status: Accepted
- Date: 2026-07-10
- Supersedes: later-phase Trakt assumptions in the original implementation plan
- Builds on: [ADR 001](001-zero-cost-discovery-sources.md), the
  [live-contract spike](../discovery-contract-spike.md), and the
  [sanitized fixtures](../../test/discovery/fixtures/README.md)

## Decision

| Source | Decision | Production boundary |
| --- | --- | --- |
| TMDB | **Go, conditional** | User-supplied token, non-commercial use, required attribution, bounded calls, and no claim that watch-provider presence is a provider-addition date |
| Streaming Availability | **Go** | Direct developer host only, user-supplied key, India changes only within the 31-day contract, local 350 warning/450 hard stop, and cached partial results on quota or auth failure |
| Blu-ray.com RSS | **Restricted pilot** | At most one poll per 24 hours; retain only title, advertised date, format marker, GUID/link, and observation metadata; identify and link Blu-ray.com; never infer a region |
| Trakt | **No-go** | No probe, credential prompt, adapter, or fallback without written approval for this application |

The live India changes response contained joinable show records and a real source
timestamp, so Phase 6 can implement genuine `streaming_added` events. The RSS
capture contained usable advertised release dates and explicit Blu-ray/4K title
markers, so it can support a restricted physical-media pilot. TMDB type `5`
remains the only approved generic `physical` fallback.

The RSS pilot does not assume a stable rebuild cadence or an always-present,
permanently stable GUID. Prefer GUID, then canonical item link, then a local
identity derived from normalized title, advertised date, and format. Poll no more
often than the stricter application policy even though the captured feed declared
a shorter TTL. RSS events use the explicit unknown-region sentinel `ZZ`; the UI
must display this as “Unknown region,” never “Global” or `IN`.

## Phase consequences

- Phase 5 is Blu-ray RSS plus cached TMDB generic-physical fallback. Its Trakt
  task is skipped unless this ADR is replaced after written approval.
- If Blu-ray.com asks the project to stop or the feed becomes unavailable, disable
  the RSS adapter and show only explicitly labeled TMDB `physical` events. Do not
  silently replace them with Blu-ray claims.
- Phase 6 proceeds with Streaming Availability because the critical India change
  timestamp, provider identity, cursor, and joined-show contracts were observed.
- Source-specific fixtures, not live network calls, are authoritative for adapter
  unit tests.

## Normalized-field provenance audit

“Derived” means the application computes the field from listed evidence without
inventing a release fact. An optional field remains absent when the source does
not supply it.

| Normalized field | Confirmed source or rule |
| --- | --- |
| `CatalogTitle.id` | Derived deterministic internal identity from available upstream IDs, otherwise a source-scoped local ID |
| `title` | TMDB, Streaming Availability, and Blu-ray RSS |
| `originalTitle` | Optional; TMDB/Streaming Availability when present |
| `year` | Optional; TMDB date or Streaming Availability release/air year |
| `mediaType` | TMDB endpoint/media type, Streaming Availability `showType`, or the Blu-ray Movies feed contract |
| `tmdbId` | Optional; TMDB `id` or Streaming Availability `tmdbId` |
| `imdbId` | Optional; Streaming Availability, or later TMDB external-ID enrichment |
| `traktId` | Optional and dormant while Trakt is no-go |
| `originalLanguage` | Optional; TMDB `original_language` |
| `originCountries` | TMDB origin/production-country details when enriched; otherwise the required array is empty and no origin claim is made |
| `genreIds` | TMDB `genre_ids`; otherwise the required array is empty |
| `posterUrl` | Optional; constructed from a TMDB path only, never fetched during rendering |
| `popularity` | Optional; TMDB popularity |
| `ReleaseEvent.id` | Derived deterministic source/event identity |
| `titleId` | Derived reference to the internal title identity |
| `kind` | Streaming change type, TMDB release type, or explicit RSS Blu-ray/4K marker |
| `region` | Request/source evidence (`IN`) or explicit unknown sentinel `ZZ` for RSS |
| `date` | Optional; source change timestamp or advertised release date |
| `datePrecision` | Derived from the validated source value; `unknown` when `date` is absent |
| `providerId`, `providerLabel` | Optional; live Streaming Availability service dictionary/change object or current-offer enrichment |
| `formatLabel` | Optional; explicit RSS title/category evidence or generic TMDB Physical label |
| `status` | Derived from the honest date and India-local today; `unknown` without a date |
| `firstObservedAt`, `lastObservedAt` | Local observation timestamps; never substituted for a release date |
| `evidence` | Derived provenance collection for every emitted event |
| `SourceEvidence.source` | Adapter identity; Trakt enum value remains dormant while no-go |
| `sourceId`, `sourceUrl` | Optional upstream GUID/ID/link |
| `observedAt` | Local request/cache observation timestamp |
| `confidence` | Derived policy: exact source date, source claim, or documented inference |

## Phase 0 exit gate

The gate passes with the restricted boundaries above:

1. ADR 001 records the source/terms decision and ADR 002 records go/no-go outcomes.
2. Sanitized JSON/XML fixtures exist and parse with repository dependencies.
3. The India changes response supplied a real seconds timestamp joined to a show
   and service.
4. Blu-ray RSS supplied advertised release dates; TMDB supplied a separate India
   Physical type-5 date.
5. Missing facts remain optional, empty, or explicitly unknown rather than being
   synthesized.
