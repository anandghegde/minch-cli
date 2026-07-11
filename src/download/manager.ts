// Tracks many concurrent local downloads on top of the segmented accelerator.
// Owns destination naming + the re-resolve wiring back into a provider, exposes
// immutable snapshots to the TUI via a subscribe()/list() pair (no React here),
// and caps global parallelism so "download all" can't open dozens of sockets.

import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import type { Config } from "../config/config";
import type { DebridId, DebridProvider, Transfer, TransferFile } from "../debrid/types";
import {
  downloadFile,
  resolveCollision,
  DownloadCanceledError,
  type DownloadProgress,
  type FetchImpl,
} from "./accelerator";

export type DownloadStatus = "queued" | "active" | "done" | "error" | "canceled";

export interface DownloadEntry {
  /** Stable key: provider:transferId:fileId (also the dedupe key). */
  id: string;
  provider: DebridId;
  transferId: string;
  fileId: string;
  /** Display filename (resolved once the destination is known). */
  name: string;
  /** Final destination path (set once resolved). */
  dest?: string;
  status: DownloadStatus;
  progress: DownloadProgress;
  /** Final path on success. */
  path?: string;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

export interface StartDownloadInput {
  provider: DebridProvider;
  transfer: Transfer;
  file: TransferFile;
  /** Destination directory (see resolveDownloadDir). */
  dir: string;
  connections?: number;
  /** Injectable fetch (tests). */
  fetchImpl?: FetchImpl;
}

const DEFAULT_MAX_CONCURRENT = 3;

function emptyProgress(): DownloadProgress {
  return { receivedBytes: 0, speedBps: 0, connections: 0, done: false };
}

/** Resolve the destination directory: config override → ~/Downloads → cwd. */
export function resolveDownloadDir(config: Config): string {
  const configured = config.debrid?.downloadDir?.trim();
  if (configured) return configured;
  const downloads = path.join(os.homedir(), "Downloads");
  return existsSync(downloads) ? downloads : process.cwd();
}

export class DownloadManager {
  private readonly entries = new Map<string, DownloadEntry>();
  private readonly controllers = new Map<string, AbortController>();
  // Input captured per-entry so a queued download always runs against its own
  // provider/transfer/file/dir — never the input of whichever download freed
  // the concurrency slot (the original pump(input) thread-through bug).
  private readonly inputs = new Map<string, StartDownloadInput>();
  private readonly listeners = new Set<() => void>();
  private readonly queue: string[] = [];
  // Owns a final destination and its derived .part/.part.json artifacts while
  // an entry is queued or active. This prevents two transfers from writing the
  // same resumable part file after a check-then-use race.
  private readonly reservedDestinations = new Set<string>();
  private running = 0;

