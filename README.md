# minch-cli

A slick terminal torrent finder for **public** sources. One search hits a broad
catalog of public torrent indexers at once, streams results as they arrive,
ranks them by relevance (text match first, then seeders), and lets you copy or
open a magnet. Zero setup: it ships with the public-indexer definitions,
auto-tests them on first run, and enables only the ones that work.

```
minch
```

> minch-cli is a lightweight, direct-search TUI for **public** torrent sources.
> It is **not** a Prowlarr replacement, not a server, and not a daemon. It has
> no private trackers and no login/auth.

## What it is

The goal is to get **Prowlarr's breadth of public sources without running
Prowlarr**. Prowlarr exposes hundreds of indexers, but the overwhelming
majority are private trackers that need accounts. minch-cli deliberately ships
**only the `type: public` indexers** — the ones that work with zero config (The
Pirate Bay, YTS, Nyaa, 1337x, LimeTorrents, RuTor, Torrent9, …) — plus a few
native API/RSS sources (FitGirl Repacks for games, Bitsearch for general
meta-search), all behind one interface.

Prowlarr's indexers are defined as **Cardigann YAML** (search URL templates +
CSS/XPath scrape rules + a `links:` list of mirror URLs per site). minch-cli
ships a **scoped Cardigann interpreter** that executes only the features public
indexers use. The auth/login/captcha/private surface of full Cardigann is
explicitly excluded — any definition that requires login is rejected at load
time and never enabled.

## Features

- **Zero-config first run.** On first launch minch probes every bundled public
  source concurrently, enables the ones that respond, and disables the rest
  (kept visible under "Unavailable").
- **Unified search.** Type a query, hit enter, and every working source is
  searched at once. Results stream in, are de-duplicated by info hash (or
  title+size), and ranked by relevance (full text match over partial, with
  year / episode / trash signals and seeder bucketing as tiebreakers). Press
  `s` to cycle manual sorts (seeders, quality, size, date, source).
- **Mirror switching.** Many sources ship multiple mirror URLs. The Sources
  screen lets you switch the active mirror and retest.
- **Sources management.** See each source's status (working / failed / needs
  config / disabled), latency, last error, and last tested time. Enable/disable
  and retest one or all.
- **Generic Torznab.** Add a Torznab-compatible indexer (name, base URL, API
  key, categories), test it, and search it alongside the rest.
- **Copy / open magnets.** `y` copies a magnet to the clipboard; `d`/`o` hands
  it to your default torrent client.
- **Result filters.** Cycle quick filters over the streamed results without
  re-querying: `t` cycles the publish-date window (24h/week/month/3mo/year),
  `z` cycles a size bucket, `x` cycles a minimum-seeders threshold, and `f`
  toggles match mode (soft keeps partial hits sunk; strict hides non-AND rows
  like Jackett `andmatch`). Active filters show inline next to the sort label
  with an "N of M" count; `r` resets them to config defaults. Filters compose
  with sort (filter first, then sort).
- **Relevance config** (optional, in the local JSON config under `relevance`):
  `preferQuality` folds release quality into the default cascade after seeders;
  `strictAnd` and `hideTrash` seed the session filters on boot.
- **Release discovery.** The Discover tab separates weekly Trending titles,
  recent/upcoming India OTT changes, Blu-ray/4K claims, India OTT charts, and a
  Letterboxd community feed. Filter by date window, provider, original/audio language, media type,
  format, or Indian title origin, then press `s` to search the selected clean
  title and year. Discovery uses its own normalized cache and never pretends
  release records are torrents.
- **India OTT popularity.** The Discover tab's Popular feed can use the
  `moving_beacon-owner1/streaming-catalog-scraper` Apify Actor in `popular` mode
  for India/provider-filtered catalog rankings. Results are source-claimed
  popularity signals, not official viewership numbers.

## Usage

```
minch                  open the search TUI
minch "ubuntu 24.04"   open and run an initial search
minch --discovery-status  show local discovery and rating status/limits
minch --version        print the version
minch --help           show help
```

Keys: `↑/↓` move · `enter` search · `s` sort · `t`/`z`/`x`/`f` filter
date/size/seeders/match · `r` reset filters · `y` copy magnet · `d`/`o` open
magnet · `tab` switch Search/Discover/debrid/Sources/Settings · `e` enable ·
`t`/`T` retest · `m` switch mirror · `?` keys · `q` quit. In Discover, `←`/`→`
switch feed, `m`/`p`/`l`/`i`/`t` change filters, `enter` opens details, and `s`
hands the selected title to torrent search.

Query operators (optional): `"exact phrase"` requires contiguous words in the
title; `-word` or `!word` drops results containing that token (e.g.
`"spider man" -cam`).

