# minch-cli

A slick terminal torrent finder for **public** sources. One search hits a broad
catalog of public torrent indexers at once, streams results as they arrive,
sorts by seeders, and lets you copy or open a magnet. Zero setup: it ships with
the public-indexer definitions, auto-tests them on first run, and enables only
the ones that work.

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
  title+size), and ordered by a smart relevance rank.
- **Smart relevance ranking.** The default order scores each result by seeders,
  peer-health ratio, source trust, quality, freshness, and intent match — not
  just seeders. Searching `anime`, `kdrama`, `bollywood`, or a language name
  strips that hint and boosts the right sources (Nyaa for anime, YTS for movies,
  EZTV for TV, FitGirl for games, The Pirate Bay for Indian content). Press `s`
  to cycle to a plain seeders/size/date/source sort.
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
  `z` cycles a size bucket, and `x` cycles a minimum-seeders threshold. Active
  filters show inline next to the sort label with an "N of M" count; `r` resets
  them. Filters compose with sort (filter first, then sort).

## Usage

```
minch                  open the search TUI
minch "ubuntu 24.04"   open and run an initial search
minch --version        print the version
minch --help           show help
```

Keys: `↑/↓` move · `enter` search · `s` sort · `t`/`z`/`x` filter date/size/seeders ·
`r` reset filters · `y` copy magnet · `d`/`o` open magnet · `tab` switch
Search/Sources · `e` enable · `t`/`T` retest · `m` switch mirror · `?` keys ·
`q` quit.

## Architecture

No server, no daemon, no Prowlarr dependency. State lives in a local JSON config
file (enabled/disabled state, selected mirror per source, source health, and
user-added Torznab sources).

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
