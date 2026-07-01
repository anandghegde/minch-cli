# Local download accelerator — design

A provider-agnostic, pure-Node, multi-connection (range-parallel) HTTP
downloader that pulls a finished debrid file to local disk with a live progress
bar, resume, and re-resolve-on-expiry. Two modules:

- `accelerator.ts` — `downloadFile(url, dest, opts)`: the segmented engine plus a
  handful of exported pure helpers (range math, sidecar, filename, speed meter).
- `manager.ts` — `DownloadManager`: tracks many concurrent downloads, owns
  destination naming + the re-resolve closure, and emits snapshots to the TUI.

No native addons, no required external binary (`aria2c`/`curl` delegation is
explicitly out of scope for v1). Streams straight to disk via positioned
`FileHandle.write` so a segment is never buffered whole in memory.

## Resolved open decisions

### 1. Worker-pool chunk queue vs fixed equal segments — **worker pool**

The file is split into fixed-size **chunks** (`planChunks`); a pool of N workers
pulls the next pending chunk index off a shared cursor. This decouples
parallelism from the split: a slow chunk only holds up its own worker, never the
tail, and resume/retry operate on small, independent units.

- **Chunk size: 8 MB default** (clamped ≥ 1 B; tunable via `chunkSizeBytes`).
  Big enough that per-request overhead (TLS, range setup) is amortised, small
  enough that a retry/cancel wastes little and resume granularity stays tight.
  Files ≤ one chunk download as a single ranged request.
- `connections` is the **pool size**, independent of chunk count; effective
  workers = `min(connections, pendingChunks)`.

### 2. Default connection count & per-host cap — **4 default, 16 hard cap**

Debrid CDNs throttle aggressive parallelism, so the default is conservative (4)
and configurable (`Config.debrid.downloadDir` sibling could later carry a
`connections` knob). The accelerator clamps to `[1, 16]`. The manager caps
**global** concurrent downloads at 3 so "download all" can't open dozens of
sockets at once.

### 3. Single `FileHandle` vs N part-files + concat — **single handle**

One `<dest>.part` handle, **pre-allocated** with `ftruncate(totalBytes)` up
front, written by every worker at its absolute offset (`pwrite` semantics —
concurrent positioned writes to one fd are safe). No final concat pass, no 2×
disk usage. On success: `fsync` → atomic `rename(.part → dest)` → delete sidecar.

### 4. Resume granularity — **completed chunks, tracked at chunk boundaries**

A sidecar `<dest>.part.json` records the validators and which chunk indices are
fully written. A crash loses at most the in-flight chunks (one per worker), since
the sidecar is rewritten atomically after **each** chunk commits (serialized so
concurrent workers can't interleave the JSON).

```jsonc
{
  "version": 1,
  "totalBytes": 1073741824,
  "chunkSize": 8388608,
  "etag": "\"abc\"",          // optional
  "lastModified": "…",         // optional
  "completedChunks": [0, 1, 2] // indices into planChunks(total, chunkSize)
}
```

On restart we re-probe, then `sidecarMatches` validates: `chunkSize` must match;
`totalBytes` must match the probe when known; if **both** sides carry an `ETag`
they must be equal (else `Last-Modified`). If they conflict the file changed →
the `.part` + sidecar are discarded and the download restarts cleanly. If the
fresh CDN URL exposes no validator we resume on size match (best-effort; the
final size check still guards correctness).

### 5. Multi-file transfers — **per-file + "download all"**

Single-file transfers download automatically. Multi-file transfers open a small
file picker (`l`) with a **Download all** entry. "Download all" enqueues one
download per file through the manager, which runs them under the global
concurrency cap (3). TorBox's zip-link option is **not** used (Real Debrid has no
equivalent, and per-file keeps the UX uniform and the engine provider-agnostic).

### 6. Link expiry handling — **status-code driven, single-flight re-resolve**

A `401/403/410` on any chunk (or the probe) is treated as an expired link. The
worker calls `reResolve()` — a closure the manager wires back to
`provider.resolveFileUrl(...)` — to fetch a fresh URL. Re-resolution is
**single-flight**: concurrent workers share one in-flight refresh, then each
retries its own range against the new `currentUrl`. The byte offsets are
URL-independent, so already-completed chunks are untouched. Re-resolves are
capped (per chunk) to avoid loops. Stalled-byte detection is noted as a possible
later heuristic; status codes cover the observed debrid behaviour.

## Capability probe

A ranged `GET Range: bytes=0-0` (preferred over `HEAD`; CDNs handle it more
consistently), `Accept-Encoding: identity` so range math isn't broken by
transparent compression:

- `206` + `Content-Range: bytes 0-0/<total>` → ranges supported, total known →
  **segmented path**. Capture `ETag` / `Last-Modified`.
- `200` (server ignored the range) or unknown size → **single-stream fallback**:
  one sequential download, still with a live progress bar, no resume.
- `401/403/410` → expired before we start → `reResolve()` once, then re-probe.

The 1-byte probe body is cancelled immediately so nothing is buffered.

## Progress / UX

Workers update `committed` (bytes from finished chunks) and `live` (bytes from
in-flight attempts, rolled back on retry so retries never double-count). A
`setInterval` at ~4 Hz samples `committed + live` through an EWMA `SpeedMeter`
(α = 0.3) to derive `speedBps` and `etaSeconds`, then emits a `DownloadProgress`
snapshot: `received/total · MB/s · ETA · N conns`. The interval is `unref`-ed and
cleared on completion, which emits one final `done` snapshot.

## Destination

`resolveDownloadDir(config)` = `Config.debrid.downloadDir` if set, else
`~/Downloads` when it exists, else the current working directory. Filenames are
sanitised (`sanitizeFilename`: strip path separators, control/reserved chars,
trailing dots/spaces, Windows device names) and de-duplicated against existing
**final** files (`resolveCollision`: `name (1).ext`, `name (2).ext`, …). The
`.part`/sidecar derive from the chosen final name, so re-running resumes rather
than colliding.

## Robustness & cancellation

- Per-chunk retry with the shared `net.ts` exponential backoff + jitter, honoring
  `Retry-After`. A transient failure re-requests only the failed range.
- Every fetch shares a combined `AbortSignal` (user cancel ∪ internal abort). The
  first fatal error aborts the siblings; the rejection propagates once.
- Cancel aborts all workers and **keeps** the `.part` + sidecar so the next run
  resumes. One failing download never tears down others or the screen.
- Final guard: on-disk size must equal `totalBytes` before the atomic rename.

## Non-goals (v1)

No torrent/peer protocol (HTTP range only), no background daemon (downloads run
while the TUI is open; resume covers restarts), no external-binary delegation, no
bandwidth shaping beyond the connection count.
