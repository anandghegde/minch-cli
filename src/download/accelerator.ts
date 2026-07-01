// Pure-Node, multi-connection (range-parallel) HTTP download accelerator.
//
// `downloadFile(url, dest, opts)` probes a direct CDN URL for range support,
// then either fans the file out across a pool of workers (each streaming a byte
// range straight to its offset in a single pre-allocated `<dest>.part`) or falls
// back to a single sequential stream. Resumable via a `<dest>.part.json`
// sidecar, robust to flaky networks (per-chunk retry/backoff) and expiring
// debrid links (single-flight `reResolve`). See ./DESIGN.md for the rationale.

import { promises as fs } from "node:fs";
import path from "node:path";
import {
  USER_AGENT,
  HttpError,
  RETRY_STATUS,
  backoffDelay,
  parseRetryAfter,
} from "../util/net";
import { serializeWrites } from "../util/atomic";

export type FetchImpl = (url: string, init?: RequestInit) => Promise<Response>;
type Sleep = (ms: number) => Promise<void>;

export interface DownloadOptions {
  /** Worker-pool size. Default 4, clamped to [1, 16]. */
  connections?: number;
  /** Fixed chunk size for the segmented path. Default 8 MiB. */
  chunkSizeBytes?: number;
  signal?: AbortSignal;
  onProgress?: (p: DownloadProgress) => void;
  /** Called when the URL appears expired/forbidden, to fetch a fresh one. */
  reResolve?: () => Promise<string>;
  /** Injectable fetch (tests). Defaults to the global fetch. */
  fetchImpl?: FetchImpl;
  /** Injectable sleep (tests). Defaults to setTimeout. */
  sleepImpl?: Sleep;
  /** Progress emit cadence in ms. Default 250 (~4 Hz). */
  progressIntervalMs?: number;
  /** Transient retries per chunk before giving up. Default 4. */
  retriesPerChunk?: number;
}

export interface DownloadProgress {
  receivedBytes: number;
  totalBytes?: number;
  speedBps: number;
  etaSeconds?: number;
  connections: number;
  done: boolean;
}

export interface DownloadResult {
  path: string;
  bytes: number;
  durationMs: number;
}

/** Thrown when a download is aborted via its signal; lets callers tell cancel
 * apart from a genuine failure (the `.part` + sidecar are kept for resume). */
export class DownloadCanceledError extends Error {
  constructor(message = "Download canceled") {
    super(message);
    this.name = "DownloadCanceledError";
  }
}

const DEFAULT_CONNECTIONS = 4;
const MAX_CONNECTIONS = 16;
const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;
const DEFAULT_PROGRESS_MS = 250;
const DEFAULT_RETRIES = 4;
const BACKOFF_BASE_MS = 300;
const BACKOFF_CAP_MS = 5_000;
const MAX_RERESOLVES = 2;
/** Statuses that signal an expired/forbidden debrid link → re-resolve. */
const EXPIRY_STATUS = new Set([401, 403, 410]);

// --- pure helpers (exported for unit tests) --------------------------------

export interface Chunk {
  index: number;
  /** Inclusive byte offsets. */
  start: number;
  end: number;
}

export function chunkLength(c: Chunk): number {
  return c.end - c.start + 1;
}

/** Split a known total into fixed-size, inclusive byte ranges. */
export function planChunks(totalBytes: number, chunkSize: number): Chunk[] {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return [];
  const size = Math.max(1, Math.floor(chunkSize));
  const chunks: Chunk[] = [];
  let start = 0;
  let index = 0;
  while (start < totalBytes) {
    const end = Math.min(start + size - 1, totalBytes - 1);
    chunks.push({ index, start, end });
    start = end + 1;
    index++;
  }
  return chunks;
}

/** Total bytes from a `Content-Range: bytes 0-0/<total>` header value. */
export function parseContentRangeTotal(value: string | null): number | undefined {
  if (!value) return undefined;
  const m = /\/(\d+)\s*$/.exec(value.trim());
  return m ? Number(m[1]) : undefined;
}

