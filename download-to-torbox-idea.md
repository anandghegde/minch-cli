# Goal Prompt: Download to TorBox (+ shared debrid foundation)

> One of three related feature prompts:
> 1. **download-to-torbox-idea.md** (this file) — establishes the shared debrid
>    foundation and the TorBox provider.
> 2. `download-to-real-debrid-idea.md` — adds Real Debrid on top of the same
>    foundation.
> 3. `download-local-accelerator-idea.md` — pulls finished cloud files to disk
>    with a built-in multi-connection download accelerator.
>
> This file is the foundation; build it first. The other two reuse the
> `DebridProvider` abstraction, `Transfer` model, config block, and Transfers
> screen defined here.

## Mission

Extend `minch-cli` (the public-source torrent **finder**) so that a found result
can be **handed off to TorBox** for cloud download with a single keypress, and
so the user can monitor those cloud transfers inside the existing Ink TUI — with
**no local torrent client, no DHT, no seeding** on the user's machine.

This is greenfield: minch-cli currently has **zero** debrid/cloud code.

While implementing TorBox, also build the **provider-agnostic foundation** that
Real Debrid and the local accelerator will reuse, so the TUI never branches on a
specific provider.

## Context: where this lands in `minch-cli`

minch-cli is Node 20+/TypeScript/Ink (React for the terminal), bundled with
`tsup`, shipped to npm, run as `minch`. Reuse these existing seams — do not
reinvent them:

- **Result model** — `src/sources/types.ts`: `TorrentResult` carries `infoHash`,
  `magnet`, optional `downloadUrl`, `name`, `sizeBytes`. These are the inputs to
  a hand-off.
- **Magnet helpers** — `src/sources/magnet.ts`: `parseMagnet`,
  `infoHashFromMagnet`, `normalizeInfoHash`, `buildMagnet`. Use for extracting
  the BTIH and building cache-check hashes.
- **HTTP** — `src/util/net.ts`: `fetchResilient` / `fetchText` (global fetch,
  retry/backoff, `HttpError`, `USER_AGENT`, `AbortController` timeout pattern).
  All debrid requests go through / extend this, never raw fetch.
- **Config + persistence** — `src/config/config.ts` (`Config`, `loadConfig`,
  `saveConfig`) + `src/util/atomic.ts` (`serializeWrites`, `writeJsonAtomic`).
  Extend `Config` with a `debrid` block; persist via the existing atomic writer.
- **State + actions** — `src/ui/App.tsx` owns all state and exposes actions
  through one React Context store (`src/ui/store.ts`). New actions are added
  here, exactly like the existing `copyMagnet` / `openMagnet`.
- **Result keybindings** — `src/ui/components/Results.tsx` `useInput` (today:
  `y` copy, `d`/`o` open). Add the new "send to debrid" key here.
- **Screens** — `src/ui/App.tsx` view switch + `tab` toggling (`Search` ↔
  `Sources`). Add a third view: **`Transfers`** (new component
  `src/ui/components/Transfers.tsx`, mirror `Sources.tsx`).
- **Footer/help** — `src/ui/components/Footer.tsx`, `HelpOverlay.tsx`: register
  the new keys.

Hard constraints (unchanged project rules): **no native addons** (must stay
`tsup`-bundleable and `npx`-runnable cross-platform), **no torrent
client / DHT / peer protocol locally**, local JSON config (no DB), Vitest with
fixtures (no live network in the default suite).

---

## Part A — Shared debrid foundation (build once, reused by all three prompts)

### A.1 Provider abstraction — `src/debrid/types.ts`

One interface implemented by every service so the TUI stays provider-agnostic:

```ts
export type DebridId = "torbox" | "realdebrid";

export interface DebridProvider {
  id: DebridId;
  label: string;                                   // "TorBox"
  isConfigured(): boolean;                          // has a usable key/token

  checkAuth(signal?: AbortSignal): Promise<AccountInfo>;          // validate key
  addMagnet(magnet: string, opts?: AddOptions): Promise<AddResult>;
  addTorrentFile?(data: Uint8Array, name: string, opts?: AddOptions): Promise<AddResult>;

  listTransfers(signal?: AbortSignal): Promise<Transfer[]>;        // normalized
  getTransfer(id: string, signal?: AbortSignal): Promise<Transfer>;
  remove(id: string, signal?: AbortSignal): Promise<void>;

  // Resolve ONE finished file to a direct, range-capable HTTPS URL
  // (consumed by the local accelerator prompt).
  resolveFileUrl(transferId: string, fileId: string, signal?: AbortSignal): Promise<ResolvedFile>;
}
```

Normalized, provider-agnostic types (each adapter maps its raw API onto these):

