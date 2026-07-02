# torlink → minch-cli feature-parity plan

This plan compares the **last 5 days** of commits on
[`baairon/torlink`](https://github.com/baairon/torlink) (Jun 30 – Jul 2, 2026)
against the current state of **minch-cli**, and lays out a step-by-step
implementation plan for the features that are missing and worth porting.

## Important architectural context (read first)

torlink and minch-cli look similar on the surface but differ a lot underneath.
A coding agent must keep this in mind — several torlink patches **cannot be
copy-pasted** and must be adapted:

| Concern | torlink | minch-cli |
|---|---|---|
| Result sources | Bespoke scrapers (`x1337.ts`, `rss.ts`, …) | Prowlarr **Cardigann YAML** definitions run by an interpreter (`src/cardigann/*`) + a few native adapters (`apibay`, `yts`, `nyaa`, `solidtorrents`) |
| Navigation | Sidebar + sections, `region`/`section` state | **Tabs** (`Search / Trending / Real-Debrid / TorBox / Sources`), `view` state |
| Downloading | Local **webtorrent** engine + download queue + seeding | Cloud **debrid** (TorBox / Real-Debrid) + a local **accelerator** that pulls finished debrid files |
| Config | `{ downloadDir, trackers }` | `{ sources, torznab, firstRunDone, debrid }` |
| Magnet build | `buildMagnet` + public trackers | `buildMagnet` + hardcoded `TRACKERS` in `src/sources/magnet.ts` |

Because of this, some torlink features are **N/A** or **already present**. The
sections below are ordered: **PORT THESE** first, then **SKIP / N/A** with
reasons.

---

## Commit inventory (last 5 days)

| Date | Commit | Feature | Verdict for minch-cli |
|---|---|---|---|
| Jul 2 | `bf2dace` | Accept a bare infohash (#32) | **PORT** |
| Jul 2 | `ba45f11` | Compact huge seed:leech counts (`formatCount`) | **PORT (adapt)** |
| Jul 2 | `dd5f1bc` | Paginate the fitgirl RSS feed 3 pages deep | **SKIP** (no RSS source) |
| Jul 2 | `dbe543b` | Drop SolidTorrents so games stop showing under TV | **SKIP / optional** |
| Jul 1 | `f3880f1` | User-added trackers via the `t` key (#31) | **PORT (adapt)** |
| Jul 1 | `6ba3e42` | hjkl navigation (#29) | **MOSTLY PRESENT** (add `h/l` only) |
| Jul 1 | `1b53ef3` | Leave a row of slack below results panel | **SKIP** (layout-specific) |
| Jun 30 | `3c5b559` | Extract upload date for 1337x results | **SKIP / verify** (Cardigann handles dates) |
| Jun 30 | `c114c32` | Change the download folder from the UI (`o` key) | **PORT (adapt)** |
| Jun 30 | `81f449f` | Show sort param during search phase | **VERIFY** (minch already shows sort) |
| Jun 30 | `7fa049a` | Seeders-first default + compact footer | **PARTIAL / optional** |
| Jun 30 | misc | nix flake, cross-platform postbuild, funding, docs | **SKIP** (chore/docs) |

---

# PORT THESE

## Feature 1 — Accept a bare infohash (from `bf2dace`)

**Goal:** Let users pass a bare 40-char hex / 32-char base32 infohash (or a full
`magnet:` URI) both on the CLI and in the in-app search box, and treat it as a
magnet rather than a search query.

### 1a. Add `isInfoHash` + `parseInput` to `src/sources/magnet.ts`

minch already has `parseMagnet`, `normalizeInfoHash`, and `buildMagnet`. Add:

```ts
// Anchored to the whole input so an ordinary search query is never mistaken
// for a hash: only a string that is *nothing but* a 40-char hex or 32-char
// base32 infohash counts. Same char classes as MAGNET_RE's xt group.
const INFOHASH_RE = /^([a-f0-9]{40}|[a-z2-7]{32})$/i;

export function isInfoHash(input: string): boolean {
  return INFOHASH_RE.test(input.trim());
}

// Accepts either a magnet URI or a bare infohash. A bare hash is normalized and
// wrapped with the default public trackers via buildMagnet. Returns null for
// anything that is neither.
export function parseInput(input: string): ParsedMagnet | null {
  const s = input.trim();
  const magnet = parseMagnet(s);
  if (magnet) return magnet;
  if (!isInfoHash(s)) return null;
  const infoHash = normalizeInfoHash(s);
  return { infoHash, name: infoHash, magnet: buildMagnet(infoHash, infoHash) };
}
```

> Note: torlink's `buildMagnet(infoHash, infoHash)` uses the name as the 2nd
> arg. minch's `buildMagnet(infoHash, name?)` has the same signature, so this is
> a drop-in. When custom trackers land (Feature 3), have `parseInput` include
> them too — see that section.

### 1b. Teach the CLI to accept a magnet / infohash / `.torrent`

`src/cli/args.ts` currently only produces `{ kind: "run", initialQuery }`.
Extend `CliCommand` and `parseCliArgs`:

- Add fields to the `run` variant: `initialMagnet?: string` (and optionally
  `initialTorrent?: string` if/when `.torrent` files are supported — minch has
  no torrent-file loader today, so **skip torrent files** unless you add one).
- In `parseCliArgs`, before treating the arg as a query:
  ```ts
  import { isInfoHash } from "../sources/magnet";
  ...
  if (/^magnet:\?/i.test(a)) return { kind: "run", initialMagnet: a };
  if (isInfoHash(a)) return { kind: "run", initialMagnet: a };
  ```
  Keep the existing "join the rest as a query" fallback for normal words.
- **Design decision to confirm with the maintainer:** minch has no local
  download engine, so a bare magnet on the CLI can't "just download". Recommended
  behavior: open the app with the magnet **pre-loaded into an action prompt**
  offering *copy / open externally / send to debrid* (reuse `copyMagnet`,
  `openMagnet`, `sendToDebrid` already in `App.tsx`). Simplest first cut: stash
  it as `initialMagnet`, and on boot show a notice + open the debrid picker.

### 1c. Handle a pasted magnet/infohash in the search box (optional but recommended)

In `App.tsx` `submitQuery`, detect `parseInput(q)`; if it returns non-null,
instead of setting `submittedQuery`, route to a magnet action (copy / open /
send to debrid) rather than running a text search. Gate behind the same
maintainer decision as 1b.

### 1d. Tests (`test/magnet.test.ts`, `test/args.test.ts`)

Port torlink's test cases:
- `isInfoHash`: accepts 40-hex and 32-base32; rejects `"the office 1080p"`,
  `"g".repeat(40)`, `"a".repeat(39)`, `""`.
- `parseInput`: full magnet parses like `parseMagnet`; bare hex wraps into a
  magnet with `&tr=`; base32 decodes to 40-char hex; trims whitespace; returns
  null for junk.
- `parseCliArgs`: `abcdef…01` (40 hex) → `{ kind: "run", initialMagnet: hash }`;
  `"hello"` → treated as query (minch keeps queries as valid, unlike torlink
  which rejects barewords — **do not** change that behavior).

---

## Feature 2 — Compact large seeder counts (from `ba45f11`)

**Goal:** Stop wide seeder counts from pushing/​wrapping the results columns.

### 2a. Add `formatCount` to `src/util/format.ts`

```ts
export function formatCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 10_000) return String(Math.round(n));
  const k = Math.round(n / 1_000);
  if (k < 1_000) return `${k}k`;
  const m = n / 1_000_000;
  return m < 10 ? `${m.toFixed(1).replace(/\.0$/, "")}m` : `${Math.round(m)}m`;
}
```

### 2b. Use it in `src/ui/components/Results.tsx`

minch's results row shows **seeders only** (`{ICON.up}{r.seeders}`) in a
`width={6}` box, not a `seed:leech` pair like torlink. Change:
```tsx
<Text ...>{ICON.up}{formatCount(r.seeders)}</Text>
```
(Consider also compacting the `Trending.tsx` seeders column if it renders raw
counts — check `src/ui/components/Trending.tsx`.)

### 2c. Tests (`test/format.test.ts`)

Port torlink's `formatCount` tests: small counts pass through; `11500→"12k"`,
`999_600→"1m"`, `1_500_000→"1.5m"`; assert result length ≤ 4 for a range of
large values.

---

## Feature 3 — User-added trackers via a key (from `f3880f1`)

**Goal:** Let users add extra announce URLs, persisted to config, and appended to
magnets minch builds from a bare infohash.

> **Adaptation:** torlink feeds trackers into its local webtorrent engine
> (`queue.setTrackers` / `engine.add(..., announce)`). minch has **no local
> engine**, so trackers only matter where minch **builds** magnet links —
> i.e. `buildMagnet` in `src/sources/magnet.ts` (used by `parseInput`, native
> adapters, and any infohash-only result). Scope this feature to that.

### 3a. Config: add `trackers: string[]`

In `src/config/config.ts`:
- Add `trackers?: string[]` to `Config` (top-level; `debrid` is the wrong home).
- Default `[]` in `defaultConfig`.
- In `coerce`, validate: `Array.isArray(parsed.trackers) ? parsed.trackers.filter(t => typeof t === "string" && t) : []`.

### 3b. New `src/config/trackers.ts` (+ `test/trackers.test.ts`)

Port verbatim from torlink:
```ts
const VALID_SCHEME = /^(udp|https?|wss?):\/\//i;
export function parseTrackers(input: string): string[] { /* split on [\s,]+, dedupe, keep valid schemes, preserve order */ }
export function formatTrackers(trackers: string[]): string { return trackers.join(", "); }
```
Tests: blank→`[]`; splits on commas/whitespace/newlines; dedupes; keeps only
`udp/http(s)/ws(s)`; preserves order; `formatTrackers` joins with `", "`.

### 3c. Thread custom trackers into `buildMagnet`

Two options — pick one:
- **(A, simpler)** Give `buildMagnet(infoHash, name?, extraTrackers?: string[])`
  an optional 3rd arg that appends `&tr=` for each extra tracker (deduped
  against the built-in `TRACKERS`). Pass `config.trackers` from `parseInput` and
  from any caller that has config.
- **(B)** A module-level `setExtraTrackers(list)` setter called on boot / config
  save, so `buildMagnet` reads them without plumbing config everywhere. Mirrors
  torlink's `queue.setTrackers`. Slightly more implicit; fine for a global.

Recommend **(A)** for testability. `parseInput` then becomes
`parseInput(input, extraTrackers?)`.

### 3d. UI: a `t`-key prompt (fits minch's tab model)

- New `src/ui/components/TrackersPrompt.tsx` — a bordered inline prompt with a
  text field pre-filled via `formatTrackers(config.trackers)`, `enter` saves
  (`parseTrackers`), `esc` cancels. Adapt torlink's component to minch's
  `theme.ts` (`COLOR`, `ICON`) and its `SearchBar`-style input handling (minch
  has no shared `TextField`/`Panel` — either reuse `SearchBar`'s input pattern
  or add a minimal text field).
- Wire into `App.tsx`: add `editingTrackers` state, an `input === "t"` global
  handler (guard: **`t` currently cycles the time filter in the Search view** —
  see `Results.tsx` `cycleTimeFilter`). To avoid a clash, either (i) use a
  different key such as `T` (capital) or `k`… (also taken), or (ii) only bind
  `t`-for-trackers on non-search tabs. **Recommend a dedicated key that is
  free globally — verify against `App.tsx` and every component's `useInput`
  before choosing.** Update `HelpOverlay.tsx` and the footer hints accordingly.
- Persist via the existing `persist(cfg)` helper. Show a notice like
  `Saved N trackers.` / `Cleared extra trackers.`

### 3e. Tests

- `test/trackers.test.ts` (parse/format) as above.
- Extend `test/config.test.ts` to round-trip `trackers`.
- If you add `buildMagnet(…, extra)`, extend `test/magnet.test.ts` to assert
  extra trackers appear as `&tr=` and are deduped.

---

## Feature 4 — Change the download folder from the UI (from `c114c32`)

**Goal:** An inline prompt to set the accelerator's download directory.

> **Adaptation:** minch already stores the dir at `config.debrid.downloadDir`
> and resolves it via `resolveDownloadDir(config)` (`src/download/manager.ts`),
> used by the local accelerator. torlink stores it at `config.downloadDir`.
> Keep minch's existing location (`debrid.downloadDir`) to avoid a migration.

### 4a. New `src/config/folder.ts` (+ `test/folder.test.ts`)

Port verbatim from torlink:
```ts
export function expandHome(input, home = os.homedir()): string { /* ~, ~/, ~\ */ }
export function normalizeDownloadDir(input, home = os.homedir()): string { /* blank -> "" else path.normalize(expandHome) */ }
```
Tests: `~`→home; `~/Movies`→`join(home,"Movies")`; `~\Movies`→same; absolute
trimmed untouched; `~weird` untouched; blank→`""`; tilde path normalized.

### 4b. New `src/ui/components/FolderPrompt.tsx`

Adapt torlink's component to minch's theme + input conventions (no shared
`Panel`/`TextField` in minch — reuse the `SearchBar` input pattern or a minimal
field). Pre-fill with `resolveDownloadDir(config)`; `enter` saves, `esc`
cancels.

### 4c. Wire into `App.tsx`

- Add `editingFolder` state.
- **Key choice:** torlink uses `o`, but in minch **`o` = open magnet
  externally** (see `Results.tsx`/`Trending.tsx`). Do **not** reuse `o`. Pick a
  free global key (verify first). Suggest surfacing folder editing from the
  debrid/accelerator tabs where it's contextually relevant, or a capital key.
- `setDownloadDir(raw)`: `normalizeDownloadDir` → if changed, `fs.mkdir(dir,
  {recursive:true})` (fail soft with a notice), then
  `persist({ ...config, debrid: { ...config.debrid, downloadDir: dir } })`.
- Hide the body while the prompt is open (mirror how `accountsOpen` / `showHelp`
  short-circuit rendering in `App.tsx`).
- Update `HelpOverlay.tsx` and footer hints.

### 4d. Tests

- `test/folder.test.ts` as above.
- Extend `test/config.test.ts` if you change any coercion.

---

# MOSTLY PRESENT — small gap only

## Feature 5 — hjkl navigation (from `6ba3e42`)

minch **already** supports `j`/`k` for up/down in `Results.tsx`, `Trending.tsx`,
`Sources.tsx`, `Accounts.tsx`, and `ProviderTransfers.tsx` (confirmed by
search). The only missing piece is `h`/`l`:

- torlink uses `h`/`l` to move between **sidebar and content**. minch has no
  sidebar; the equivalent is **tab switching** (currently `tab`).
- **Optional:** bind `l` = next tab and `h` = previous tab in `App.tsx`'s global
  `useInput`, alongside `tab`. Verify `h`/`l` aren't already consumed on any tab
  (they aren't in results/trending). Update `HelpOverlay.tsx` to read
  `↑↓←→ / h j k l` and document `h/l` = switch tab.
- Low priority; do only if you want full vim parity.

---

# SKIP / NOT APPLICABLE (with reasons)

- **`dd5f1bc` fitgirl RSS 3-page pagination** — minch has **no** `src/sources/rss.ts`
  or WordPress/fitgirl source. Games/repack sources in minch come via Cardigann
  YAML. N/A. (If minch ever adds an RSS source, revisit.)
- **`dbe543b` drop SolidTorrents from a TV category** — torlink-specific category
  routing. minch has `solidtorrents.ts` but categorizes differently. Optional:
  audit minch's category mapping only if users report games under TV.
- **`3c5b559` extract 1337x upload date** — minch's 1337x is a **Cardigann YAML
  definition** (`definitions/public/1337x.yml`) parsed by the generic executor
  (`src/cardigann/executor.ts` + `dates.ts`), not a hand-written scraper.
  Date extraction is already generic. **Verify** 1337x results populate
  `added`; if not, fix the YAML `fields`/`dateheaders` rather than porting
  torlink's regex. No custom code port needed.
- **`1b53ef3` slack row below results** — layout tweak tied to torlink's box
  model. minch computes `listRows` from `chrome` in `App.tsx`; adjust only if
  the last row is being clipped.
- **`81f449f` show sort during search** — minch's `Results.tsx` **already**
  renders `sort: {sortLabel(sort)}` in the header at all times. Likely already
  covered; verify no regression.
- **`7fa049a` seeders-first default + compact footer** — minch's default sort is
  `"default"` (`defaultOrder`), not seeders-first. Changing the default sort is a
  **product decision**; raise with the maintainer before changing. Footer is
  already compact and contextual per tab.
- **nix flake / cross-platform postbuild / funding / readme** — chore/docs;
  port only if desired for packaging parity.

---

# Suggested execution order

1. **Feature 2 (`formatCount`)** — smallest, self-contained, immediate polish.
2. **Feature 1 (bare infohash)** — `magnet.ts` + `args.ts` + tests; confirm the
   in-app magnet-action UX with the maintainer.
3. **Feature 3 (custom trackers)** — depends on `buildMagnet` change from
   Feature 1's `parseInput`; do after Feature 1.
4. **Feature 4 (download folder UI)** — independent; pick a non-conflicting key.
5. **Feature 5 (`h`/`l` tab nav)** — optional vim polish.

# Validation for every step

- Typecheck: `npm run typecheck` (or the project's TS build — check
  `package.json`/`tsup.config.ts`).
- Unit tests: `npx vitest run` (config at `vitest.config.ts`), plus the specific
  new test files.
- Manual smoke via the CLI (tmux) for the new prompts and CLI-arg magnet path.

# Open decisions to confirm with the maintainer

1. **Bare magnet/infohash on the CLI**: since minch has no local engine, what
   should happen — open the debrid picker, copy to clipboard, or open externally?
2. **Key bindings**: `t` (trackers) and `o` (folder) both **collide** with
   existing minch bindings (`t` = time filter, `o` = open magnet). Choose free
   keys before implementing.
3. **Trackers scope**: confirm they only affect minch-built magnets
   (`buildMagnet`), since there's no local torrent client to feed announce URLs.
4. **Seeders-first default sort** (from `7fa049a`): change minch's default or
   leave as `defaultOrder`?