/** EWMA speed estimator. Feed cumulative bytes + a timestamp; get bytes/sec. */
export class SpeedMeter {
  private prevBytes: number | null = null;
  private prevMs = 0;
  private speed = 0;
  constructor(private readonly alpha = 0.3) {}

  sample(totalBytes: number, nowMs: number = Date.now()): number {
    if (this.prevBytes === null) {
      this.prevBytes = totalBytes;
      this.prevMs = nowMs;
      return 0;
    }
    const dt = (nowMs - this.prevMs) / 1000;
    if (dt <= 0) return this.speed;
    const inst = Math.max(0, (totalBytes - this.prevBytes) / dt);
    this.speed = this.speed === 0 ? inst : this.alpha * inst + (1 - this.alpha) * this.speed;
    this.prevBytes = totalBytes;
    this.prevMs = nowMs;
    return this.speed;
  }

  eta(receivedBytes: number, totalBytes?: number): number | undefined {
    if (totalBytes === undefined || this.speed <= 0) return undefined;
    return Math.max(0, (totalBytes - receivedBytes) / this.speed);
  }
}

export interface Sidecar {
  version: 1;
  totalBytes: number;
  chunkSize: number;
  etag?: string;
  lastModified?: string;
  completedChunks: number[];
}

export function sidecarPath(partPath: string): string {
  return `${partPath}.json`;
}

export async function readSidecar(partPath: string): Promise<Sidecar | undefined> {
  try {
    const raw = await fs.readFile(sidecarPath(partPath), "utf8");
    const d = JSON.parse(raw) as Partial<Sidecar>;
    if (
      d &&
      d.version === 1 &&
      typeof d.totalBytes === "number" &&
      typeof d.chunkSize === "number" &&
      Array.isArray(d.completedChunks)
    ) {
      return d as Sidecar;
    }
  } catch {
    /* missing or corrupt → no resume */
  }
  return undefined;
}

export async function writeSidecar(partPath: string, sidecar: Sidecar): Promise<void> {
  const file = sidecarPath(partPath);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(sidecar));
  await fs.rename(tmp, file);
}