```ts
export type TransferStatus =
  | "queued" | "downloading" | "seeding" | "done" | "error" | "needs_selection";

export interface TransferFile { id: string; name: string; sizeBytes: number; selected: boolean; }

export interface Transfer {
  provider: DebridId;
  id: string;                  // provider-native id, as string
  name: string;
  sizeBytes: number;
  progress: number;            // 0..1
  status: TransferStatus;
  downloadSpeedBps?: number;
  etaSeconds?: number;
  files: TransferFile[];
  hash?: string;
  addedAt?: number;            // unix seconds
}

export interface AddOptions { name?: string; cacheOnly?: boolean; signal?: AbortSignal; }
export interface AddResult { id?: string; queuedId?: string; hash?: string; detail?: string; alreadyPresent?: boolean; }
export interface ResolvedFile { url: string; filename: string; sizeBytes?: number; }
export interface AccountInfo { email?: string; plan?: string; premium?: boolean; }
```

Adapters live in `src/debrid/<provider>.ts`; `src/debrid/registry.ts` returns
the list of **configured** providers. Each adapter owns its base URL, auth
header, request encoding, envelope parsing, status mapping, and normalizes
errors to a shared `DebridError` with a `kind` of
`auth | quota | validation | transient | unknown`, a human message, and an
optional `retryAfterMs`.

### A.2 Config & key security — `src/config/config.ts`

Extend `Config`:

```ts
debrid?: {
  preferred?: DebridId;
  torbox?: { apiKey?: string };
  realdebrid?: { token?: string }; // reserved; populated by the RD prompt
  downloadDir?: string;            // reserved; used by the accelerator prompt
};
```

Key-handling rules (decisions baked in — keep them):
- **Source precedence:** env vars (`MINCH_TORBOX_KEY`) override the config file.
  Otherwise an in-TUI "Accounts" entry captures the key.
- **At rest:** keep the existing plaintext `config.json` but write it with file
  mode `0600`, and **never print a full key** — mask to the last 4 chars in any
  UI/notice/log. (No OS keychain: it would require native deps, which are
  banned.)
- Provide a `checkAuth` affordance so the user can confirm the key works (shows
  masked key + plan).

### A.3 Transfers screen + store wiring

- New view **`Transfers`**: `tab` cycles `Search → Sources → Transfers`.
  Component `src/ui/components/Transfers.tsx` lists transfers from **all
  configured providers**, each row showing a provider badge, name, status, a
  progress bar, speed, ETA, and size.
- Polling hook `src/ui/hooks/useTransfers.ts` (mirror
  `src/ui/hooks/useConcurrentSearch.ts`): poll configured providers
  concurrently, **adaptive interval — ~4s when any transfer is active, ~15s
  when all idle/done**, with abort + backoff on rate-limit. Merge + sort
  newest-first. A failure on one provider must never blank the screen.
- Store actions (`App.tsx` + `store.ts`): `sendToDebrid(result, providerId)`,
  `refreshTransfers()`, `removeTransfer(t)`. Surface outcomes through the
  existing transient `notice` mechanism. (`downloadLocally` is added by the
  accelerator prompt.)

---

## Part B — TorBox provider (`src/debrid/torbox.ts`)

### UX
- On a result row in `Results.tsx`, a key (**`b`** = "to box/debrid") calls
  `store.sendToDebrid(result, "torbox")`. If TorBox is the only configured
  provider, go direct; if none configured, show "Add a TorBox key in Accounts".
- Prefer sending the **magnet**. If a result only has a `.torrent` `downloadUrl`,
  fetch the bytes via `fetchResilient` and use the file-upload path.
- Optional pre-flight: `checkcached` to label "instant (cached)" vs "will queue".
- On success, show the envelope `detail` (e.g. "Found Cached Torrent. Already
  added.") and switch focus to the Transfers screen.

### TorBox API contract (verified against the `minch` Swift client)
- **Base:** `https://api.torbox.app/v1/api` (the trailing `/api` is part of the
  base; append paths). **Auth:** `Authorization: Bearer <key>` on every request;
  `Accept: application/json`.
- **Add magnet:** `POST /torrents/createtorrent`, **`multipart/form-data`**,
  fields: `magnet` (required), `name` (optional), `as_queued=false` (only for
  "cache-only"). **`.torrent` upload:** same endpoint, file field name **`file`**,
  part `Content-Type: application/x-bittorrent`, plus optional `name`/`as_queued`
  text fields.
- **Web link (bonus):** `POST /webdl/createwebdownload`, multipart `link`
  (+ optional `name`).
- **Add response (`data`):** `torrent_id`, `hash`, `queued_id`; use envelope
  `detail` as the user-facing message. `torrent_id == null && queued_id == null`
  ⇒ failure. A response with only `queued_id` ⇒ queued, not yet active.
- **List/poll:** `GET /torrents/mylist` (add `?bypass_cache=true` only when a
  transfer is active) and `GET /webdl/mylist`. Map `download_state` → status:
  `downloading|metadl|downloadingmetadata` → downloading;
  `uploading|seeding` → seeding;
  `completed|cached|downloaded|finished` → done; `paused` → queued;
  `error|failed|missingfiles` → error; else → queued. Read
  `id, hash, name, size, progress (0..1), download_speed, eta,
  files[]{id,name,short_name,size,mimetype}`. Web-download ids should be
  namespaced (e.g. `webdl:<id>`) to avoid colliding with torrent integer ids.
- **Cache check:** `GET /torrents/checkcached?hash=<csv>&format=object&list_files=false`;
  `data` is a hash-keyed object (present ⇒ cached) or `false`/`null` per hash.
  Derive the BTIH client-side from the magnet's `xt=urn:btih:` (use
  `src/sources/magnet.ts`).
