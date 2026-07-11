# minch-cli codebase review

**Review date:** 2026-07-09  
**Scope:** current working tree, including the uncommitted Settings and search-caret work. No product code was changed during this review.

## Remediation update — 2026-07-09

The findings below were the original review snapshot. The current working tree
now implements the recommended safety and correctness work:

- P1 query/Cardigann behavior, persistence security and shutdown flushing, and
  download destination/handle ownership are covered by dedicated regressions.
- HTTP retries dispose abandoned bodies; debrid responses retain quota metadata;
  Cardigann source rates, persisted source validation, selected YTS mirrors,
  and stale retest merges are enforced.
- Download range identity/refresh continuity, input editing, narrow-terminal
  presentation, deterministic sorting, and helper input guards are covered.
- App composition now delegates config persistence, source orchestration, and
  high-frequency download snapshots to focused hooks/contexts.

The historical locations and recommendations are retained below for traceability.

## Executive summary

The project has a strong foundation: strict TypeScript, coherent package boundaries, useful pure helpers, and a broad test suite. The main risks are not an architectural rewrite problem; they are a small number of correctness gaps at system boundaries:

- query operators do not fully implement the advertised semantics;
- Cardigann's row-local template state can leak into the next result, and POST definitions lack a form content type;
- configuration writes can fail or be terminated silently, and their temporary file is briefly less protected than the final credentials file;
- concurrent downloads can choose the same output path, and the segmented path renames while its handle is open.

Address the P1 items before adding more source types or UI features. Then focus on consolidating request execution and breaking up `App.tsx`; those two refactors will make subsequent provider/source work markedly safer.

## Validation performed

- `npm run typecheck` — passed.
- `npm test` — passed: 28 files, 300 tests.
- `npm audit --omit=dev --json` — no production dependency vulnerabilities reported.
- `git diff --check` — passed.
- Performed focused runtime checks for quoted phrases, exclusion-only queries, Cardigann row-state isolation, POST request headers, and malformed Torznab config. The expected failures are documented below.

The existing worktree contains unrelated user changes in `src/ui/App.tsx`, `src/ui/components/HelpOverlay.tsx`, `src/ui/components/SearchBar.tsx`, `src/ui/store.ts`, `test/app-debrid.test.tsx`, plus new `Settings.tsx` and `searchbar.test.tsx`; they were reviewed but left untouched.

## Findings

### P1 — correctness, safety, or data-loss risk

#### 1. Configuration persistence is neither observable nor guaranteed before exit

**Locations:** `src/ui/App.tsx:127-131`, `src/util/atomic.ts:5-10`, `src/index.tsx:34-44`

`persist` deliberately discards `saveConfig`'s promise. More importantly, `serializeWrites` catches a failed task and returns the recovered chain, so a caller cannot observe a failed write at all. `forceExit` then calls `process.exit()` immediately after unmounting. Saving a credential or setting and immediately pressing `q` can terminate the process before the atomic rename; disk-full, permission, or rename failures are silent.

**Recommendation:**

- Change `serializeWrites` to return each task's original promise while retaining a recovered internal queue for later writes.
- Make persistence a first-class service with `save`, `lastError`, and `flush`/`close` methods.
- Await a bounded `flush` in the graceful quit path; surface a failed save as a visible error instead of reporting success optimistically.
- Add tests for a rejected write and a save immediately followed by shutdown.

#### 2. Credential temp files are not created owner-only

**Location:** `src/util/atomic.ts:24-30`

The final `config.json` is intended to be `0600`, but `writeJsonAtomic` writes `<config>.tmp` using the default mode and only calls `chmod` afterwards. On a multi-user machine the secret can be readable during that window; an error before `chmod` can leave a broader-permission temporary credential file behind.

**Recommendation:** Open/create the temporary file with mode `0o600` before writing (for example `fs.open(tmp, "w", 0o600)`), then write, sync, close, and rename. Clean up the temp file on failure where safe. Test the temporary-file mode, not only the destination mode.

#### 3. Cardigann POST searches omit `application/x-www-form-urlencoded`

**Location:** `src/cardigann/executor.ts:571-603`

`fetchSearchPage` serializes POST inputs with `URLSearchParams(...).toString()` but never sets `Content-Type`. A focused execution with a mocked fetch recorded `contentType: null` and `body: "q=foo"`. With the real Fetch implementation this is typically inferred as `text/plain;charset=UTF-8`, which many indexers will not parse as a form. The vendored `noname-club.yml` currently has a POST search path.

**Recommendation:** When `req.method === "post"` and a form body exists, set `Content-Type: application/x-www-form-urlencoded;charset=UTF-8` unless the definition explicitly overrides it. Add an executor test that asserts the final request method, body, and header.

