# Discovery rate-limit audit

Audit date: 10 July 2026.

## Enforced behavior

| Control | Evidence |
| --- | --- |
| Every network attempt is counted | TMDB and Streaming Availability transports place ledger accounting inside the retried fetch function; transient-response tests prove two attempts produce two ledger records. |
| Refresh coalescing | Concurrent identical cache misses share one in-flight refresh and one cache write. |
| Source TTLs | Fresh entries make no network call; stale entries return immediately and refresh once; expired entries retain the last good snapshot on failure. Provider dictionaries use their separate 30-day fresh / 90-day retained policy. |
| Cursor/page bounds | Discovery requests reject more than four pages. OTT pagination stops at the requested cap, deduplicates events, and terminates repeated cursors; upcoming OTT and TMDB list calls remain one page in automatic UI loads. |
| Monthly hard stop | Streaming Availability warns at attempt 350 and refuses attempt 451. Concurrent callers at 449 admit exactly one final attempt. Trakt remains structurally capped at zero. |
| Retry timing | Terminal 429 responses preserve `Retry-After`; each retry is metered before the request. |

The fixed automatic UI plan still uses at most four calls for one OTT additions
refresh, one call for an upcoming refresh, and cache-first provider dictionary
loads. No retry, cursor, or manual refresh can bypass the ledger.

## Local diagnostic command

`minch --discovery-status` reads the local ledger without loading credentials,
recording a request, starting Ink, or contacting a network. It reports the UTC
month and calls used/limit for every discovery source. Example from the audit:

```text
Discovery request usage · 2026-07 UTC · local only
TMDB                      0/unlimited     no local hard cap
Blu-ray.com RSS           0/unlimited     no local hard cap
Streaming Availability    1/450           449 remaining · warning at 350
Trakt                     0/0             disabled by policy
```

The output contains counters and fixed source labels only. It does not inspect
or display API keys, credential source, request URLs, or cached titles.
