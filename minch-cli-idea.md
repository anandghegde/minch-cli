# minch-cli

A slick terminal torrent finder. One search checks Prowlarr's catalog of **public** torrent
sources at once, streams results as they arrive, sorts by seeders, and lets you copy/open a magnet
or hand it off to download. Zero setup: it ships with the public-indexer definitions, auto-tests
them on first run, and enables only the ones that work.

- **Command:** `minch`
- **Repo:** `minch-cli`
- **Relation to siblings:** `minch` (Swift macOS app that downloads to TorBox) is the *fetcher*;
  `minch-cli` is the *finder*. This repo is the evolution of `torlink` (`npx torlnk`) with first-run
  health probing, a Sources management screen, the full set of Prowlarr public indexers, and
  user-added Torznab sources.
- **Not** a Prowlarr replacement, not a server, not a daemon. No private trackers, no login/auth.

## What this is and isn't

The motivation is to get **Prowlarr's breadth of public sources without running Prowlarr**.
Prowlarr exposes hundreds of indexers, but the overwhelming majority are **private trackers** that
need accounts/credentials. minch-cli deliberately ships **only the `type: public` indexers** — the
ones that work with zero config (e.g. The Pirate Bay/apibay, YTS, Nyaa, EZTV, 1337x, TorrentsCSV,
Knaben, …). Private trackers are out of scope.

Prowlarr's indexers are defined as **Cardigann YAML** files (search URL templates + CSS/XPath
scrape rules + a `links:` list of mirror URLs per site). To get the public catalog *and* its mirror
URLs as a living, updatable dataset, minch-cli ships a **scoped Cardigann interpreter** that
executes only the features public indexers use. The auth/login/captcha/private-category surface of
full Cardigann is explicitly excluded.

## Stack

- **Runtime:** Node.js (LTS), TypeScript.
- **TUI:** Ink (React for the terminal) — reuses torlink's existing components and patterns.
- **Concurrency:** native `Promise.allSettled` + `AbortController` per-source timeouts.
- **HTTP:** `undici`/`fetch`.
- **Parsing:** `cheerio` (CSS/XPath selectors for Cardigann HTML/XML rows), `fast-xml-parser`
  (Torznab/Newznab XML, RSS), JSON for native API sources (YTS/apibay).
- **YAML:** `yaml` for loading Cardigann definitions.
- **Persistence:** local JSON config file (no database).
- **Build/dist:** `tsup` bundle, published to npm, run via `npx minch-cli` / installed `minch` bin.
- **Test:** Vitest with fixtures/mocks; no live network in the default suite.

## Cardigann (public-only) interpreter

Implement just enough of the Cardigann definition format to run public indexers:

- **Load:** parse a definition's YAML into a typed model.
- **Mirror URLs (`links`):** each definition carries a `links:` array of equivalent base URLs.
  Pick a default (first reachable), persist the chosen one per source, and let the user switch
  among the listed mirrors in the Sources screen. This is the "multiple URLs per source" behavior.
- **Search:** template `search.paths` + `search.inputs` with the query and category mapping,
  substituting variables (Go-template-ish `{{ .Keywords }}`, `{{ .Config.* }}`, etc.).
- **Rows:** run the `search.rows` selector to get result rows.
- **Fields:** extract `search.fields` (title, details, download/magnet, infohash, size, seeders,
  leechers, date, category) via CSS/XPath selectors with attribute/text access.
- **Filters:** support the common field filters public defs use — `regexp`, `replace`,
  `querystring`, `dateparse`/`timeago`, `append`/`prepend`, `split`, etc.
- **Category mapping:** map Prowlarr/Newznab category IDs to/from the definition's categories.
- **Explicitly NOT supported:** `login` (form/cookie/oneurl), captcha, ratio/seed-time rules,
  private categories, anything requiring credentials. A definition that needs login is rejected at
  load time and never enabled.
- **Native sources:** API sources that aren't a good Cardigann fit (apibay JSON, YTS JSON, Nyaa
  RSS) MAY be implemented as native TypeScript `Indexer`s alongside the interpreter, behind the
  same interface.

## Indexer definitions (bundled)

- The public `type: public` Cardigann YAML files from the upstream **`Prowlarr/Indexers`** repo are
  **vendored into this repo** (e.g. `definitions/public/*.yml`) and shipped in the npm package.
- A sync script (`scripts/sync-definitions`) pulls the latest public defs from upstream, filters to
  `type: public` and to definitions the scoped interpreter can run (no `login`), and writes them in.