#### 4. Cardigann `.Result.*` variables leak across result rows

**Locations:** `src/cardigann/executor.ts:476-535`; definitions such as `definitions/public/1337x.yml`, `torrent9.yml`, and `noname-club.yml`

`parseResults` passes one mutable `vars` object to every `processRow`; that function writes `.Result.<field>` into it. When an optional field is absent in row N+1, a template in that row can read row N's value. A focused two-row parse produced titles `["first", "first"]` even though only the first row contained the optional title input.

**Recommendation:** Create a `rowVars` copy for every row, use it for all selectors/defaults/templates in that row, and never merge `.Result.*` values back into the request-level variables. Add a regression fixture with an optional selector present only in the first row.

#### 5. Quoted phrases with stop words never match, and exclusion-only queries do nothing

**Locations:** `src/sources/relevance.ts:70-180`, `src/sources/relevance.ts:338-345`, `src/sources/relevance.ts:447+`, `src/sources/query.ts:58-83`

`parseQuery` correctly preserves stop words inside phrases, but `matchScore` tokenizes the result name with `tokenize`, which removes stop words. Therefore `"the matrix"` cannot match `The Matrix`: the focused check returned `{ tier: 0, score: 0 }`. Separately, `isEmptyQuery` ignores `exclude`; `rankResults([{ name: "Movie CAM" }], "-cam")` returned the CAM row instead of filtering it out.

**Recommendation:**

- Use `tokenizePhrase(name)` for phrase comparison and retain the existing stop-word-stripped token stream only for free-text matching.
- Apply exclusions before the empty-query fast path, and make `filterByRelevance` apply them too so manual sorts preserve query intent.
- Add table-driven tests for phrase-only queries, phrases containing stop words, only-exclude queries, quote/exclude combinations, and strict mode with each form.

#### 6. Output-path selection is a non-atomic check-then-use operation

**Locations:** `src/download/accelerator.ts:208-223`, `src/download/manager.ts:201-221`

`resolveCollision` checks whether the final path exists, then later `downloadFile` creates `<dest>.part`. Two active downloads with the same resolved filename can both select the same destination before either creates its part file. This is reachable from parallel “download all” actions and across providers. They can write one part file concurrently or race to rename it.

**Recommendation:** Reserve destinations atomically in `DownloadManager` before starting a transfer, including `.part` and sidecar ownership; release the reservation only after terminal state. Alternatively, create a unique part file with exclusive open and retry the candidate suffix on `EEXIST`. Test two same-named downloads started concurrently and a resume where a part file already belongs to another active entry.

#### 7. The segmented downloader renames a file before closing its handle

**Location:** `src/download/accelerator.ts:576-597`

The segmented path executes `fs.rename(part, dest)` while `fh` remains open and only closes it in `finally`. The single-stream path explicitly closes before its rename. This is likely to fail on Windows or filesystems that disallow renaming an open handle.

**Recommendation:** Structure file-handle ownership so it is synced and closed before the rename, with a single idempotent cleanup path for failures. Run the accelerator suite on Windows in CI to prevent regression.

### P2 — material reliability and maintainability issues

#### 8. HTTP retry/fallback paths do not consistently release failed response bodies or preserve response metadata

**Locations:** `src/util/net.ts:70-130`, `src/sources/adapter.ts:112-132`, `src/debrid/base.ts:84-110`

Retryable responses in `fetchResilient` are retried without cancelling/draining their bodies. `fetchFirstOk` similarly moves to a different host after a non-OK response without consuming that response. Under a broad source fan-out this can waste undici connection slots. For debrid APIs, retryable status responses become a generic `HttpError` before the adapter can read the provider error body or `Retry-After`, weakening quota messaging/backoff.

**Recommendation:** Define one response-lifecycle policy: consume/cancel every response that will not be returned. Carry status, headers, and a bounded error excerpt in a structured error where callers need classification; allow debrid calls to opt out of generic status retries so adapters can interpret quota responses. Add tests that assert cancellation and `Retry-After` propagation.

#### 9. The executor ignores Cardigann request-rate guidance

**Locations:** `src/cardigann/model.ts:97`, `src/cardigann/loader.ts:199`, `src/cardigann/executor.ts`

`requestDelay` is parsed but never used. Multiple bundled definitions declare it, including `torrentcore`, `1337x`, `nyaasi`, and `yts`. Repeated searches and detail-page resolution can exceed an indexer's expected rate, inviting blocks and making source health less stable.

**Recommendation:** Add a per-source request governor shared by search, probe, and detail resolution. Confirm the upstream field's units/semantics, make it abort-aware, and preserve the global fan-out cap. Keep the policy out of selector parsing so it can be tested independently.

