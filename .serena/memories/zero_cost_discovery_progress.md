# Zero-cost discovery compact handoff

## Status

- P0.1/P0.2 complete; P0.3 `[~]` in progress; P0.4 not started.
- Fixed direct-only Streaming transport is complete; no selector/RapidAPI runtime support.
- Live TMDB and Streaming Availability semantic contracts are proven and recorded in `docs/discovery-contract-spike.md`.
- User confirmed local Streaming monthly budget: allowance 500, warning 350, hard stop before request 451, safety margin 50.
- Sole remaining P0.3 action: conditional Blu-ray RSS comparison after 2026-07-11T06:11:00Z using prior ETag `"6a4f67ec-a917"`.

## Budget policy

- Encoded in `scripts/discovery-contract-spike.ts` report as `localMonthlyBudget` with source `user-confirmed-local-policy`.
- `providerPublishedAllowance` remains `not-exposed-in-response-headers`; docs clearly say 500 is local policy, not a provider quota claim.
- Lower upstream enforcement must yield cached/quota-paused behavior and never paid usage.
- Tests assert allowance 500 / soft 350 / hard 450 / margin 50.

## Verification

- `npm test -- --run test/discovery-contract-spike.test.ts`: 5 passed.
- `npm run typecheck`: passed.
- `git diff --check`: passed.
- Plan, ADR 001, contract record, runner, and test updated consistently.

## Blocked audit after resume

External RSS interval is still pending, but meaningful progress was completed this turn by confirming/encoding the local budget. Do not mark the resumed goal blocked. Current observed time was 2026-07-10T10:08:18Z.

## Resume P0.3 only

At or after 2026-07-11T06:11:00Z, make exactly one conditional GET to Blu-ray RSS with the prior ETag. Record HTTP status, ETag, Last-Modified, feed pubDate/lastBuildDate, GUID overlap/stability, date zones, format markers, and whether content changed. Then decide P0.3 completion and compact before P0.4.