For the credential-free → TMDB → optional OTT path, Settings instructions,
cache locations, refresh/retention table, quota behavior, adapter toggles, and
known limitations, see [Discovery setup and operations](docs/discovery-setup.md).

## Architecture

No server, no daemon, no Prowlarr dependency. State lives in a local JSON config
file (enabled/disabled state, selected mirror per source, source health,
user-added Torznab sources, and optional user-supplied credentials). Discovery
snapshots and request counters use separate local cache/ledger files; they are
not telemetry or export APIs.

Both the Cardigann executor and the native sources implement one `Source`
interface (`src/sources/types.ts`):

| field | meaning |
| --- | --- |
| `id`, `label`, `kind` | identity and `api`/`rss`/`torznab`/`cardigann`/`html` |
| `links` | mirror base URLs (single-element for one-URL sources) |
| `requiresConfig`, `defaultEnabled` | gating |
| `test()` | cheap health probe → `TestResult` |
| `search()` | keyword search → `TorrentResult[]` |

The scoped Cardigann interpreter lives in `src/cardigann/`:

- `loader.ts` — parse YAML → typed model; reject private/login defs.
- `template.ts` — Go-template subset (`{{ .Var }}`, `if/else`, `range`,
  `and`/`or`/`eq`/`ne`, `join`, `re_replace`).
- `filters.ts` — field filters (`regexp`, `re_replace`, `replace`, `split`,
  `querystring`, `dateparse`/`timeago`/`fuzzytime`, `append`/`prepend`, `trim`,
  `tolower`/`toupper`, `urldecode`/`urlencode`, `htmldecode`, …).
- `executor.ts` — build the request, fetch, parse rows/fields (HTML via
  `cheerio`, XML/JSON natively), map to `TorrentResult`; resolve magnets via the
  `download.infohash` block when a row exposes only a details page.

## Bundled definitions & syncing

The public Cardigann definitions are vendored under `definitions/public/` and
shipped in the npm package. To refresh them from upstream:

```
npm run sync:definitions
```

That pulls the latest `v11` definitions from `Prowlarr/Indexers`, filters to
`type: public` definitions the scoped interpreter can run (no `login`), and
writes them in.

## Development

```
npm install
npm run dev          # run the TUI with tsx
npm test             # vitest (no live network in the default suite)
npm run typecheck
npm run build        # tsup bundle → dist/
```

## Discovery data, accuracy, and attribution

Discovery dates, formats, and availability are source claims. Coverage may be
incomplete, calendars can change, and a provider's
current availability does not prove when a title arrived. minch-cli preserves
unknown dates and regions instead of substituting observation time or guessing.

- [TMDB](https://www.themoviedb.org) supplies trending and regional metadata.
  **This product uses the TMDB API but is not endorsed or certified by TMDB.**
  TMDB watch-provider availability data is supplied by **JustWatch**. See TMDB's
  [approved logos and attribution guidance](https://www.themoviedb.org/about/logos-attribution).
- [Streaming Availability API by Movie of the Night](https://www.movieofthenight.com/about/api)
  supplies India catalogue-change/provider claims and is credited beside its
  data, including when a retained snapshot is shown from cache.
- [Blu-ray.com](https://www.blu-ray.com) supplies advertised release dates and
  links for the restricted RSS pilot. RSS rows have unknown region unless the
  source explicitly says otherwise; generic TMDB physical records are not
  relabeled as Blu-ray.
- Exact ratings can optionally use the user-device IMDb dataset or a user-owned
  MDBList key. **Information courtesy of IMDb (https://www.imdb.com). Used with permission.** TMDB and blended fallbacks remain explicitly labeled; `NR`
  means no trustworthy rating was available, not zero.

TMDB developer access is limited to qualifying **non-commercial** use. Before
minch-cli or a downstream distribution becomes revenue-generating, revisit all
source terms and obtain the required commercial licensing; disable TMDB until a
separate written agreement permits that use. The detailed source boundaries and
review triggers are recorded in
[`docs/decisions/001-zero-cost-discovery-sources.md`](docs/decisions/001-zero-cost-discovery-sources.md).

## Credits & license

minch-cli is MIT-licensed.

The bundled indexer definitions under `definitions/public/` come from the
[**Prowlarr/Indexers**](https://github.com/Prowlarr/Indexers) project and are
licensed under **GPL-3.0**. minch-cli does not modify their contents; it only
filters and vendors them. See `definitions/public/LICENSE` for the upstream
license and attribution. All credit for the indexer definitions and the
Cardigann format goes to the Prowlarr team and contributors.

This project is the evolution of `torlink` (`npx torlnk`), reusing its Ink TUI
patterns, resilient HTTP, and persistence helpers.