#### 10. Malformed persisted Torznab/source data can crash boot

**Locations:** `src/config/config.ts:91-115`, `src/sources/registry.ts:58-63`, `src/sources/torznab.ts:77+`

`coerce` only verifies that `torznab` is an array; it does not validate elements. A focused call with `torznab: [null]` made `buildRegistry` reject with `Cannot read properties of null (reading 'id')`. `sources` is also accepted as any object/array rather than a validated `Record<string, SourceState>`.

**Recommendation:** Treat on-disk JSON as untrusted input. Validate and normalize each Torznab object (`id`, `name`, and a valid HTTPS base URL), validate source state fields, discard invalid entries with a diagnostic notice, and migrate older schemas explicitly. Add corrupt/partial-config tests.

#### 11. The selected mirror is ignored by YTS

**Locations:** `src/sources/yts.ts:10-17`, `src/sources/yts.ts:48-89`; `src/sources/health.ts:47-75`

Health probing passes `baseUrl` to every source, but YTS's `search`, `browse`, and `test` functions never accept or use it; they always iterate the hard-coded host list. The Sources screen can therefore report or switch a YTS mirror without actually routing subsequent work to that mirror.

**Recommendation:** Make YTS use the same `baseUrl` override pattern as SolidTorrents/Bitsearch, including a single-host probe. Add a mirror-selection test that observes the requested host.

#### 12. Retesting sources can overwrite interactive changes and re-enable a deliberately disabled source

**Locations:** `src/ui/App.tsx:484-539`, `src/ui/App.tsx:541-567`

`retestAll` builds `updates` from a snapshot, waits for the whole probe, and then replaces all source state. A user toggle or mirror change during the retest can be lost. Both individual and bulk retests set `enabled` to the health result, so retesting a manually disabled source turns it on.

**Recommendation:** Model health separately from user intent. Apply test results through an updater that merges only `health`/a successful fallback mirror into the latest config, and retain `enabled` unless the action explicitly says “test and enable.” Disable conflicting UI actions or attach a run generation to ignore stale probe results.

#### 13. Download integrity checks verify byte count but not range identity/resource continuity

**Location:** `src/download/accelerator.ts:430-590`

Each chunk verifies only the number of bytes received. It does not verify that a `206` response's `Content-Range` matches the requested interval. After a re-resolve, it also does not confirm that the fresh URL still has the original ETag/Last-Modified/total before mixing bytes. A same-length changed resource can pass the final size test while being corrupted.

**Recommendation:** Parse and verify `Content-Range` start/end/total for every range response. After URL refresh, re-probe and require compatible length plus a matching available validator; otherwise restart the part file. Keep a clearly documented best-effort path only for servers that expose neither validator nor ranges.

#### 14. `App.tsx` is still the state and orchestration bottleneck

**Locations:** `src/ui/App.tsx` (823 lines), `src/ui/store.ts`

One component owns boot, persistence, notices, all source actions, debrid actions, download actions, keyboard routing, layout, and a broad context object. Download progress rebuilds that context and can re-render every consumer. The new Settings view also duplicates credential editing that still exists in Accounts.

**Recommendation:** Extract `useBoot`, `useSourceActions`, `useDebridActions`, `useDownloads`, and a configuration repository. Split context into stable actions, app/navigation state, and high-frequency transfer/download snapshots. Make Settings the single credential/settings editor and retain Accounts only as a concise status/verification overlay, or merge them entirely.

#### 15. The settings and config mutations are snapshot setters, not transactional updates

**Locations:** `src/ui/components/Settings.tsx:48-76`, `src/ui/App.tsx:127-131`, `src/ui/App.tsx:541-567`

Several actions build a new object from the `config` captured by a render. Closely spaced updates can overwrite each other, and async operations must hand-roll merges. This is the root cause behind several persistence/retest race risks.

**Recommendation:** Expose `updateConfig((current) => next)` from one configuration store/reducer. Serialize state transition and disk persistence in that layer; components should express only intent (`setPreferred`, `toggleRelevance`, `setMirror`).

### P3 — polish, defensive engineering, and product consistency

#### 16. Settings input is less capable than the upgraded search input

**Location:** `src/ui/components/Settings.tsx`

The new SearchBar supports a caret and mid-string editing, while credentials and the download folder only append and delete the final character; `delete` behaves as backspace. This is especially awkward for correcting a pasted filesystem path. The Settings code is currently uncommitted, so this is an inexpensive time to extract a shared masked/unmasked text-input primitive.

#### 17. Narrow-terminal layout and help text need a responsive pass

