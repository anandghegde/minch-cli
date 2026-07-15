## Architecture decisions to lock first

  Use these conventions throughout:

  export type RatingSystem = "imdb" | "tmdb" | "aggregate";

  export type RatingProvider =
    | "imdb-dataset"
    | "mdblist"
    | "tmdb"
    | "streaming-availability";

  export interface CatalogRating {
    system: RatingSystem;
    provider: RatingProvider;
    value: number;
    scale: 10 | 100;
    voteCount?: number;
    observedAt: number;
  }

  Provider priority:

  1. Exact IMDb rating from the official dataset.
  2. Exact IMDb rating obtained through MDBList when configured.
  3. TMDB rating and vote count.
  4. Streaming Availability blended rating.
  5. NR when none exists.

  Never display TMDB or blended ratings as IMDb. Do not change discovery ordering or add rating filters in this work.

  ———

  ## Step 0: Record the source decision

  Create:

  - docs/decisions/003-discovery-ratings-sources.md

  Record:

  - IMDb dataset is optional, user-device, non-commercial, and never redistributed.
  - MDBList is optional and uses a user-owned key.
  - Apify actors are rejected.
  - TMDB is the fallback and remains labeled TMDB.
  - Exact IMDb coverage is best-effort; unrated and unresolved titles show NR.
  - IMDb attribution text and links.
  - Dataset refresh and cache retention rules.
  - MDBList daily request envelope, for example warning at 800 and stop before 951 requests.

  Gate: do not enable the IMDb dataset by default until the licensing decision is accepted. TMDB fallback can be enabled immediately.

  ———

  ## Step 1: Add rating-domain types

  Modify src/discovery/types.ts:28:

  export interface CatalogTitle {
    // existing fields...
    ratings?: CatalogRating[];
  }

  Add helpers in a new file:

  - src/discovery/ratings/types.ts

  Suggested functions:

  ratingKey(rating: CatalogRating): string;
  normalizeRating(rating: CatalogRating): CatalogRating | undefined;
  selectPreferredRating(ratings: readonly CatalogRating[]): CatalogRating | undefined;
  formatRatingValue(rating: CatalogRating): number; // normalized to 10

  Validation rules:

  - value must be finite and between zero and scale.
  - scale must be 10 or 100.
  - voteCount must be a non-negative integer.
  - observedAt must be a valid non-negative timestamp.
  - Only IMDb ratings can use imdb-dataset or mdblist.

  Update the title validator in src/discovery/cache.ts:111 to accept the optional field. Because it is optional, the existing cache version can remain readable.

  Tests:

  - test/discovery/ratings-types.test.ts
  - Extend test/discovery/cache.test.ts
  - Extend test/discovery/types.test.ts

  Commit gate:

  rtk npm test -- test/discovery/ratings-types.test.ts test/discovery/cache.test.ts
  rtk npm run typecheck

  ———

  ## Step 2: Preserve ratings already returned by current sources

  ### TMDB

  Modify src/discovery/sources/tmdb.ts:53:

  export interface TmdbListRow {
    // existing fields...
    voteAverage?: number;
    voteCount?: number;
  }

  Parse vote_average and vote_count in listRow(). Reject invalid values instead of coercing strings.

  In titleFromRow(), add:

  ratings: [{
    system: "tmdb",
    provider: "tmdb",
    value: row.voteAverage,
    scale: 10,
    voteCount: row.voteCount,
    observedAt,
  }]

  This requires passing observedAt into titleFromRow().

  Also parse these values from TMDB detail responses so enriched titles retain them.

  ### Streaming Availability

  Modify src/discovery/sources/streaming-availability.ts:74:

  export interface StreamingShow {
    // existing fields...
    rating?: number;
  }

  Parse its documented 0–100 rating and attach:

  {
    system: "aggregate",
    provider: "streaming-availability",
    value: show.rating,
    scale: 100,
    observedAt
  }

  It has no vote count, so do not manufacture one.

  ### Aggregation

  Modify mergeTitles() in src/discovery/aggregate.ts:206:

  - Merge ratings by system + provider.
  - For duplicate ratings, select the newest observedAt.
  - Do not include rating presence in title authority or identity decisions.
  - Do not choose the maximum rating.

  Tests:

  - Extend test/discovery/tmdb-client.test.ts
  - Extend test/discovery/tmdb-adapter.test.ts
  - Extend test/discovery/streaming-changes.test.ts
  - Extend test/discovery/aggregate-identity.test.ts

  Commit gate:

  rtk npm test -- test/discovery/tmdb-client.test.ts test/discovery/tmdb-adapter.test.ts
  rtk npm test -- test/discovery/streaming-changes.test.ts test/discovery/aggregate-identity.test.ts
  rtk npm run typecheck

  At this point, the application possesses free fallback ratings, though they are not rendered yet.

  ———

  ## Step 3: Create a separate ratings cache

  Do not put downloaded IMDb data into discovery-cache.json.

  Add paths in src/config/paths.ts:1:

  export const discoveryRatingsCacheFile =
    path.join(dataDir, "discovery-ratings-cache.json");

  export const imdbRatingsDatasetFile =
    path.join(dataDir, "imdb-title-ratings.tsv.gz");

  Create:

  - src/discovery/ratings/cache.ts
  - src/discovery/ratings/cache-repository.ts

  Suggested schema:

  export const RATINGS_CACHE_VERSION = 1;

  export interface CachedRating {
    key: string;
    rating: CatalogRating;
    fetchedAt: number;
    expiresAt: number;
    staleUntil: number;
    datasetEtag?: string;
  }

  export interface CachedIdentity {
    key: string; // tmdb:movie:123 or tmdb:series:456
    imdbId?: string;
    resolvedAt: number;
    expiresAt: number;
    unresolved?: boolean;
  }

  export interface RatingsDatasetMetadata {
    etag?: string;
    lastModified?: string;
    downloadedAt?: number;
    checkedAt?: number;
  }

  export interface RatingsCacheDocument {
    version: 1;
    ratings: Record<string, CachedRating>;
    identities: Record<string, CachedIdentity>;
    missing: Record<string, {
      checkedAt: number;
      expiresAt: number;
      datasetEtag?: string;
    }>;
    dataset: RatingsDatasetMetadata;
  }

  Policies:

  - Rating fresh: 24 hours.
  - Rating stale retention: 30 days.
  - Positive TMDB→IMDb identity: 180 days.
  - Negative identity result: 7 days.
  - Missing rating for current dataset revision: valid until the dataset ETag changes or 24 hours pass.
  - Owner-only file mode 0600.
  - Atomic/coalesced writes using existing utilities.
  - Reject credential-like fields during parsing.
  - Never store MDBList API keys.

  Tests:

  - test/discovery/ratings-cache.test.ts
  - test/discovery/ratings-cache-repository.test.ts
  - Add corrupt-file, unknown-version, invalid-rating, atomic-write, and secret-rejection cases.

  Commit gate:

  rtk npm test -- test/discovery/ratings-cache.test.ts
  rtk npm test -- test/discovery/ratings-cache-repository.test.ts

  ———

  ## Step 4: Implement the official IMDb dataset backend

  Create:

  - src/discovery/ratings/imdb-dataset.ts
  - test/discovery/fixtures/imdb-title-ratings.tsv
  - test/discovery/imdb-dataset.test.ts

  Keep parsing and transport separate.

  ### Pure parser

  Implement a streaming parser accepting:

  parseImdbRatings(
    lines: AsyncIterable<string>,
    wantedIds: ReadonlySet<string>,
  ): Promise<Map<string, CatalogRating>>

  Validate:

  - Header is exactly tconst\taverageRating\tnumVotes.
  - IMDb ID matches ^tt\d+$.
  - Rating is within 0–10.
  - Votes are a non-negative integer.
  - Stop retaining records after every requested ID is found.

  Use synthetic fixture IDs rather than copying real dataset rows.

  ### Downloader

  Implement:

  ensureImdbDataset(options): Promise<{
    file: string;
    etag?: string;
    changed: boolean;
    stale: boolean;
  }>

  Behavior:

  1. Fixed URL: https://datasets.imdbws.com/title.ratings.tsv.gz.
  2. Send If-None-Match and If-Modified-Since.
  3. On 304, update checkedAt without replacing the file.
  4. On 200, stream into a temporary file.
  5. Enforce a compressed-size ceiling, such as 64 MB.
  6. Rename atomically only after a successful download.
  7. Preserve the last-good dataset on failure.
  8. Do not follow redirects to an unrelated host.
  9. Do not download more than once per 24 hours unless no local file exists.

  ### Sparse lookup

  Use Readable.fromWeb(), createGunzip(), and readline to scan the gzip file.

  Do not create a 1.69-million-entry JavaScript map. Instead:

  - Collect requested IMDb IDs.
  - Serve valid cache hits immediately.
  - Scan only for uncached IDs.
  - Retain only matching rows.
  - Coalesce concurrent lookups.
  - If more IDs arrive during a scan, run one additional scan after the current scan rather than concurrently.

  Tests should cover:

  - Valid lookup.
  - Invalid rows skipped.
  - Duplicate IDs.
  - 304.
  - Interrupted download.
  - Oversized response.
  - Stale last-good behavior.
  - Coalesced requests.
  - Dataset revision invalidating negative results.

  Commit gate:

  rtk npm test -- test/discovery/imdb-dataset.test.ts
  rtk npm run typecheck

  ———

  ## Step 5: Resolve TMDB titles to IMDb IDs

  Create:

  - src/discovery/ratings/identity-resolver.ts
  - test/discovery/ratings-identity.test.ts

  Resolution order:

  1. Use CatalogTitle.imdbId.
  2. Read the persistent TMDB→IMDb identity cache.
  3. For titles with tmdbId, use TMDB external IDs.
  4. For an unresolved Blu-ray title, optionally perform strict TMDB search.
  5. Otherwise return unresolved.

  Reuse the existing createTmdbEnricher() from src/discovery/sources/tmdb.ts:552 for external IDs, but persist the result in the ratings cache.

  Use:

  - Maximum concurrency: 4.
  - Positive identity TTL: 180 days.
  - Negative identity TTL: 7 days.
  - Existing TMDB request ledger.
  - Existing cancellation and resilient-fetch behavior.

  Strict Blu-ray matching rules:

  - Search only as a movie.
  - Require normalized title equality.
  - Require exact year equality when the RSS row has a year.
  - Accept only one candidate after validation.
  - Never accept “closest result.”
  - Cache ambiguous matches as unresolved for seven days.

  Prioritize visible rows before off-screen rows, but eventually process the whole current feed.

  Tests:

  - Existing IMDb ID causes no request.
  - Cached identity causes no request.
  - Movie and series use the correct endpoint.
  - Positive and negative TTLs.
  - Ambiguous search is rejected.
  - Exact title/year match accepted.
  - Abort stops remaining queued work.
  - TMDB token never reaches cache or error messages.

  Commit gate:

  rtk npm test -- test/discovery/ratings-identity.test.ts
  rtk npm test -- test/discovery/tmdb-enrichment.test.ts

  ———

  ## Step 6: Add the optional MDBList backend

  Create:

  - src/discovery/ratings/mdblist.ts
  - test/discovery/fixtures/mdblist-imdb-ratings.json
  - test/discovery/mdblist.test.ts

  Use the current batch endpoint:

  POST /rating/{media_type}/imdb?apikey=...

  Request:

  {
    "provider": "tmdb",
    "ids": ["123", "456"]
  }

  Implementation rules:

  - Fixed host: https://api.mdblist.com.
  - Separate movies and series.
  - Batch at most 10 IDs for free accounts.
  - Prefer TMDB IDs, avoiding extra identity calls.
  - Accept IMDb IDs where TMDB IDs are unavailable.
  - Validate every response field.
  - Store only normalized ratings and identifiers.
  - Cache IMDb ratings for 24 hours, stale for 30 days.
  - Honor 429 and Retry-After.
  - Do not retry authentication failures.
  - Do not store response fields unrelated to ratings.

  Because the API key is a query parameter:

  - Build the URL immediately before fetch.
  - Never expose the complete URL through errors.
  - Sanitize the key from all caught errors.
  - Never put the request URL in source evidence.
  - Add tests asserting serialized errors/cache do not contain the key.

  Create a separate daily usage ledger:

  - src/discovery/ratings/usage.ts
  - discovery-ratings-usage.json
  - Warning at 800 MDBList calls/day.
  - Stop before call 951.
  - Each retry counts as an attempt.
  - Do not add MDBList to DiscoverySource; it is a rating provider, not a release source.

  Commit gate:

  rtk npm test -- test/discovery/mdblist.test.ts
  rtk npm test -- test/discovery/ratings-usage.test.ts
  rtk npm run typecheck

  ———

  ## Step 7: Build the rating orchestration service

  Create:

  - src/discovery/ratings/service.ts
  - test/discovery/ratings-service.test.ts

  Public interface:

  export interface DiscoveryRatingsResult {
    byTitleId: ReadonlyMap<string, CatalogRating[]>;
    loading: boolean;
    exactCount: number;
    fallbackCount: number;
    unresolvedCount: number;
    error?: Error;
    refreshedAt?: number;
  }

  export interface DiscoveryRatingsService {
    load(
      titles: readonly CatalogTitle[],
      options: {
        provider: "off" | "imdb-dataset" | "mdblist";
        signal?: AbortSignal;
      },
    ): Promise<DiscoveryRatingsResult>;
  }

  Behavior:

  1. Return source-native TMDB/blended ratings immediately.
  2. Check exact IMDb cache.
  3. If dataset mode:
      - resolve missing IMDb IDs;
      - scan the dataset for those IDs.

  4. If MDBList mode:
      - batch by media type and TMDB/IMDb ID.

  5. Merge exact results without mutating discovery snapshots.
  6. Retain fallback ratings if exact enrichment fails.
  7. Deduplicate concurrent loads.
  8. Abort work when the feed changes.
  9. Never reject the whole result because one title failed.

  Selection logic:

  IMDb exact → TMDB → blended → NR

  Tests should assert that a row never changes from TMDB to a mislabeled IMDb score.

  ———

  ## Step 8: Connect ratings to useDiscovery

  Create:

  - src/ui/hooks/useDiscoveryRatings.ts

  Extend DiscoveryUiModel in src/ui/hooks/useDiscovery.ts:35:

  ratings: ReadonlyMap<string, CatalogRating[]>;
  ratingsLoading: boolean;
  ratingsExactCount: number;
  ratingsFallbackCount: number;
  ratingsUnresolvedCount: number;

  Call the ratings hook after aggregation is computed:

  const ratings = useDiscoveryRatings(
    config,
    aggregation.titles,
    active,
    revision,
  );

  Important behavior:

  - Discovery results render before ratings finish.
  - Rating updates must not trigger source reloads.
  - Feed changes abort old work.
  - r refreshes discovery and asks the ratings layer to revalidate, while all TTL and quota rules remain in force.
  - Use canonical title IDs as the UI map key.

  Tests:

  - Add hook/service integration cases to test/discover-content.test.tsx.
  - Confirm source loading remains independent from rating loading.
  - Confirm cached ratings render while offline.

  ———

  ## Step 9: Add configuration and Settings UI

  Modify src/config/config.ts:47:

  export type ImdbRatingProvider = "off" | "imdb-dataset" | "mdblist";

  export interface DiscoveryConfig {
    // existing fields...
    ratingProvider?: ImdbRatingProvider;
    mdblist?: { apiKey?: string };
  }

  Recommended default:

  - ratingProvider omitted means "off" for exact IMDb enrichment.
  - Source-native TMDB fallback still displays.
  - After licensing approval, change the default in a separate commit.

  Add to src/discovery/config.ts:

  - MDBLIST_API_KEY_ENV
  - resolveMdblistCredential()
  - withMdblistApiKey()
  - withDiscoveryRatingProvider()

  Update:

  - src/ui/components/Settings.tsx:14
  - src/ui/store.ts:89
  - src/ui/App.tsx:457
  - .env.example

  Settings rows:

  IMDb ratings source       Off / Official dataset / MDBList
  MDBList API key           not configured / •••••••• / env

  Interaction:

  - Left/right cycles the rating provider.
  - Selecting MDBList without a key shows an actionable notice.
  - Environment credentials remain read-only.
  - Clearing the key does not delete cached ratings.
  - Switching providers does not delete either provider’s cache.

  Tests:

  - Extend test/config.test.ts
  - Extend test/discovery/config.test.ts
  - Extend test/app-debrid.test.tsx or add test/settings-ratings.test.tsx

  Commit gate:

  rtk npm test -- test/config.test.ts test/discovery/config.test.ts
  rtk npm test -- test/settings-ratings.test.tsx

  ———

  ## Step 10: Render ratings in every Discover feed

  Modify src/ui/components/Discover.tsx:498.

  Add formatting helpers:

  formatVoteCount(146_281) // "146K"
  formatVoteCount(1_420_000) // "1.4M"
  formatDiscoveryRating(rating) // "IMDb 8.4 · 146K"

  Row states:

  IMDb 8.4 · 146K
  TMDB 7.9 · 12K
  Score 82
  IMDb …
  NR

  Use … only while exact enrichment is pending and no usable fallback exists.

  Responsive layout:

  - >= 100 columns: IMDb 8.4 · 146K
  - 80–99: IMDb 8.4 146K, hide the source column first.
  - 70–79: 8.4/146K, add a small IMDb rating/votes legend.
  - < 70: remove provider/event width before removing rating/vote information.
  - Recalculate titleWidth; do not merely append another box to the current layout.

  Details view in src/ui/components/Discover.tsx:162:

  IMDb: 8.4/10 · 146,281 votes
  Rating provider: Official IMDb dataset
  Observed: 6h ago

  For MDBList:

  Rating provider: MDBList · IMDb rating

  For an unrated title:

  IMDb: Not rated or identity unavailable

  Tests:

  - Wide, medium, narrow, and very narrow terminal widths.
  - Movie and series.
  - Every feed: Trending, OTT, Blu-ray, India.
  - Exact IMDb, TMDB fallback, blended fallback, loading, and NR.
  - Exact count in details.
  - No terminal overflow.

  Commit gate:

  rtk npm test -- test/discover-content.test.tsx

  ———

  ## Step 11: Attribution, help, and documentation

  Modify:

  - src/discovery/attribution.ts
  - src/cli/args.ts
  - src/ui/components/HelpOverlay.tsx
  - docs/discovery-attribution.md
  - docs/discovery-setup.md
  - README.md
  - .env.example

  Add the required IMDb notice:

  Information courtesy of IMDb (https://www.imdb.com). Used with permission.

  Document:

  - Dataset location and daily refresh.
  - Personal/non-commercial restriction.
  - No dataset redistribution.
  - MDBList key configuration.
  - Ratings can be stale while offline.
  - NR does not mean a zero rating.
  - TMDB fallback remains clearly labeled.
  - New local files and deletion behavior.
  - Monetization/licensing review gate.

  Do not package the downloaded gzip file. It remains under the user’s application data directory.

  Extend test/discovery/attribution-surfaces.test.ts to require IMDb notices on all relevant surfaces.

  ———

  ## Step 12: Add diagnostics

  Extend minch --discovery-status with a separate ratings section:

  Ratings
    Provider: IMDb dataset
    Dataset checked: 6h ago
    Dataset revision: <etag fragment>
    Cached exact ratings: 184
    Cached unresolved identities: 7

  MDBList
    Calls today: 18 / 950 local safety cap

  Do not add rating providers to DiscoverySource; keep release-source diagnostics and rating-provider diagnostics distinct.

  Never print:

  - MDBList key.
  - Full URLs containing apikey.
  - Raw cached responses.
  - IMDb dataset contents.

  Add tests to test/discovery/diagnostics.test.ts.

  ———

  ## Step 13: Full acceptance matrix

  Run these scenarios manually or in Ink tests:

   Feed           Movie      Series    Exact IMDb    Fallback          NR
  ━━━━━━━━━━  ━━━━━━━━━━  ━━━━━━━━━━  ━━━━━━━━━━━━  ━━━━━━━━━━  ━━━━━━━━━━
   Trending    Required    Required      Required    Required    Required
  ──────────  ──────────  ──────────  ────────────  ──────────  ──────────
   OTT         Required    Required      Required    Required    Required
  ──────────  ──────────  ──────────  ────────────  ──────────  ──────────
   Blu-ray     Required         N/A      Required    Required    Required
  ──────────  ──────────  ──────────  ────────────  ──────────  ──────────
   India       Required    Required      Required    Required    Required

  Also verify:

  - First launch with no rating provider.
  - Dataset download success.
  - Dataset offline with stale cache.
  - MDBList configured/unconfigured/401/429.
  - TMDB identity lookup failure.
  - Ambiguous Blu-ray title.
  - Upcoming unrated title.
  - Feed switching during enrichment.
  - Manual refresh.
  - Narrow terminal.
  - Corrupt cache recovery.
  - No credential leakage.

  Final verification:

  rtk npm run typecheck
  rtk npm test
  rtk npm run build
  rtk npm run acceptance:discovery
  rtk git diff --check

  ## Suggested PR/commit grouping

  1. ratings: add domain model and preserve source ratings
  2. ratings: add isolated cache and repository
  3. ratings: ingest official IMDb ratings dataset
  4. ratings: persist TMDB to IMDb identity resolution
  5. ratings: add optional MDBList backend and daily budget
  6. ui: enrich and render Discover ratings
  7. settings: configure IMDb rating providers
  8. docs: add ratings attribution and operational guidance

  Definition of done: every Discover row shows exact IMDb rating/votes when available, a correctly labeled fallback otherwise, and NR when no trustworthy value exists—without
  delaying discovery results or leaking credentials.
