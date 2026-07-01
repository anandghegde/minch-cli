# Goal Prompt: Download to Real Debrid

> One of three related feature prompts:
> 1. `download-to-torbox-idea.md` — establishes the shared debrid foundation +
>    TorBox provider. **Build it first; this prompt depends on its foundation.**
> 2. **download-to-real-debrid-idea.md** (this file) — adds Real Debrid on top of
>    the same foundation.
> 3. `download-local-accelerator-idea.md` — pulls finished cloud files to disk
>    with a built-in multi-connection accelerator.

## Mission

Add **Real Debrid** as a second debrid provider in `minch-cli`, so a found
result can be handed off to RD for cloud download exactly like TorBox — reusing
the same `DebridProvider` abstraction, `Transfer` model, config block, and
Transfers screen. The crucial difference from TorBox: **RD requires an explicit
file-selection step**, and a torrent's `links` are **not** direct downloads —
each must be **unrestricted** to get a real URL.

## Prerequisite: the shared foundation

This prompt assumes the foundation from `download-to-torbox-idea.md` exists. For
standalone reference, the contract you implement against is:

```ts
export type DebridId = "torbox" | "realdebrid";

export interface DebridProvider {
  id: DebridId;
  label: string;
  isConfigured(): boolean;
  checkAuth(signal?): Promise<AccountInfo>;
  addMagnet(magnet: string, opts?: AddOptions): Promise<AddResult>;
  addTorrentFile?(data: Uint8Array, name: string, opts?: AddOptions): Promise<AddResult>;
  listTransfers(signal?): Promise<Transfer[]>;
  getTransfer(id: string, signal?): Promise<Transfer>;
  remove(id: string, signal?): Promise<void>;
  resolveFileUrl(transferId: string, fileId: string, signal?): Promise<ResolvedFile>;
}
```

with normalized types `Transfer`, `TransferFile`, `TransferStatus`
(`queued|downloading|seeding|done|error|needs_selection`), `AddResult`,
`ResolvedFile`, `AccountInfo`, and a shared `DebridError`
(`kind: auth|quota|validation|transient|unknown`). If the foundation is not yet
built, build it per `download-to-torbox-idea.md` first.

Deliver: `src/debrid/realdebrid.ts` implementing `DebridProvider`, registered in
`src/debrid/registry.ts`, plus an RD entry in the `Config.debrid` block. All HTTP
goes through `src/util/net.ts` (`fetchResilient`). No new native deps.

## Context: where this lands in `minch-cli`

Same seams as the foundation prompt — the only RD-specific touchpoints are:
- `src/debrid/realdebrid.ts` — the adapter (new).
- `src/config/config.ts` — `debrid.realdebrid.token` (already reserved).
- `src/ui/components/Results.tsx` — when **both** providers are configured, the
  `b` ("send to debrid") key opens a 2-item provider picker; otherwise it goes
  to whichever single provider is configured.
- `src/ui/components/Transfers.tsx` — already provider-agnostic; RD transfers
  show with an "RD" badge alongside TorBox.

## UX

- Result row, key `b` → `store.sendToDebrid(result, "realdebrid")` (directly, or
  via the provider picker when both are configured).
- **Default behavior: add magnet, then auto-select all files** (`files=all`) so
  it "just downloads." Design the adapter so a future "pick files" UI can pass a
  specific id list, but **default to `all`**.
- Refuse the hand-off with a clear message if the account is **not premium**
  (RD torrent features require premium).
- Map RD statuses into the normalized model; only surface
  `waiting_files_selection` as `needs_selection` if auto-select is ever disabled.

## The RD flow (important — differs from TorBox)

`addMagnet` returns only `{ id, uri }`; the torrent is **not** downloading yet.
The adapter's `addMagnet` must orchestrate:

1. `POST /torrents/addMagnet` → `{ id }`.
2. (Brief) poll `GET /torrents/info/{id}` until `status` leaves
   `magnet_conversion` and `files[]` is populated.
3. `POST /torrents/selectFiles/{id}` with `files=all` (or a chosen id list).
   **Without this the torrent is stuck in `waiting_files_selection`.**
4. Return `AddResult { id }`. Ongoing progress comes from `listTransfers` /
   `getTransfer` polling like any other provider.

For `resolveFileUrl(transferId, fileId)` (consumed by the accelerator prompt):
1. `GET /torrents/info/{id}` → take `files` (only those with `selected:1`) and
   `links[]`. The `links` correspond to the **selected** files **in order**, so
   build the mapping `selectedFiles[i] ↔ links[i]`.
2. `POST /unrestrict/link` with `link=<the chosen links[i]>`.
3. Return `ResolvedFile { url: data.download, filename, sizeBytes: filesize }`.
   `download` is the direct, range-capable URL.

## Real Debrid API contract (from the official REST docs)

