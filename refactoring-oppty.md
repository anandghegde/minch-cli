minch-cli Codebase Review — Refactoring Opportunities
Reviewed all ~8,100 lines across every subsystem (UI/Ink, Cardigann interpreter, debrid adapters, download accelerator, native sources, util/config/cli). Overall this is a well-structured, well-commented codebase with good test coverage and clean separation at the package level. The issues cluster into a few repeated themes plus a handful of genuine latent bugs I surfaced while reading.
I'll lead with bugs (highest value), then cross-cutting refactors, then per-subsystem major/minor items, then a suggested order.
A. Genuine bugs found during review (fix these first)
These aren't style nits — they're correctness defects worth ticketing regardless of any refactor.
A1 — DownloadManager runs queued downloads with the WRONG input. download/manager.ts:166-177
pump(input)/run(id, input) thread a single StartDownloadInput, but the queue holds ids from different start() calls. When maxConcurrent (default 3) is saturated and a slot frees, run's .finally re-calls pump(input) with the finishing download's input, so the next queued id executes against the wrong provider/transfer/file/dir. I traced this: a "download all" on a transfer with >3 files re-downloads file #1's URL into file #4's entry. Reachable today via Transfers multi-file "download all" (Transfers.tsx:170).
Fix: store the input per-entry (one Map<string,{entry,controller,input}>) and look it up by id; never thread a shared input.
A2 — First-run probe progress UI is never shown. App.tsx:117-166, 529-531, 637-651
store is gated on config && registry (:530), but during first run config stays null until persist(next) after the probe finishes. So throughout the probe, if (!store) (:637) renders the bare "Starting minch" spinner — the animated Splash progress bar (Splash.tsx, progress state) only ever shows its final "Ready" frame for 700ms. The whole incremental first-run experience is dead.
Fix: allow the splash/boot path to render without a full store (e.g. build store from registry alone, or special-case the booting view).
A3 — Segmented downloader can leak a file descriptor. accelerator.ts:386-588
fh is opened at :386 with no try/finally; closes are scattered (:564/:568/:573). If fh.truncate(total) (:387, pre-allocation) or fh.sync() (:572) rejects, the descriptor leaks. The single-stream path (:652/709/715) does this correctly — mirror it.
A4 — Resume can silently corrupt files (durability ordering). accelerator.ts:482 (write) vs :546 (persist sidecar) vs :572 (final fsync)
Chunk bytes are written but not flushed until the final fh.sync(). persistSidecar() durably records "chunk N complete" before N's bytes are fsync'd. A crash in between leaves the sidecar claiming N is done while its bytes are lost; on resume the range is skipped and the size check (:575) still passes → silent corruption. Fix: fdatasync the part file before recording a chunk complete (or batch-fsync then persist).
A5 — Search-cache key ignores mirror and limit. sources/cache.ts:12,17-27
Key is sourceId::query only. Searching the same query against a different mirror returns the first mirror's rows; a limit:10 call poisons the cache for a later unlimited call. Fix: include baseUrl/limit in the key (or cache pre-limit, slice on read).
Smaller correctness smells: reResolve ignores the abort signal (manager.ts:208); cancel of an active download doesn't emit() so the UI lags (manager.ts:142-155); filters.split truncates multi-char separators to charAt(0) (cardigann/filters.ts:75); Number(id)→NaN in TorBox add body (torbox.ts:407); nyaa/torznab emit NaN added on unparseable dates (nyaa.ts:51, torznab.ts:77).
B. Cross-cutting refactors (the biggest leverage)
B1 — Two debrid adapters are ~85% duplicated. realdebrid.ts ↔ torbox.ts
Near-identical re-implementations of: the HTTP call (realdebrid.ts:260-286 vs torbox.ts:229-256), text→JSON body parsing (:294-308 vs :258-282), requireToken/requireKey (:251-258 vs :220-227), kindForStatus (:161-167 vs :105-111), clamp01, isAbort, quota-backoff math, and QUOTA_BACKOFF_MS=60_000 (defined twice). Extract a createDebridBase({ provider, baseUrl, httpErrorFor }) helper; each adapter keeps only provider-specific success/error interpretation. Single highest-value structural change in the repo.
B2 — Five native source adapters re-implement the same skeletons. apibay/nyaa/yts/solidtorrents/torznab (+ cardigann/source.ts)
- Identical test() envelope incl. error→code regex, 6 copies (apibay.ts:78-101, etc.).
- Error message→code via /HTTP \d+/.exec(msg) even though HttpError.status is structured (net.ts:16) — round-tripping a number through a string, duplicated in useConcurrentSearch.ts:24-28 and health.ts too.
- Duplicated multi-host fallback loop (yts.ts:30-45 ≈ solidtorrents.ts:33-51).
- Single-host fetch+ok-check reimplements the already-existing-but-unused fetchText (net.ts:132); no fetchJson sibling exists.
- Duplicated XMLParser + RSS channel.item extraction (nyaa.ts:12-33 ≈ torznab.ts:18-47).
- opts.limit slice tail copy-pasted 6×; id/label hardcoded twice per source (mapper vs Source descriptor).
Extract src/sources/adapter.ts with fetchJson, fetchFirstOk, runProbe, errorToCode, applyLimit, makeResult, toUnixSeconds, parseRssItems. Estimated 50-60% reduction across adapters.
B3 — App.tsx is a 726-line god component. App.tsx
It owns boot/probe orchestration, every debrid/download/source/account action handler, input routing, layout, and a store object assembled via a useMemo with a ~45-entry dependency array (:582-593). Because downloads updates on every accelerator progress tick, that memo recomputes and every context consumer re-renders on each tick. Extract cohesive hooks: useBoot, useDebridActions, useDownloadActions, useSourceActions; consider splitting StoreContext into stable-actions vs frequently-changing-state contexts. The boot probe (:141-156) and retestAll (:474-484) also duplicate the same probe-and-persist loop.
B4 — useConcurrentSearch and useTransfers are the same fan-out pattern, divergent. hooks/useConcurrentSearch.ts / hooks/useTransfers.ts
Both: stable inputs via ref, ids.join(",") effect key, per-item settle, resilience. Search fans out all sources at once with no pool (could be 50+ simultaneous requests with many Cardigann sources enabled), while health.probeAll uses a bounded pool (health.ts:81-100). Factor a shared mapPool(items, limit, fn) and align the strategies.
B5 — Per-provider config knowledge is hardcoded in 4 places. keys.ts:29-33,60-72, registry.ts, types.ts
Adding a debrid provider means editing configKey, withDebridKey, ENV_VARS, BUILDERS, and the config coerceDebrid (config.ts:52-69). Collapse to one descriptor table { id, label, envVar, read(config), write(config,key) } consumed everywhere.
B6 — Pervasive unsafe casts + exceptions-as-control-flow in the interpreter. cardigann/executor.ts
as unknown as cheerio.Cheerio<never> (:187,193,438,563) and as Record<string,unknown> (loader, ~5×). Selector "no match" is modeled as a thrown Error caught and discarded by empty catch {} (:454-459, 513-518), which also swallows genuine TypeErrors. Introduce typed coercion helpers (asString, asEl) and a discriminated SelectorResult so expected misses ≠ real errors.
C. Major, per-subsystem
Cardigann interpreter (executor.ts is the 652-line hotspot)
- parseHtmlResults (:414-468) and parseJsonResults (:470-528) are near-duplicate row loops — extract processRow + a SelectorEngine strategy (html/json) so the text/case/filters pipeline lives once (currently implemented twice at :178-247 vs :251-308).
- executeSearch (:583-650) mixes header-building + HTTP + parse-dispatch — split into buildHeaders/fetchSearchPage/parseResponse.
- resolveDownloadInfohashes (:540-580) hand-rolls a worker pool over a shared mutable index — reuse a mapWithConcurrency util (same need as B4).
- loadDefinition (loader.ts:155-234) interleaves validation guards with a 45-line object literal — split assertSupported from buildDefinition.
- applyFilters (cardigann/filters.ts:24-160) is a 130-line 20-case switch and applyTemplate (template.ts:25-157) is a 130-line function with 6 inline mini-parsers — convert to a filter registry / pipeline of pure functions (each becomes unit-testable).
Download
- downloadFile (accelerator.ts:259-719) is a ~460-line closure; segmented() (:368-589) interleaves ~5 responsibilities. Extract LinkRefresher, Probe, SegmentedDownloader, SingleStreamDownloader, ProgressTracker (the loose committed/live/activeConns lets with manual rollback at :493/503/506 are a drift hazard). This is what blocks unit-testing status-classification/retry logic in isolation.
- Retry/backoff/expiry handling is duplicated between segmented and single-stream paths and has already drifted (:439-534 vs :611-708).
Debrid
- TorBox's activeByKey is a module-global Map keyed by the raw API key, never evicted, mutated as a side-effect of getTransfer (torbox.ts:215,364,375,379-388). Move into the provider closure or inject.
- RD's ensurePremium adds a /user round-trip before every add (realdebrid.ts:322-331,421,434) — cache it.
Sources / misc
- sources/registry.ts:45-48 inlines a mirror-resolution closure that's a verbatim copy of the exported activeMirror (:62-65) — call it.
- sources/cache.ts:10 module Map is unbounded (no LRU); long sessions grow memory.
D. Minor (high-signal subset)
- Dead code: cardigann/categories.ts STANDARD_CATEGORIES (exported, never imported); model.ts login field (parsed, never read); sources/types.ts SourceKind "html" member (unused); AddOptions import unused in realdebrid.ts:16; finalize(result, def) never uses def (executor.ts:400); TorBox isActiveStatus needs_selection branch unreachable (torbox.ts:91-98).
- Magic numbers needing names: 5_000_000 peer cap (executor.ts:347,352), 20/6 infohash fetch limits (:549,579), 50 template loop guard (template.ts:62), 255 filename cap (accelerator.ts:209), 4/8 in maskKey (keys.ts:52-57), 20_000 timeout defined twice (health.ts:4, useConcurrentSearch.ts:22).
- Duplicated helpers to hoist: isAbortError differs between accelerator.ts:247 (/abort/i) and net.ts:34 (/aborted/i) — same concept, different regex; pathExists/exists reimplemented in accelerator/tests/manager; clamp01, isAbort across debrid; hex-40 hash regex in search.ts:11 duplicates magnet.ts:20.
- Type weaknesses: FetchImpl/Sleep re-declared in accelerator.ts:21-22 (dup of net.ts:4-5); fetchImpl: opts.fetchImpl as never (executor.ts:558,620); DebridError cause via (this as {cause?}).cause hack (types.ts:159) — use super(message,{cause}); TestResult.code is open string but only ~5 values occur.
- App.tsx nits: debridNotice rebuilds its prefix record every call (:55-61); imports activeFilterCount but never uses the existing isEmptyFilters (filters.ts:75); debridProviders/configuredProviders in debrid/registry.ts:25-37 rebuild every provider on each call.
- dates.ts: mult map rebuilt per loop iteration (:33-41); two sources of truth for the Go token set (:48-68 vs :80-81); global regexes used for stateless .test() requiring lastIndex=0 resets (:88-89).
E. Suggested order
1. Bugs A1–A5 (correctness; small, contained patches).
   - Status: complete.
   - A1: download/manager.ts — input stored per-entry (inputs Map); pump() resolves each queued id's own input, so a freed concurrency slot no longer runs the next queued download against the finishing download's input.
   - A2: ui/App.tsx — during the first-run probe (config still null) Splash renders directly with progress/rows/cols, so per-source probe progress shows instead of a bare spinner.
   - A3: download/accelerator.ts — segmented path wraps fh in try/finally so fh.close() runs on every exit (success, fatal, abort, size mismatch, rename failure).
   - A4: download/accelerator.ts — chunk bytes are fh.sync()'d before the chunk is recorded complete in the sidecar, closing the crash-window that recorded a chunk done while its bytes were lost.
   - A5: sources/cache.ts — cache key now includes baseUrl and limit, so a different mirror or a limit:10 call no longer poisons a later unlimited call.