**Locations:** `src/ui/App.tsx:575-578`, `src/ui/components/Tabs.tsx`, `src/cli/args.ts`

The fixed `chrome = 8` calculation does not account for six long tab labels, wrapping footers, overlays, or the new Settings screen. `HELP_TEXT` describes only Search/Sources and omits Trending, debrid, downloads, filters, Settings, and current keys. Add a narrow-width tab representation and derive list height from measured/rendered chrome where feasible; test 40/60/80-column snapshots.

#### 18. Small defensive issues in shared helpers

**Locations:** `src/util/concurrency.ts`, `src/sources/adapter.ts`, `src/sources/search.ts`, `src/util/format.ts`

- `mapPool` assumes a positive finite limit and lets an exception from `onSettled` stop a worker despite promising that every item is processed.
- `applyLimit` accepts negative and non-finite limits, producing surprising `slice` behavior.
- Equal result rank/sort keys preserve nondeterministic network-arrival order; add a stable source/name/hash tiebreaker to reduce result jumping.
- `cleanText` returns `"Untitled"` for an empty API title, so native adapters' `if (!name)` checks do not actually reject malformed rows.

Validate public utility inputs at their boundary and add focused unit tests.

## Refactoring roadmap

### 1. Make state persistence and shutdown reliable

Create a `ConfigRepository` that owns validation, `update`, serialized atomic saves, last-write errors, and `flush`. Replace fire-and-forget `persist` calls with intent-level updates. Let application shutdown await the repository's bounded flush before restoring the terminal and exiting. This resolves findings 1, 2, 10, 12, and 15 together.

### 2. Establish a single request-execution layer

Move timeout, retry policy, body disposal, error normalization, and per-source rate limiting into a request runner. Source adapters and the Cardigann executor should request either text/JSON or an explicitly owned `Response`; debrid adapters should opt into status/body preservation. This resolves findings 8 and 9 and reduces repeated `fetchResilient` policy decisions.

### 3. Harden the Cardigann execution pipeline

Separate immutable request variables from per-row variables, give POST bodies correct headers, and represent expected selector misses distinctly from parser faults. Retain the current selector-engine abstraction, but make request building, parsing, and detail resolution independently testable with definition fixtures. This resolves findings 3 and 4 and improves diagnosis when definitions drift.

### 4. Give downloads explicit ownership and integrity boundaries

Have `DownloadManager` reserve a destination before any work begins and release it only when terminal. Make the accelerator validate `Content-Range`, revalidate after refresh, close before rename, and pass the cancellation signal to re-resolution. This resolves findings 6, 7, and 13.

### 5. Decompose the UI around state update frequency

Keep App as a thin composition/layout shell. Move long-lived services into hooks, split the monolithic context, and reuse one keyboard-safe text editor. This will contain progress-driven rendering and eliminate duplicated Accounts/Settings behavior without a broad rewrite.

## Test plan additions

Prioritize regression tests alongside the fixes:

1. Query table: phrase-only, stop words in a phrase, exclude-only, excludes with manual sort, strict mode, and exact expected tiers.
2. Cardigann: POST content type, two-row `.Result` isolation, and a fixture for every supported response type.
3. Persistence: malformed config recovery, failed writes, owner-only temporary mode, and graceful shutdown flush.
4. Download manager: same-name concurrent starts, cancellation during re-resolve, resume after refreshed URL, mismatched `Content-Range`, and Windows close-before-rename behavior.
5. Source/mirror: assert the configured YTS host is the only host probed/searched; test stale retest result handling.
6. UI: snapshot/input tests at narrow widths and tests that Settings text editing does not leak keys to global bindings.

## What is already working well

- The source interface cleanly unifies native, Torznab, and Cardigann-backed implementations.
- The recent debrid descriptor/base extraction is a meaningful reduction in provider duplication.
- Health probes and fan-out searches have bounded concurrency and cancellation paths.
- Ranking, release-name parsing, filter state, formatting, and atomic-write helpers are largely pure and well suited to unit testing.
- The suite is broad for a TUI and the production dependency audit is currently clean.

## Suggested implementation order

1. P1 query and Cardigann fixes (3–5), each with small deterministic tests.
2. P1 persistence/security (1–2), then graceful shutdown.
3. P1 download coordination/handle lifecycle (6–7).
4. HTTP lifecycle plus rate policy (8–9).
5. Config repository/state-update refactor, retest semantics, and YTS mirror correctness (10–12, 15).
6. Download integrity, App/context decomposition, and UI polish (13–18).

This sequence fixes user-visible incorrect behavior first and creates the seams needed for the larger refactors without requiring a rewrite.