- **Licensing:** Prowlarr is GPL-3.0 and the definitions carry upstream terms. The repo includes the
  required attribution and license notices for the bundled YAML, and the README credits
  `Prowlarr/Indexers`.

## Core UX

- Launching the app opens a polished terminal UI.
- First-run flow:
  - Show "Testing public indexers…" with per-source status.
  - Probe all bundled public indexers concurrently.
  - Automatically enable sources that pass.
  - Disable sources that fail, but keep them visible under "Unavailable".
  - Do not ask the user to choose sources during first run.
- Main screen:
  - Slick command-line search bar.
  - Search as user types or on Enter, depending on implementation simplicity/performance.
  - Live per-source progress/status.
  - Unified result list sorted by seeders by default.
  - Keyboard navigation.
  - Open/copy magnet/download action if supported.
- Sources screen:
  - Show all known indexers/sources.
  - Status: working, failed, needs config, disabled.
  - **Mirror selection:** for sources with multiple `links`, show the active URL and let the user
    switch to another mirror and retest.
  - Last tested time.
  - Last error summary.
  - Ability to retest one source or all sources.
  - Ability to enable/disable sources.
- Later configuration:
  - Allow adding/configuring a generic Torznab source:
    - name
    - base URL
    - API key if needed
    - categories if needed
  - Test before enabling.
  - Store config locally.

## Architecture

- No server, no daemon, no Prowlarr dependency.
- Use a local config file, not a database, unless the project already has a simple persistence layer.
- Define an `Indexer`/`Source` interface (implemented by both the Cardigann executor and native sources):
  - `id`
  - `label`
  - `kind`: api | rss | torznab | cardigann | html
  - `links`: string[]  (mirror base URLs; single-element for sources with one URL)
  - `requiresConfig`
  - `defaultEnabled`
  - `test(opts): Promise<TestResult>`
  - `search(query, opts): Promise<TorrentResult[]>`
- `TestResult`:
  - ok
  - status message
  - latency
  - result count if applicable
  - error code/message if failed
- `TorrentResult`:
  - title/name
  - infoHash
  - magnetUrl
  - downloadUrl
  - size
  - seeders
  - leechers
  - source
  - publish date
  - category/type
- Implement source registry/catalog (definitions + native sources) separately from enabled source state.
- Persist:
  - enabled/disabled state
  - selected mirror URL per source
  - source health
  - configured Torznab sources
  - recent search cache

## Search behavior

- Search enabled working sources concurrently.
- Per-source timeout, e.g. 10-25 seconds.
- One failed source must not break the whole search.
- Deduplicate results by info hash, magnet URL, or normalized title+size.
- Sort by seeders by default.
- Show source failures compactly in the UI.

## Testing

- Unit tests for:
  - Cardigann interpreter: template substitution, row/field extraction, filters, category mapping,
    mirror/`links` selection — using saved HTML/XML/JSON fixtures from real public sources.
  - source registry (definitions + native)
  - health/test flow
  - dedupe/sorting
  - config persistence
  - rejection of definitions requiring login/auth
- No live network tests in default test suite unless explicitly marked/integration.

## Non-goals

- Do not port full Prowlarr.
- Do not implement full Cardigann YAML compatibility — **public-only**: no login/auth/captcha/
  private-tracker support.
- Do not include private trackers.
- Do not require Docker.
- Do not run a web server.
- Do not use DHT for keyword search.
- Do not ask the user to manually choose built-in sources on first run.

## Acceptance criteria

- The app ships Prowlarr's public indexer definitions and runs them via the scoped Cardigann
  interpreter without a Prowlarr server.
- On first launch, the app auto-tests bundled public sources and enables only working ones.
- User can immediately search from a terminal search bar.
- For sources with multiple mirror URLs, the user can switch the active mirror and retest.
- Failed sources are visible and retestable.
- User can later add a Torznab-compatible indexer with URL/API key and test it.
- README clearly says this is a lightweight direct-search TUI for **public** sources, not a full
  Prowlarr replacement, and credits `Prowlarr/Indexers` with required license notices.

## Design notes

- Auto-test should be health probing, not a real broad search where possible. For example, RSS/API
  sources can fetch a small recent feed or top/list endpoint, and Cardigann sources can run a cheap
  known query. That avoids noisy queries and makes first run faster.
- Keep the Cardigann interpreter strictly scoped: if a public definition starts requiring features
  outside the public subset, prefer dropping it or implementing a small native source over growing
  the interpreter toward full Cardigann.