/** Whether a sidecar still describes the resource the probe just saw. */
export function sidecarMatches(
  s: Sidecar,
  probe: { totalBytes?: number; etag?: string; lastModified?: string },
  chunkSize: number,
): boolean {
  if (s.chunkSize !== chunkSize) return false;
  if (probe.totalBytes !== undefined && s.totalBytes !== probe.totalBytes) return false;
  // ETag wins; fall back to Last-Modified; if neither side exposes a validator
  // we resume on the size match above (best-effort, guarded by the final size
  // check). Only a *conflict* between two present validators invalidates.
  if (s.etag && probe.etag) return s.etag === probe.etag;
  if (s.lastModified && probe.lastModified) return s.lastModified === probe.lastModified;
  return true;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/** Reduce an arbitrary remote filename to a safe local basename. */
export function sanitizeFilename(name: string): string {
  let n = (name ?? "").trim();
  n = n.split(/[\\/]/).pop() ?? n; // drop any path component
  n = n.replace(/[\u0000-\u001f\u007f]/g, ""); // control chars
  n = n.replace(/[<>:"|?*]/g, "_"); // illegal on Windows
  n = n.replace(/\s+/g, " ").trim();
  n = n.replace(/[. ]+$/, ""); // no trailing dot/space
  if (!n || n === "." || n === "..") n = "download";
  if (WINDOWS_RESERVED.test(n)) n = `_${n}`;
  return n.slice(0, 255);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a non-colliding final path in `dir`, suffixing ` (1)`, ` (2)`, … */
export async function resolveCollision(dir: string, name: string): Promise<string> {
  const safe = sanitizeFilename(name);
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length) || safe;
  let candidate = safe;
  for (let i = 1; ; i++) {
    const full = path.join(dir, candidate);
    if (!(await pathExists(full))) return full;
    candidate = `${stem} (${i})${ext}`;
  }
}

// --- engine ----------------------------------------------------------------

interface ProbeResult {
  totalBytes?: number;
  acceptRanges: boolean;
  etag?: string;
  lastModified?: string;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && (e.name === "AbortError" || /abort/i.test(e.message));
}

async function drain(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* ignore */
  }
}

export async function downloadFile(
  url: string,
  dest: string,
  opts: DownloadOptions = {},
): Promise<DownloadResult> {
  const doFetch: FetchImpl = opts.fetchImpl ?? (globalThis.fetch as FetchImpl);
  const sleep: Sleep =
    opts.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const chunkSize = Math.max(1, opts.chunkSizeBytes ?? DEFAULT_CHUNK_BYTES);
  const maxConns = clamp(opts.connections ?? DEFAULT_CONNECTIONS, 1, MAX_CONNECTIONS);
  const retries = opts.retriesPerChunk ?? DEFAULT_RETRIES;
  const progressMs = opts.progressIntervalMs ?? DEFAULT_PROGRESS_MS;
  const startedAt = Date.now();

  if (opts.signal?.aborted) throw new DownloadCanceledError();

  await fs.mkdir(path.dirname(dest), { recursive: true });
  const part = `${dest}.part`;

  // Combined abort: user cancel OR an internal fatal error stops every fetch.
  const internalAbort = new AbortController();
  const combined = new AbortController();
  const propagate = (): void => combined.abort();
  opts.signal?.addEventListener("abort", propagate, { once: true });
  internalAbort.signal.addEventListener("abort", propagate, { once: true });
  const aborted = (): boolean =>
    !!opts.signal?.aborted || internalAbort.signal.aborted;

  // URL state + single-flight re-resolve shared by the probe and every worker.
  let currentUrl = url;
  let refreshing: Promise<string> | null = null;
  const refreshUrl = async (): Promise<string> => {
    if (!opts.reResolve) throw new HttpError(403, "link expired and no reResolve");
    if (!refreshing) {
      refreshing = Promise.resolve()
        .then(() => opts.reResolve!())
        .then(
          (u) => {
            currentUrl = u;
            refreshing = null;
            return u;
          },
          (e) => {
            refreshing = null;
            throw e;
          },
        );
    }
    return refreshing;
  };

  const requestHeaders = (range?: string): Record<string, string> => ({
    "User-Agent": USER_AGENT,
    "Accept-Encoding": "identity",
    ...(range ? { Range: range } : {}),
  });

  async function probe(): Promise<ProbeResult> {
    const res = await doFetch(currentUrl, {
      headers: requestHeaders("bytes=0-0"),
      signal: combined.signal,
    });
    try {
      if (res.status === 206) {
        return {
          totalBytes: parseContentRangeTotal(res.headers.get("content-range")),
          acceptRanges: true,
          etag: res.headers.get("etag") ?? undefined,
          lastModified: res.headers.get("last-modified") ?? undefined,
        };
      }
      if (res.status === 200) {
        const len = res.headers.get("content-length");
        return {
          totalBytes: len ? Number(len) : undefined,
          acceptRanges: false,
          etag: res.headers.get("etag") ?? undefined,
          lastModified: res.headers.get("last-modified") ?? undefined,
        };
      }
      throw new HttpError(res.status, `probe failed: HTTP ${res.status}`);
    } finally {
      await drain(res);
    }
  }

  async function probeWithRefresh(): Promise<ProbeResult> {
    try {
      return await probe();
    } catch (e) {
      if (e instanceof HttpError && EXPIRY_STATUS.has(e.status) && opts.reResolve) {
        await refreshUrl();
        return await probe();
      }
      throw e;
    }
  }

  const meta = await probeWithRefresh();
  const canSegment =
    meta.acceptRanges && meta.totalBytes !== undefined && meta.totalBytes > 0;

  try {
    return canSegment ? await segmented(meta.totalBytes!, meta) : await singleStream(meta);
  } finally {
    opts.signal?.removeEventListener("abort", propagate);
  }

  // -- segmented (multi-connection) path ------------------------------------
  async function segmented(total: number, probeMeta: ProbeResult): Promise<DownloadResult> {
    const chunks = planChunks(total, chunkSize);
    const completed = new Set<number>();

    const existing = await readSidecar(part);
    const resumable =
      !!existing &&
      sidecarMatches(existing, probeMeta, chunkSize) &&
      (await pathExists(part));
    if (resumable && existing) {
      for (const i of existing.completedChunks) {
        if (i >= 0 && i < chunks.length) completed.add(i);
      }
    } else {
      await fs.rm(part, { force: true });
      await fs.rm(sidecarPath(part), { force: true });
    }

    const fh = await fs.open(part, resumable ? "r+" : "w+");
    try {
      await fh.truncate(total); // pre-allocate so workers can pwrite at any offset

    const sidecar: Sidecar = {
      version: 1,
      totalBytes: total,
      chunkSize,
      etag: probeMeta.etag,
      lastModified: probeMeta.lastModified,
      completedChunks: [...completed],
    };
    const persist = serializeWrites();
    const persistSidecar = (): Promise<void> =>
      persist(async () => {
        sidecar.completedChunks = [...completed];
        await writeSidecar(part, sidecar);
      });

    // Progress accounting: committed (finished chunks) + live (in-flight bytes,
    // rolled back on retry so a re-requested range never double-counts).
    let committed = [...completed].reduce(
      (sum, i) => sum + (chunks[i] ? chunkLength(chunks[i]!) : 0),
      0,
    );
    let live = 0;
    let activeConns = 0;
    const meter = new SpeedMeter();
    const received = (): number => committed + live;
    const timer = setInterval(() => {
      const r = received();
      const speed = meter.sample(r);
      opts.onProgress?.({
        receivedBytes: r,
        totalBytes: total,
        speedBps: speed,
        etaSeconds: meter.eta(r, total),
        connections: activeConns,
        done: false,
      });
    }, progressMs);
    timer.unref?.();

    const pending = chunks.map((c) => c.index).filter((i) => !completed.has(i));
    let cursor = 0;
    const claim = (): number | undefined =>
      cursor < pending.length ? pending[cursor++] : undefined;
    let fatal: unknown = null;

    type Attempt =
      | { kind: "done" }
      | { kind: "retry"; delayMs?: number; error: Error }
      | { kind: "expired"; error: Error };

    const attemptChunk = async (c: Chunk): Promise<Attempt> => {
      let attemptBytes = 0;
      let res: Response;
      try {
        res = await doFetch(currentUrl, {
          headers: requestHeaders(`bytes=${c.start}-${c.end}`),
          signal: combined.signal,
        });
      } catch (e) {
        if (aborted() || isAbortError(e)) throw new DownloadCanceledError();
        return { kind: "retry", error: e instanceof Error ? e : new Error(String(e)) };
      }

      if (EXPIRY_STATUS.has(res.status)) {
        await drain(res);
        return { kind: "expired", error: new HttpError(res.status, "link expired") };
      }
      // A 200 to a Range request means the server ignored it; we can't mix that
      // with sibling ranges without corrupting the file.
      if (res.status === 200 && chunks.length > 1) {
        await drain(res);
        throw new HttpError(200, "server ignored Range on a multi-chunk download");
      }
      if (res.status !== 206 && res.status !== 200) {
        await drain(res);
        const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
        if (RETRY_STATUS.has(res.status)) {
          return {
            kind: "retry",
            delayMs: retryAfter,
            error: new HttpError(res.status, `chunk ${c.index}: HTTP ${res.status}`),
          };
        }
        throw new HttpError(res.status, `chunk ${c.index}: HTTP ${res.status}`);
      }

      const reader = res.body?.getReader();
      let pos = c.start;
      try {
        while (reader) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.byteLength) {
            await fh.write(value, 0, value.byteLength, pos);
            pos += value.byteLength;
            attemptBytes += value.byteLength;
            live += value.byteLength;
          }
          if (aborted()) {
            await reader.cancel().catch(() => {});
            throw new DownloadCanceledError();
          }
        }
      } catch (e) {
        live -= attemptBytes;
        await reader?.cancel().catch(() => {});
        if (aborted() || e instanceof DownloadCanceledError || isAbortError(e)) {
          throw new DownloadCanceledError();
        }
        return { kind: "retry", error: e instanceof Error ? e : new Error(String(e)) };
      }

      const expected = chunkLength(c);
      if (pos - c.start !== expected) {
        live -= attemptBytes;
        return { kind: "retry", error: new Error(`chunk ${c.index} incomplete`) };
      }
      live -= attemptBytes;
      committed += expected;
      return { kind: "done" };
    };

    const downloadChunk = async (c: Chunk): Promise<void> => {
      let attempt = 0;
      let reResolves = 0;
      for (;;) {
        if (aborted()) throw new DownloadCanceledError();
        activeConns++;
        let outcome: Attempt;
        try {
          outcome = await attemptChunk(c);
        } finally {
          activeConns--;
        }
        if (outcome.kind === "done") return;
        if (outcome.kind === "expired") {
          if (!opts.reResolve || reResolves >= MAX_RERESOLVES) throw outcome.error;
          reResolves++;
          await refreshUrl();
          continue;
        }
        if (attempt >= retries) throw outcome.error;
        attempt++;
        await sleep(backoffDelay(attempt, BACKOFF_BASE_MS, BACKOFF_CAP_MS, outcome.delayMs));
      }
    };

    const worker = async (): Promise<void> => {
      for (;;) {
        if (aborted() || fatal) return;
        const idx = claim();
        if (idx === undefined) return;
        const c = chunks[idx];
        if (!c) continue;
        try {
          await downloadChunk(c);
          // A4 durability: fsync this chunk's bytes to disk BEFORE recording the
          // chunk as complete in the sidecar. Otherwise a crash between
          // persistSidecar() and the final sync leaves the sidecar claiming the
          // chunk is done while its bytes are lost → silent corruption on resume.
          await fh.sync();
          completed.add(idx);
          await persistSidecar();
        } catch (e) {
          if (e instanceof DownloadCanceledError || aborted()) return;
          fatal ??= e;
          internalAbort.abort();
          return;
        }
      }
    };

    const workerCount = Math.min(maxConns, Math.max(1, pending.length));
    try {
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
    } finally {
      clearInterval(timer);
    }

    if (fatal) {
      throw fatal;
    }
    if (opts.signal?.aborted) {
      throw new DownloadCanceledError();
    }

    await fh.sync();
    const stat = await fs.stat(part);
    if (stat.size !== total) {
      throw new Error(`download size mismatch: ${stat.size} != ${total}`);
    }
    await fs.rename(part, dest);
    await fs.rm(sidecarPath(part), { force: true });
    opts.onProgress?.({
      receivedBytes: total,
      totalBytes: total,
      speedBps: 0,
      etaSeconds: 0,
      connections: 0,
      done: true,
    });
    return { path: dest, bytes: total, durationMs: Date.now() - startedAt };
    } finally {
      // A3: ensure the file descriptor is released on every exit path
      // (success, fatal, abort, size mismatch, rename failure). Previously closes
      // were scattered and skipped when fh.truncate/fh.sync rejected.
      await fh.close().catch(() => {});
    }
  }

  // -- single-stream fallback (no ranges / unknown size) --------------------
  async function singleStream(probeMeta: ProbeResult): Promise<DownloadResult> {
    await fs.rm(sidecarPath(part), { force: true });
    const fh = await fs.open(part, "w+");
    const total = probeMeta.totalBytes;
    const meter = new SpeedMeter();
    let received = 0;
    const timer = setInterval(() => {
      const speed = meter.sample(received);
      opts.onProgress?.({
        receivedBytes: received,
        totalBytes: total,
        speedBps: speed,
        etaSeconds: meter.eta(received, total),
        connections: 1,
        done: false,
      });
    }, progressMs);
    timer.unref?.();

    const fetchBody = async (): Promise<Response> => {
      let attempt = 0;
      let reResolves = 0;
      for (;;) {
        if (aborted()) throw new DownloadCanceledError();
        let res: Response;
        try {
          res = await doFetch(currentUrl, {
            headers: requestHeaders(),
            signal: combined.signal,
          });
        } catch (e) {
          if (aborted() || isAbortError(e)) throw new DownloadCanceledError();
          if (attempt >= retries) throw e;
          attempt++;
          await sleep(backoffDelay(attempt, BACKOFF_BASE_MS, BACKOFF_CAP_MS));
          continue;
        }
        if (EXPIRY_STATUS.has(res.status)) {
          await drain(res);
          if (!opts.reResolve || reResolves >= MAX_RERESOLVES) {
            throw new HttpError(res.status, "link expired");
          }
          reResolves++;
          await refreshUrl();
          continue;
        }
        if (res.status !== 200 && res.status !== 206) {
          await drain(res);
          if (RETRY_STATUS.has(res.status) && attempt < retries) {
            attempt++;
            const ra = parseRetryAfter(res.headers.get("retry-after"));
            await sleep(backoffDelay(attempt, BACKOFF_BASE_MS, BACKOFF_CAP_MS, ra));
            continue;
          }
          throw new HttpError(res.status, `download failed: HTTP ${res.status}`);
        }
        return res;
      }
    };

    try {
      let attempt = 0;
      for (;;) {
        const res = await fetchBody();
        const reader = res.body?.getReader();
        let pos = 0;
        let ok = true;
        try {
          while (reader) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.byteLength) {
              await fh.write(value, 0, value.byteLength, pos);
              pos += value.byteLength;
              received = pos;
            }
            if (aborted()) {
              await reader.cancel().catch(() => {});
              throw new DownloadCanceledError();
            }
          }
        } catch (e) {
          if (aborted() || e instanceof DownloadCanceledError || isAbortError(e)) {
            throw new DownloadCanceledError();
          }
          if (attempt >= retries) throw e;
          // No ranges → restart the whole stream from a clean slate.
          attempt++;
          await fh.truncate(0);
          received = 0;
          await sleep(backoffDelay(attempt, BACKOFF_BASE_MS, BACKOFF_CAP_MS));
          ok = false;
        }
        if (!ok) continue;
        if (total !== undefined && pos !== total) {
          if (attempt >= retries) {
            throw new Error(`download size mismatch: ${pos} != ${total}`);
          }
          attempt++;
          await fh.truncate(0);
          received = 0;
          await sleep(backoffDelay(attempt, BACKOFF_BASE_MS, BACKOFF_CAP_MS));
          continue;
        }
        await fh.sync();
        await fh.close();
        await fs.rename(part, dest);
        opts.onProgress?.({
          receivedBytes: pos,
          totalBytes: total ?? pos,
          speedBps: 0,
          etaSeconds: 0,
          connections: 0,
          done: true,
        });
        return { path: dest, bytes: pos, durationMs: Date.now() - startedAt };
      }
    } catch (e) {
      await fh.close().catch(() => {});
      if (e instanceof DownloadCanceledError || opts.signal?.aborted) {
        throw new DownloadCanceledError();
      }
      throw e;
    } finally {
      clearInterval(timer);
    }
  }
}
