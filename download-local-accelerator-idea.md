# Goal Prompt: Local accelerated download from TorBox / Real Debrid

> One of three related feature prompts:
> 1. `download-to-torbox-idea.md` — shared debrid foundation + TorBox provider.
> 2. `download-to-real-debrid-idea.md` — Real Debrid provider.
> 3. **download-local-accelerator-idea.md** (this file) — pulls a finished cloud
>    file to disk with a built-in multi-connection download accelerator and live
>    progress. **Depends on the foundation + at least one provider above.**
>
> This prompt is as much a **design brief** as an implementation task: produce a
> short design doc for the accelerator (the open decisions below) alongside the
> code.

## Mission

From the **Transfers** screen, let the user pull a finished cloud file down to
local disk using a **built-in, multi-connection (range-parallel) download
accelerator** — faster than a single connection — with a **live progress bar**
(percent, downloaded/total, speed, ETA, connection count) rendered in the Ink
TUI. Resumable, robust to flaky networks and expiring debrid links, **pure Node,
no native deps, no required external binary**.

## Prerequisite: the resolve-URL contract

The accelerator consumes a plain direct URL produced by the provider layer:

```ts
// from src/debrid/types.ts (foundation prompt)
resolveFileUrl(transferId: string, fileId: string, signal?): Promise<ResolvedFile>;
export interface ResolvedFile { url: string; filename: string; sizeBytes?: number; }
```

- **TorBox:** `GET /torrents/requestdl?...&token=<key>` returns a bare URL string.
- **Real Debrid:** `POST /unrestrict/link` returns `{ download, filename, filesize }`.

Both are short-lived, **range-capable HTTPS CDN URLs** — exactly what a segmented
downloader wants. The accelerator itself is **provider-agnostic**: it only sees a
URL. Re-resolution on expiry happens via a callback back into the owning
`DebridProvider` (below). If the foundation/providers don't exist yet, build at
least `download-to-torbox-idea.md` first.

## Context: where this lands in `minch-cli`

- **HTTP** — reuse/extend `src/util/net.ts` (`fetchResilient`, retry/backoff,
  `AbortController` pattern, `USER_AGENT`). Range requests stream via the global
  `fetch`/`undici` response body.
- **Atomic writes** — follow the `src/util/atomic.ts` philosophy (write to a temp
  name, then rename) for the final file.
- **State + actions** — add `store.downloadLocally(transfer, file?)` in
  `src/ui/App.tsx` + `src/ui/store.ts`; render progress in
  `src/ui/components/Transfers.tsx` (and/or a dedicated download panel).
- **Config** — `Config.debrid.downloadDir` (reserved in the foundation prompt)
  for the destination directory.
- **OS integration** — `src/util/clipboard.ts` (`openExternal`) for a "reveal in
  folder / open file" affordance on completion.

New modules:
- `src/download/accelerator.ts` — the segmented downloader (URL → file).
- `src/download/manager.ts` — tracks active downloads, exposes progress
  snapshots to the store, handles re-resolve-on-expiry.

Hard constraints (unchanged): **no native addons** (stay `tsup`-bundleable,
`npx`-runnable cross-platform), pure Node + `node:fs`, Vitest with fixtures (no
live network in the default suite).

## Module shape

```ts
// src/download/accelerator.ts
export interface DownloadOptions {
  connections?: number;                 // default 4–8, capped by size
  signal?: AbortSignal;
  onProgress?: (p: DownloadProgress) => void;
  // called when the URL appears expired/forbidden, to fetch a fresh one:
  reResolve?: () => Promise<string>;
}
export interface DownloadProgress {
  receivedBytes: number; totalBytes?: number;
  speedBps: number; etaSeconds?: number;
  connections: number; done: boolean;
}
export interface DownloadResult { path: string; bytes: number; durationMs: number; }

export function downloadFile(url: string, dest: string, opts?: DownloadOptions): Promise<DownloadResult>;
```

```ts
// src/download/manager.ts — many concurrent downloads, each with its own bar;
// snapshots feed the Transfers UI; owns destination naming + re-resolve wiring.
```

`store.downloadLocally(transfer, file?)`: pick the file (auto for single-file
transfers; list/prompt for multi-file), call `provider.resolveFileUrl(...)`,
then hand the URL + a `reResolve` closure to the manager/accelerator.

## Requirements

- **Pure Node, default = our own downloader.** Implement segmented HTTP with
  global `fetch`/`undici` streams + `node:fs` positioned writes
  (`FileHandle.write(buffer, 0, len, position)`). *Open decision:* optionally
  detect and delegate to `aria2c`/`curl` if present — recommend **build our own
  as the default**; treat external tools as an optional later enhancement, never
  a dependency.
- **Capability probe:** issue a small ranged `GET` with `Range: bytes=0-0`
  (preferred over `HEAD`; some CDNs handle it better). From the `206` response
  read `Content-Range` (total size) and confirm range support
  (`Accept-Ranges: bytes` and/or the `206`). Capture `ETag`/`Last-Modified` for
  resume validation. **If ranges are unsupported or size is unknown, fall back to
  a single streamed download** (still show progress).
- **Segmentation:** split into N connections (default 4–8, configurable; use 1
  for small files). **Prefer a fixed worker pool pulling fixed-size chunk ranges
  from a queue** over naive equal splits, so one slow segment can't stall the
  tail. Each worker requests `Range: bytes=start-end` and streams directly to the
  file at its offset.