2. B1 debrid base + B5 provider descriptor (kills the most duplication, makes adding providers a one-file change).
   - Status: complete.
   - B1: src/debrid/base.ts createDebridBase({ provider, baseUrl, kindForStatus, … }) hosts the shared fetch/auth/backoff/error-translation; realdebrid.ts and torbox.ts consume it and keep only provider-specific envelope parsing + status/kind mapping.
   - B5: src/debrid/descriptor.ts DEBRID_DESCRIPTORS table { id, label, envVar, read, write, coerce } is the single source of truth for per-provider config knowledge, consumed by keys.ts and config.ts coerce — adding a provider is one descriptor entry + one builder.
3. B2 sources adapter toolkit (50-60% adapter shrink; also fixes the error-code regex fragility).
   - Status: complete.
   - src/sources/adapter.ts: shared toolkit — errorToCode, applyLimit, toUnixSeconds, parseRssItems, makeResult, fetchJson, fetchFirstOk, runProbe; the six adapters now keep only provider-specific parsing.
   - Migrated apibay (fetchJson+makeResult), nyaa (fetchText+parseRssItems+toUnixSeconds), yts (fetchFirstOk), solidtorrents (fetchFirstOk+toUnixSeconds, baseUrl-override URL preserved), torznab (fetchText+parseRssItems, keeps attr/buildUrl), and cardigann/source.ts (applyLimit+runProbe, keeps toTorrentResults); each native adapter defines {id,label} once via makeResult + the Source descriptor.
   - Collapsed the error→code mapping to one place: health.ts and useConcurrentSearch.ts both call adapter.errorToCode (removed the local errorCode); the /HTTP \d+/ message regex is gone — HttpError.status is used directly. toUnixSeconds also fixes the NaN-added smell on unparseable nyaa/torznab pubDates.
   - test/adapter.test.ts unit-tests every helper (28 tests); full suite green (191 tests) and typecheck clean.
