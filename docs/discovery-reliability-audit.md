# Discovery offline and partial-failure audit

Audit date: 10 July 2026.

The scenarios below exercise the same cache, service, source-state, aggregation,
and Ink rendering boundaries used by Discover. Network outcomes are injected so
the audit is deterministic and cannot consume live request allowance.

| Scenario | Observed behavior | User-visible result |
| --- | --- | --- |
| Offline with cache | An expired last-good snapshot is retained and the failed refresh does not overwrite it. | Cached rows remain visible as stale/partial, with their original refresh time. |
| Offline without cache | The service returns a cache miss and the adapter becomes independently failed. | “Sources are offline or unavailable” and “no cached discovery data”; no zero-result claim. |
| One adapter fails | A ready peer remains usable and the failed peer keeps its own warning/status. | Rows from the healthy source remain; if it has no events, the count is explicitly incomplete. |
| All adapters fail | Each failure remains independent and aggregation reports zero usable snapshots. | Results are described as unavailable/incomplete, followed by offline/no-cache guidance. |
| Corrupt cache | Invalid JSON is rejected as an empty cache with a local `documentError`; the subsequent offline refresh is a miss. | The screen does not treat corrupt bytes as a valid empty release feed. It shows offline/no-cache guidance. |
| OTT quota paused | A local hard-cap or HTTP 429 becomes `quota-paused`; no request is silently presented as successful. | With no cache, the screen says the request quota is paused and cached data is unavailable. |

Every degraded empty state uses “Results unavailable or incomplete” instead of
“0 results.” A healthy, successfully fetched empty snapshot may still report a
genuine empty event window.

Verification:

```bash
npm test -- test/discover-content.test.tsx test/discovery/service.test.ts \
  test/discovery/state.test.ts test/discovery/cache-repository.test.ts
npm run typecheck
```
