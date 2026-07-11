# Discovery release sample and post-release soak runbook

P11.1 uses an isolated, ignored directory and never writes raw titles to its
report. Two samples separated by the normal refresh interval are the release
gate. The same runner can continue for seven days as a non-blocking soak.
Normalized cache remains separate; the report stores counters, source/error
codes, target states, and hashed canonical identities only.

Start or take the next due sample:

```bash
MINCH_BETA_DIR="$PWD/.minch-beta/2026-07-10" npm run beta:discovery -- sample
```

The first sample in this run uses `MINCH_BETA_SKIP_BLURAY=1` because the last
contract probe's 24-hour Blu-ray.com polling interval does not permit another
RSS request until 11 July 2026 06:11 UTC. Remove that flag only after the
boundary. Subsequent service/cache policy naturally limits RSS to once per 24
hours.

Take samples near the 12-hour schedule. Calls less than ten hours after the last
recorded sample are a read-only no-op. An owner-only cross-process lock prevents
overlapping schedulers from duplicating a refresh and safely expires after one
hour if a process crashes. Check progress without network access:

```bash
MINCH_BETA_DIR="$PWD/.minch-beta/2026-07-10" npm run beta:discovery -- status
```

`status` reports `releaseReady: true` after two spaced samples. This is enough
for the release acceptance gate; an immediate repeat remains a read-only no-op
and is not counted as independent evidence.

The optional post-release soak finalizer refuses to pass until at least seven
elapsed days, fifteen samples (both ends of fourteen 12-hour intervals), and
seven distinct India-local sample dates are present:

```bash
MINCH_BETA_DIR="$PWD/.minch-beta/2026-07-10" npm run beta:discovery -- finalize
```

The soak is useful for observing source drift, cache TTL behavior, and transient
failures, but it does not block a beta release. The recorded summary covers
attempted requests, successful refreshes, stale periods, source errors, unique
titles/events, unknown dates, and ambiguous merges. Credential values never
enter the report or command output.