4. C executor decomposition + the mapPool util shared with B4 (unlocks unit tests for the riskiest parsing/concurrency code).
   - Status: complete.
   - executor.ts: SelectorEngine strategy (html/xml/json) + single processRow/parseResults row loop; executeSearch split into buildSearchHeaders/fetchSearchPage/selectEngine; resolveDownloadInfohashes via mapPool; parseHtmlResults/parseJsonResults kept as deprecated wrappers.
   - loader.ts: split loadDefinition into assertSupported + buildDefinition.
   - filters.ts: 20-case switch replaced with a FILTERS registry of pure FilterFns + pipeline applyFilters.
   - template.ts: split applyTemplate into applyReReplace/applyJoin/applyLogic/applyIfElse/applyRange/applySimpleVar.
   - src/util/concurrency.ts: shared mapPool (allSettled semantics + optional onSettled streaming) now backs health.probeAll, executor.resolveDownloadInfohashes, useConcurrentSearch (bounded to 12), and useTransfers.
5. B3 App.tsx hook extraction (maintainability + render perf).
6. Sweep D (dead code, magic numbers, hoisted helpers) opportunistically alongside the above.
Two things worth calling out positively: sources/filters.ts, util/atomic.ts, and util/format.ts are clean, pure, and well-tested — good templates for the style the rest should converge toward. Nothing here suggests a rewrite; it's mostly DRYing duplicated adapters and decomposing four oversized functions (App, downloadFile, executeSearch/parsers, applyTemplate/applyFilters).