  constructor(private readonly maxConcurrent = DEFAULT_MAX_CONCURRENT) {}

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const cb of this.listeners) cb();
  }

  /** Newest-first snapshot for rendering. */
  list(): DownloadEntry[] {
    return [...this.entries.values()]
      .map((e) => ({ ...e, progress: { ...e.progress } }))
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  get(id: string): DownloadEntry | undefined {
    const e = this.entries.get(id);
    return e ? { ...e, progress: { ...e.progress } } : undefined;
  }

  /** True if a download for this transfer (optionally a specific file) is live. */
  isActive(transferId: string, fileId?: string): boolean {
    for (const e of this.entries.values()) {
      if (e.transferId !== transferId) continue;
      if (fileId !== undefined && e.fileId !== fileId) continue;
      if (e.status === "active" || e.status === "queued") return true;
    }
    return false;
  }

  /** The most recent completed download for a transfer (for the "open" key). */
  latestDone(transferId: string, fileId?: string): DownloadEntry | undefined {
    let best: DownloadEntry | undefined;
    for (const e of this.entries.values()) {
      if (e.transferId !== transferId) continue;
      if (fileId !== undefined && e.fileId !== fileId) continue;
      if (e.status === "done" && (!best || e.startedAt > best.startedAt)) best = e;
    }
    return best ? { ...best, progress: { ...best.progress } } : undefined;
  }

  /** Begin (or no-op if already live) a download. Returns its id. */
  start(input: StartDownloadInput): string {
    const id = `${input.provider.id}:${input.transfer.id}:${input.file.id}`;
    const existing = this.entries.get(id);
    if (existing && (existing.status === "active" || existing.status === "queued")) {
      return id;
    }

    const ctrl = new AbortController();
    this.controllers.set(id, ctrl);
    this.inputs.set(id, input);
    this.entries.set(id, {
      id,
      provider: input.provider.id,
      transferId: input.transfer.id,
      fileId: input.file.id,
      name: input.file.name,
      status: "queued",
      progress: emptyProgress(),
      startedAt: Date.now(),
    });
    this.queue.push(id);
    this.emit();
    this.pump();
    return id;
  }

  cancel(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.controllers.get(id)?.abort();
    // A still-queued download will never enter run(); mark it canceled now.
    if (entry.status === "queued") {
      const i = this.queue.indexOf(id);
      if (i !== -1) this.queue.splice(i, 1);
      entry.status = "canceled";
      entry.finishedAt = Date.now();
      this.controllers.delete(id);
      this.inputs.delete(id);
      this.emit();
    }
  }

  /** Drop a finished entry from the list (UI dismissal). */
  dismiss(id: string): void {
    const entry = this.entries.get(id);
    if (entry && entry.status !== "active" && entry.status !== "queued") {
      this.entries.delete(id);
      this.emit();
    }
  }

  private pump(): void {
    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      const id = this.queue.shift()!;
      const entry = this.entries.get(id);
      if (!entry || entry.status !== "queued") continue;
      const input = this.inputs.get(id);
      if (!input) continue;
      this.running++;
      void this.run(id, input).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private reserveDestination(dir: string, name: string): Promise<string> {
    return resolveCollision(dir, name, (candidate) => {
      if (this.reservedDestinations.has(candidate)) return false;
      this.reservedDestinations.add(candidate);
      return true;
    });
  }

  private async run(id: string, input: StartDownloadInput): Promise<void> {
    const entry = this.entries.get(id);
    const ctrl = this.controllers.get(id);
    if (!entry || !ctrl) return;
    if (ctrl.signal.aborted) {
      entry.status = "canceled";
      entry.finishedAt = Date.now();
      this.emit();
      return;
    }

    entry.status = "active";
    this.emit();

    try {
      const resolved = await input.provider.resolveFileUrl(
        input.transfer.id,
        input.file.id,
        ctrl.signal,
      );
      const dest = await this.reserveDestination(
        input.dir,
        resolved.filename || input.file.name,
      );
      entry.dest = dest;
      entry.name = path.basename(dest);
      this.emit();

      const result = await downloadFile(resolved.url, dest, {
        connections: input.connections,
        signal: ctrl.signal,
        fetchImpl: input.fetchImpl,
        reResolve: async (signal) =>
          (await input.provider.resolveFileUrl(input.transfer.id, input.file.id, signal)).url,
        onProgress: (p) => {
          entry.progress = p;
          this.emit();
        },
      });

      entry.status = "done";
      entry.path = result.path;
      entry.finishedAt = Date.now();
      entry.progress = {
        receivedBytes: result.bytes,
        totalBytes: result.bytes,
        speedBps: 0,
        etaSeconds: 0,
        connections: 0,
        done: true,
      };
    } catch (e) {
      if (e instanceof DownloadCanceledError || ctrl.signal.aborted) {
        entry.status = "canceled";
      } else {
        entry.status = "error";
        entry.error = e instanceof Error ? e.message : String(e);
      }
      entry.finishedAt = Date.now();
    } finally {
      if (entry.dest) this.reservedDestinations.delete(entry.dest);
      this.controllers.delete(id);
      this.inputs.delete(id);
      this.emit();
    }
  }
}