- **Progress / UX:** aggregate received bytes across all workers; compute a
  rolling speed (EWMA) and ETA; throttle `onProgress` to ~4–10 Hz. Render an Ink
  progress bar: `% · downloaded/total · MB/s · ETA · N conns`. Multiple
  concurrent downloads each show their own bar.
- **Robustness:** per-segment retry with backoff (reuse `net.ts` patterns) and
  abort propagation; on a transient failure re-request only the failed byte
  range; on `403`/`410`/expired-link symptoms, call `reResolve()` for a fresh URL
  and continue the remaining ranges. Verify final size == expected
  `Content-Length`.
- **Atomic + resume:** download into `<name>.part` and persist a sidecar
  `<name>.part.json` describing `{ url-independent: totalBytes, etag,
  lastModified, chunkSize, completedRanges[] }`. On restart, validate
  `ETag`/`Last-Modified`; resume only the missing ranges; on success `fsync` and
  atomically rename `.part` → final, deleting the sidecar. If validation fails
  (file changed) restart cleanly.
- **Destination:** default to `Config.debrid.downloadDir`; if unset, use the OS
  Downloads folder (fall back to cwd) — decide and document. Sanitize filenames;
  resolve collisions (`name (1).ext`).
- **Cancellation:** a TUI key aborts an in-flight download (abort all workers),
  **keeping `.part` + sidecar** so it can resume later.
- **Backpressure & memory:** stream chunks straight to disk; never buffer a whole
  segment in memory; respect stream backpressure.

## Open design decisions (resolve in the design doc, with a recommendation)

1. **Worker-pool chunk queue vs fixed equal segments** — recommend the pool;
   justify the chunk size (e.g. 4–16 MB) and how it interacts with `connections`.
2. **Default connection count & per-host cap** — debrid CDNs may throttle
   aggressive parallelism; make it configurable and **conservative by default**.
3. **Single output `FileHandle` (positioned writes) vs N temp part-files +
   concat** — recommend the single handle to avoid a final concat pass; note the
   pre-allocation strategy (e.g. truncate-to-size up front).
4. **Resume granularity** — track completed ranges at chunk boundaries so a
   crash loses at most one chunk; define the sidecar schema.
5. **Multi-file transfers** — per-file download, a "download all"
   convenience (sequential or limited-parallel), and whether to offer TorBox's
   zip-link option (RD has none) — recommend per-file + "download all".
6. **Link expiry handling** — how expiry is detected (status code vs stalled
   bytes) and how `reResolve` re-keys the in-progress download.

## TUI / keybinding plan
- `Transfers.tsx`: `enter`/`l` on a finished transfer → `downloadLocally`
  (auto-file or a file picker for multi-file); `c` cancels an active local
  download; an inline progress bar per active download; on completion a notice +
  `o` to open the file / reveal in folder via `openExternal`.
- `Footer.tsx` + `HelpOverlay.tsx`: document `l` (download), `c` (cancel),
  `o` (open).

## Non-goals
- No torrent/peer protocol — the accelerator only speaks HTTP(S) range requests
  against debrid CDN URLs.
- No background daemon; downloads run only while the TUI is open (resume covers
  restarts).
- No required external binary and **no native dependencies** (aria2/curl
  delegation, if ever added, must be strictly optional).
- No bandwidth-shaping/scheduling beyond a configurable connection count in v1.

## Acceptance criteria
- A finished TorBox **or** Real Debrid file resolves to a direct URL and
  downloads to `downloadDir` with a visible progress bar (%, size, speed, ETA,
  conns).
- On a large, range-capable URL the accelerator is **measurably faster than a
  single-connection baseline**; on a non-range URL it **falls back cleanly** and
  still completes with progress.
- An interrupted download (kill/cancel) **resumes** from the sidecar instead of
  restarting; final file size matches `Content-Length` and (when available)
  validates against `ETag`/`Last-Modified`.
- An expired debrid link mid-download triggers `reResolve` and the download
  continues without losing completed ranges.
- Cancellation aborts promptly and leaves a resumable `.part`; completion atomically
  renames to the final file and offers open/reveal.
- Multiple concurrent downloads render independent bars; one failing download
  never crashes the screen.

## Testing (Vitest, fixtures, no live network)
- A small in-process **mock range server** (Node `http`) serving a fixture file
  with `Accept-Ranges`/`Content-Range`/`ETag`, plus toggles to: deny ranges
  (force fallback), drop a connection mid-stream (force segment retry), and
  return `403` once (force `reResolve`).
- Unit tests for range math (split/merge, last-chunk size, off-by-one at EOF),
  the resume sidecar (write/validate/resume only-missing-ranges), filename
  sanitize/collision, and EWMA speed/ETA.
- Assert the assembled file is byte-identical to the source for both
  multi-connection and single-stream-fallback paths.

## Appendix — accelerator quick facts
- Probe: ranged `GET Range: bytes=0-0` → `206` + `Content-Range: bytes 0-0/<total>`.
- Per-worker: `Range: bytes=<start>-<end>`, stream → `fh.write(chunk, 0, len, pos)`.
- Inputs are short-lived CDN URLs from `resolveFileUrl`; re-resolve on `403/410`.
- Output: `<name>.part` (+ `<name>.part.json` sidecar) → atomic rename on success.
- Defaults: 4–8 connections (conservative, configurable), 4–16 MB chunks, single
  positioned `FileHandle`.