- **Resolve file URL** (used by the accelerator prompt):
  `GET /torrents/requestdl?torrent_id=<id>&file_id=<n>&append_name=true&token=<key>`
  — note the key is passed **as the `token` query param** *in addition to* the
  Bearer header. `data` is a **bare URL string**. Web downloads use `web_id`
  instead of `torrent_id` at `/webdl/requestdl`. If a normalized file id is
  stored composite (`<transferId>:<fileId>`), send only the raw numeric file id.
- **Control (bonus):** `POST /torrents/controltorrent` JSON
  `{ "torrent_id": <int>, "operation": "resume|reannounce|delete|stop_seeding" }`.
- **Envelope:** every response is `{ success, detail, error, data }`; **treat
  `success:false` as an error even on HTTP 200**; all fields snake_case.
- **Errors:** 401/403 → auth; 402/429 → quota (read `Retry-After`,
  `X-RateLimit-Remaining`; back off ~60s); 400/422 → validation; 5xx →
  transient. The human message lives in the body's `detail`/`error`.

---

## TUI / keybinding plan (this prompt)
- `Results.tsx`: add **`b`** → `sendToDebrid(result, "torbox")`. Keep `y/d/o`.
- `Transfers.tsx`: `↑/↓` move, `r` refresh now, `x` remove from provider.
  (Local-download keys come from the accelerator prompt.)
- `Footer.tsx` + `HelpOverlay.tsx`: document the new keys.
- "Accounts" affordance to paste/clear the TorBox key and run `checkAuth`.

## Non-goals
- No local torrent client, DHT, peer wire protocol, or seeding.
- No private trackers (unchanged project scope).
- No full TorBox surface (streaming/transcode, settings sync, subscriptions UI)
  beyond add → monitor → (resolve, for the accelerator prompt).
- No background daemon; transfers are polled only while the TUI is open.
- No new native dependencies.

## Acceptance criteria
- With a TorBox key set (env var or Accounts), pressing `b` on a result adds the
  magnet (or `.torrent`) to TorBox; the new transfer appears in the Transfers
  screen and updates live (status/progress/speed/ETA).
- `checkcached` correctly labels cached vs queued before/at add time.
- Errors (bad key, rate limit, invalid magnet) surface as clear, non-crashing
  notices; the Transfers screen never blanks on a single failed poll.
- The key is never printed in full; the env-var override works; `config.json`
  stays valid and is written atomically with mode `0600`.
- The `DebridProvider` abstraction, `Transfer` model, config block, and
  Transfers screen are in place and provider-agnostic, ready for the Real Debrid
  and accelerator prompts.

## Testing (Vitest, fixtures, no live network)
- TorBox adapter: multipart body construction (magnet + file variants), envelope
  parsing, `download_state` → status mapping, `requestdl` bare-URL handling, and
  error normalization (401/402/429/422/5xx) from saved fixture responses.
- Magnet → BTIH extraction and `checkcached` hash CSV building.
- `registry` returns only configured providers; `useTransfers` merge/sort with a
  mocked provider list.

## Appendix — TorBox cheat-sheet
| | TorBox |
|---|---|
| Base | `https://api.torbox.app/v1/api` |
| Auth | `Authorization: Bearer <key>` (+ `?token=<key>` on `requestdl`) |
| Add magnet | `POST /torrents/createtorrent` multipart `magnet` (+`name`,`as_queued`) |
| Add `.torrent` | same endpoint, multipart `file` (`application/x-bittorrent`) |
| Poll | `GET /torrents/mylist` (+`?bypass_cache=true` when active) |
| Status field | `download_state`; `progress` is `0..1` |
| Cache check | `GET /torrents/checkcached?hash=<csv>&format=object&list_files=false` |
| Resolve URL | `GET /torrents/requestdl?torrent_id=&file_id=&append_name=true&token=` → bare URL string |
| Envelope | `{success,detail,error,data}`; `success:false` = error even on 200 |
| Rate limit | 402/429 + `Retry-After` / `X-RateLimit-Remaining`; back off ~60s |
