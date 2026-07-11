# Discovery beta validation

Phase 11 validation is local and opt-in. It does not transmit diagnostics or
copy the sampled catalogue into the repository. Set `MINCH_BETA_DIR` to the
same ignored, persistent directory used by `beta:discovery` before running the
commands below.

## P11.2 post-release relevance review

This review remains valuable evidence, but it is not a beta-release blocker.
Until it is complete, acceptance reports the high-confidence accuracy metric as
`pending` with `releaseBlocking: false`; it never substitutes an unreviewed row
with a pass.

The beta scheduler cannot take an early sample just to fill the physical queue.
After the recorded 24-hour RSS boundary (`2026-07-11T06:11:00Z`), refresh only
the Blu-ray target in the isolated cache, then extend the review:

```sh
npm run refresh:discovery-physical
npm run review:discovery -- init
```

The refresh command refuses the pre-boundary call, shares the beta scheduler
lock, uses the normal 24-hour cache policy and request ledger, and prints only
counts. Repeating it inside the TTL is a zero-request fresh-cache read. It does
not create a beta sample or call TMDB/Streaming Availability.

Initialize or extend the deterministic sample from canonical cached events:

```sh
npm run review:discovery -- init
npm run review:discovery -- list ott pending
npm run review:discovery -- list physical pending
```

The initializer retains prior judgments, samples at least 30 OTT and 20
physical events when enough evidence exists, and interleaves provider/format
and media buckets. Repeated retained snapshots are canonicalized before
sampling, so they cannot consume the quota more than once.

For every row, check all five claims against the linked source evidence and the
source's own record:

1. `title`: title, year, and media type identify the same work.
2. `date`: an OTT date comes from the change timestamp and a physical date from
   the advertised release claim. Current availability or local observation time
   is not date evidence. OTT rows retain the raw source Unix timestamp and show
   its India-date conversion beside the normalized date.
3. `provider_or_format`: the named service or Blu-ray/4K/physical label is
   supported by the source claim.
4. `region`: India OTT/TMDb claims say `IN`; restricted Blu-ray RSS claims stay
   `ZZ` unless the source itself supplies a region.
5. `duplicate_behavior`: an identical semantic claim appears once, while a
   distinct provider, format, region, or date remains a separate event. The
   sample includes merged-evidence and related-title counts as review context.

Record a clean row or name every erroneous field:

```sh
npm run review:discovery -- record <sample-id> pass
npm run review:discovery -- record <sample-id> error date,provider_or_format "short evidence note"
npm run review:discovery -- record <sample-id> unverifiable "source page unavailable"
npm run review:discovery -- status
npm run review:discovery -- finalize
```

`unverifiable` requires a note and does not count toward the 30/20 completion
gate. `finalize` reports errors by source and error type. Its high-confidence
P11.4 accuracy is event-level: an event is correct only when its title, date,
and provider-or-format checks all pass. Region and duplicate checks remain
visible separately, and inferred events are excluded.

The ignored `relevance-review.json` contains the titles and evidence links needed
for resumption and is written mode `0600`. Commit only aggregate counts and
error categories to the execution log, never the local review rows.

## P11.3 search-handoff review

Initialize a deterministic 20-title queue from the same canonical cache. The
queue interleaves movie/series and known original-language buckets:

```sh
npm run review:discovery-handoff -- init
npm run review:discovery-handoff -- status
```

The runner calls the same title/year query builder and torrent source contract
as the Discover handoff. By default it uses enabled, healthy public sources
from a bounded validation set (`thepiratebay`, `solidtorrents`, `bitsearch`,
`yts`, and `nyaa`). Override that set with a comma-separated
`MINCH_HANDOFF_SOURCE_IDS` value when the normal source configuration calls for
it. Each source has a 20-second timeout and a 50-row soft limit. Run one row at
a time for easy inspection or all remaining rows for the planned sample:

```sh
npm run review:discovery-handoff -- run 1
npm run review:discovery-handoff -- run 20
npm run review:discovery-handoff -- compare-noise 20
npm run review:discovery-handoff -- list launched
```

Only sanitized top-result names, seed counts, relevance flags, aggregate
counts, and source outcome codes are retained. Magnets, hashes, URLs, raw
errors, and credentials are not stored. For each launched row, compare the
ranked top results with the canonical title/year. Record `pass` when the query
and useful results identify the selected work, `error` when the handoff adds
noise or ranks the wrong work, and `unverifiable` when source failures or an
empty catalogue prevent a conclusion:

```sh
npm run review:discovery-handoff -- record <sample-id> pass
npm run review:discovery-handoff -- record <sample-id> error "wrong work ranked first"
npm run review:discovery-handoff -- record <sample-id> unverifiable "all sources unavailable"
npm run review:discovery-handoff -- finalize
```

Finalization requires at least 20 launched and assessed titles, at least one
movie and one series, at least three known original languages, exact agreement
with the production query builder, and zero appended provider/format queries.
It also reports top-result relevance and whether query-aware ranking improved,
tied, or regressed versus the legacy popularity order. The ignored
`search-handoff-review.json` is owner-only; commit only its aggregate summary.

`compare-noise` is a validation-only paired baseline for sampled rows that
have provider or format metadata. It repeats those searches with that one
metadata label appended, records only aggregate result/outcome counts, and
never changes or exercises the production handoff query. Finalization also
requires at least five comparisons (or every eligible row when fewer exist),
more relevant results in aggregate from clean queries, and more clean wins
than noisy wins.

## P11.4 acceptance status

Read the current gate without refreshing an upstream or changing the beta
ledger:

```sh
npm run acceptance:discovery -- status
npm run acceptance:discovery -- finalize
```

`status` directly exercises the production torrent date filter, discovery date
selection, availability classification, and partial-source aggregation. It
also audits every retained cache event: dated Streaming rows must match the raw
change timestamp encoded in their source record, dated TMDB/Blu-ray rows need
non-inferred source evidence, and every `streaming_added` row needs a real
Streaming Availability change timestamp. It combines those checks with the
owner-only beta and relevance reports and the current Streaming Availability ledger. The 31-day projection is
conservative: the observed bootstrap cost plus the maximum recurring sample
cost for every remaining 12-hour slot. One sample is insufficient and stays
`pending`; with the observed five-call bootstrap and four-call recurring work,
the projection is 249 calls.

Every metric reports `pass`, `fail`, or `pending` and explicitly states whether
it blocks release. `finalize` requires two spaced operational samples and all
five release-blocking metrics to pass. The 30/20 human relevance metric and the
seven-day/15-sample/seven-India-date soak remain visible as post-release work,
but neither blocks the beta release. The command is read-only and outputs
aggregate evidence only.