- **Base:** `https://api.real-debrid.com/rest/1.0`. **Auth:**
  `Authorization: Bearer <token>` (private API token from
  https://real-debrid.com/apitoken). **Rate limit: 250 requests/min** → HTTP 429
  (refused requests still count against the limit — poll conservatively, reuse
  the adaptive 4s/15s interval and back off hard on 429).
- **Add magnet:** `POST /torrents/addMagnet`, **form-urlencoded** param `magnet`
  (optional `host`) → HTTP **201**, body `{ id, uri }`.
- **Add `.torrent` file:** `PUT /torrents/addTorrent`, raw `.torrent` bytes as
  the request body (optional `?host=`) → 201 `{ id, uri }`.
- **Select files (REQUIRED):** `POST /torrents/selectFiles/{id}`, form param
  `files` = comma-separated file IDs **or `"all"`** → 204 (202 if already done).
- **Torrent info / poll:** `GET /torrents/info/{id}` →
  `{ id, filename, hash, bytes, progress (0..100), status,
  files:[{id,path,bytes,selected}], links:[...], speed?, seeders?, ended? }`.
  Statuses: `magnet_error, magnet_conversion, waiting_files_selection, queued,
  downloading, downloaded, error, virus, compressing, uploading, dead`.
  Normalize: `downloaded` → done; `downloading|compressing|uploading` →
  downloading; `queued|magnet_conversion` → queued;
  `waiting_files_selection` → needs_selection;
  `error|virus|dead|magnet_error` → error. **`progress` is 0–100 — divide by
  100.** Each entry in `links[]` is one host-URL per **selected** file, in file
  order.
- **List:** `GET /torrents` (`offset|page`, `limit`≤5000, `filter=active`);
  `X-Total-Count` response header for pagination.
- **Resolve file URL:** `POST /unrestrict/link`, form param `link` = one entry
  from the torrent's `links[]` → `{ id, filename, filesize, host, chunks,
  download, streamable }`. **`download` is the direct URL** for the accelerator.
- **Delete:** `DELETE /torrents/delete/{id}` → 204.
- **User:** `GET /user` → `{ id, username, email, points, type: "premium"|"free",
  premium (seconds left), expiration }`. Use for `checkAuth`; refuse offload when
  `type != "premium"`.
- **Errors:** HTTP 4xx/5xx with `{ error, error_code }`. Map the numeric
  `error_code` (more reliable than the message): `8` bad token → auth;
  `9` permission denied → auth; `34` too many requests / `5` slow down → quota;
  `21` too many active downloads, `23` traffic exhausted, `36` fair-usage →
  quota/validation with a clear message; `35` infringing file, `16` unsupported
  hoster, `30` torrent file invalid → validation; `-1`/`25`/`6` → transient.

### Auth: token now, OAuth later
Start with a **pasted private API token** (simplest; entered in Accounts or via
`MINCH_RD_TOKEN`). Structure the adapter so an OAuth2 **device flow** can be
added later without changing callers (open-source client id `X245A4XAIBGVM`,
scopes `unrestrict,torrents,downloads,user`, with `refresh_token` persistence in
`Config.debrid.realdebrid`). Mask the token to last 4 chars everywhere; honor
the env-var override; write `config.json` with mode `0600`.

## TUI / keybinding plan (this prompt)
- `Results.tsx`: when both TorBox and RD are configured, `b` opens a tiny
  provider picker (TorBox / Real Debrid); otherwise it sends to the single
  configured provider. Respect `Config.debrid.preferred` to pre-select.
- `Transfers.tsx`: unchanged, now shows RD-badged rows; `x` removes via
  `DELETE /torrents/delete/{id}`.
- `Footer.tsx` + `HelpOverlay.tsx`: mention the provider picker.
- "Accounts" affordance: paste/clear the RD token, run `checkAuth` (show masked
  token + `premium`/`free` + expiration).

## Non-goals
- No local torrent client, DHT, peer protocol, or seeding.
- No private trackers (unchanged project scope).
- No full RD surface (streaming/transcode, downloads-history UI, hosts/regex,
  settings, forums) beyond add → select → monitor → resolve.
- No OAuth device flow in v1 (token only), though the adapter must not preclude
  it.
- No new native dependencies.

## Acceptance criteria
- With an RD token set (env var or Accounts), pressing `b` on a result adds the
  magnet, **auto-selects all files**, and the transfer appears in the Transfers
  screen updating live (`progress/100`, status, speed/seeders when present).
- Non-premium accounts are refused with a clear message; bad token → an auth
  notice prompting re-entry.
- `resolveFileUrl` returns a working direct `download` URL by correctly mapping
  selected files to `links` and unrestricting the chosen one.
- 429 / rate-limit and `error_code` values are handled with clear, non-crashing
  notices and conservative backoff; one failed poll never blanks the screen.
- When both providers are configured, the user can choose per hand-off; Transfers
  shows both, labeled. Token is never printed in full; `config.json` stays valid
  and `0600`.

## Testing (Vitest, fixtures, no live network)
- RD adapter: form-urlencoded body building; the **add → poll → selectFiles**
  sequence (assert `selectFiles` is always called); status mapping incl. the
  `progress/100` conversion; selected-files ↔ `links` ordering; the
  `unrestrict/link` → `download` resolution; `error_code` normalization
  (8/9/34/21/23/35).
- `checkAuth` premium gating from a fixture `GET /user` response.
- Provider picker logic: none / one / both configured.

## Appendix — Real Debrid cheat-sheet
| | Real Debrid |
|---|---|
| Base | `https://api.real-debrid.com/rest/1.0` |
| Auth | `Authorization: Bearer <token>` (250 req/min → 429) |
| Add magnet | `POST /torrents/addMagnet` form `magnet` → 201 `{id,uri}` |
| Add `.torrent` | `PUT /torrents/addTorrent` (raw body, optional `?host=`) → 201 |
| Select files | **`POST /torrents/selectFiles/{id}` `files=all` (required)** |
| Poll | `GET /torrents/info/{id}` — `status`, `progress` is `0..100` |
| Resolve URL | `POST /unrestrict/link` `link=<links[i]>` → `.download` |
| Delete | `DELETE /torrents/delete/{id}` |
| User | `GET /user` → `type:"premium"\|"free"` |
| Errors | `{error,error_code}`; 8=bad token, 34=too many req, 23=traffic exhausted, 35=infringing |
