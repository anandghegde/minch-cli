// Real Debrid adapter. Maps the RD REST 1.0 API onto the shared
// `DebridProvider` contract so the TUI never branches on a provider. RD differs
// from TorBox in two important ways (see download-to-real-debrid-idea.md):
//   1. Adding a magnet does NOT start the download — the torrent sits in
//      `waiting_files_selection` until `selectFiles` is called. `addMagnet`
//      therefore orchestrates add → poll → selectFiles(all) before returning.
//   2. A torrent's `links[]` are NOT direct URLs; each must be `unrestrict`ed.
//      `links` map 1:1, in order, onto the SELECTED files.

import type { Config } from "../config/config";
import { clamp01, createDebridBase, isAbort } from "./base";
import {
  DebridError,
  type AccountInfo,
  type AddOptions,
  type AddResult,
  type DebridErrorKind,
  type DebridProvider,
  type ResolvedFile,
  type Transfer,
  type TransferFile,
  type TransferStatus,
} from "./types";

const BASE = "https://api.real-debrid.com/rest/1.0";
// Magnet → metadata conversion is usually quick but can lag; poll conservatively
// (one request/second) and give up after a bounded window rather than spinning.
const POLL_DELAY_MS = 1_000;
const POLL_MAX_ATTEMPTS = 60;
// How many transfers to surface on the Transfers screen (RD paginates, newest
// first). Generous enough to show active + recently finished without paging.
const LIST_LIMIT = 100;

/** RD error envelope on a non-2xx response. */
interface RawError {
  error?: string;
  error_code?: number;
}

interface RawFile {
  id?: number | string;
  path?: string;
  bytes?: number;
  /** 1 when the file is part of the selected set, 0 otherwise. */
  selected?: number;
}

interface RawTorrent {
  id?: number | string;
  filename?: string;
  original_filename?: string;
  hash?: string;
  bytes?: number;
  /** 0..100 — divide by 100 for the normalized model. */
  progress?: number;
  status?: string;
  added?: string;
  /** Bytes/sec while downloading; absent otherwise. */
  speed?: number;
  seeders?: number;
  files?: RawFile[];
  links?: string[];
  ended?: string;
}

interface RawAdd {
  id?: number | string;
  uri?: string;
}

interface RawUnrestrict {
  id?: string;
  filename?: string;
  filesize?: number;
  host?: string;
  chunks?: number;
  download?: string;
  streamable?: number;
}

interface RawUser {
  id?: number;
  username?: string;
  email?: string;
  points?: number;
  /** "premium" | "free". */
  type?: string;
  /** Seconds of premium remaining. */
  premium?: number;
  expiration?: string;
}

// Numeric `error_code` is more reliable than the message string. Map only the
// codes we care about; anything unmapped falls back to the HTTP status.
const ERROR_CODE_KIND: Record<number, DebridErrorKind> = {
  [-1]: "transient",
  5: "quota", // slow down
  6: "transient",
  8: "auth", // bad token
  9: "auth", // permission denied
  16: "validation", // unsupported hoster
  21: "quota", // too many active downloads
  23: "quota", // traffic exhausted
  25: "transient",
  30: "validation", // torrent file invalid
  34: "quota", // too many requests
  35: "validation", // infringing file
  36: "quota", // fair-usage limit
};

const ERROR_CODE_MESSAGE: Record<number, string> = {
  8: "Real Debrid token is invalid — re-enter it in Accounts.",
  9: "Real Debrid denied this action (premium required?).",
  16: "Real Debrid does not support this hoster.",
  21: "Too many active Real Debrid downloads — try again shortly.",
  23: "Real Debrid traffic limit exhausted.",
  30: "Real Debrid could not read this torrent file.",
  34: "Real Debrid rate limit hit — backing off.",
  35: "Real Debrid rejected this as an infringing file.",
  36: "Real Debrid fair-usage limit reached.",
};

/** Map an RD torrent `status` onto the normalized transfer status. */
export function mapStatus(status: string | undefined): TransferStatus {
  switch ((status ?? "").toLowerCase()) {
    case "downloaded":
      return "done";
    case "downloading":
    case "compressing":
    case "uploading":
      return "downloading";
    case "queued":
    case "magnet_conversion":
      return "queued";
    case "waiting_files_selection":
      return "needs_selection";
    case "error":
    case "virus":
    case "dead":
    case "magnet_error":
      return "error";
    default:
      return "queued";
  }
}

function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : p;
}

function kindForStatus(status: number): DebridErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "quota";
  if (status === 400 || status === 422) return "validation";
  if (status >= 500) return "transient";
  return "unknown";
}

/** Normalize an RD torrent (list row or `/info`) onto the shared model. */
export function mapTransfer(raw: RawTorrent): Transfer {
  const status = mapStatus(raw.status);
  const sizeBytes = typeof raw.bytes === "number" ? raw.bytes : 0;
  const progress = clamp01((typeof raw.progress === "number" ? raw.progress : 0) / 100);
  const speed = typeof raw.speed === "number" && raw.speed > 0 ? raw.speed : undefined;
  // RD has no ETA field; derive one while downloading from remaining/speed.
  let etaSeconds: number | undefined;
  if (status === "downloading" && speed && sizeBytes > 0) {
    const remaining = sizeBytes * (1 - progress);
    etaSeconds = remaining > 0 ? Math.round(remaining / speed) : undefined;
  }
  const files: TransferFile[] = (raw.files ?? []).map((f) => ({
    id: String(f.id ?? ""),
    name: basename(f.path ?? ""),
    sizeBytes: typeof f.bytes === "number" ? f.bytes : 0,
    selected: f.selected === 1,
  }));
  const addedMs = raw.added ? Date.parse(raw.added) : NaN;
  return {
    provider: "realdebrid",
    id: String(raw.id ?? ""),
    name: raw.filename || raw.original_filename || "Untitled",
    sizeBytes,
    progress,
    status,
    downloadSpeedBps: speed,
    etaSeconds,
    files,
    hash: raw.hash || undefined,
    addedAt: Number.isFinite(addedMs) ? Math.floor(addedMs / 1000) : undefined,
  };
}

export interface RealDebridDeps {
  /** Injectable delay between metadata polls (defaults to real setTimeout). */
  sleep?: (ms: number) => Promise<void>;
}

const URLENCODED = { "Content-Type": "application/x-www-form-urlencoded" };

export function createRealDebrid(
  config: Config,
  deps: RealDebridDeps = {},
): DebridProvider {
  const base = createDebridBase(config, {
    provider: "realdebrid",
    label: "Real Debrid",
    baseUrl: BASE,
    noKeyMessage: "No Real Debrid token configured.",
    kindForStatus,
  });
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const requireToken = base.requireKey;

  /** Build a DebridError from a parsed RD error body (prefers `error_code`). */
  function errorFromBody(
    status: number,
    body: RawError | undefined,
    headers: Headers | undefined,
  ): DebridError {
    const code = typeof body?.error_code === "number" ? body.error_code : undefined;
    const kind = code !== undefined ? ERROR_CODE_KIND[code] : undefined;
    const message =
      (code !== undefined && ERROR_CODE_MESSAGE[code]) ||
      (typeof body?.error === "string" && body.error) ||
      `Real Debrid request failed (HTTP ${status}).`;
    return base.errorForStatus(status, message, { kind, headers });
  }

  /** Issue a request and parse the JSON body, throwing a DebridError on !ok. */
  async function request<T>(
    token: string,
    path: string,
    init: RequestInit & { signal?: AbortSignal; retries?: number } = {},
  ): Promise<T> {
    const res = await base.call(token, path, init);
    const body = await base.readJson<RawError>(res);
    if (!res.ok) {
      throw errorFromBody(res.status, body, res.headers);
    }
    return body as T;
  }

  function getUser(token: string, signal?: AbortSignal): Promise<RawUser> {
    return request<RawUser>(token, "/user", { signal, retries: 1 });
  }

  function getInfo(token: string, id: string, signal?: AbortSignal): Promise<RawTorrent> {
    return request<RawTorrent>(token, `/torrents/info/${encodeURIComponent(id)}`, {
      signal,
      retries: 1,
    });
  }

  /** RD torrent features require premium; refuse the hand-off early otherwise. */
  async function ensurePremium(token: string, signal?: AbortSignal): Promise<void> {
    const user = await getUser(token, signal);
    if (user.type !== "premium") {
      throw new DebridError(
        "validation",
        "Real Debrid torrent features require a premium account.",
        { provider: "realdebrid" },
      );
    }
  }

  /** Poll `/info` until the magnet has been converted and files are listed. */
  async function waitForFiles(
    token: string,
    id: string,
    signal?: AbortSignal,
  ): Promise<RawTorrent> {
    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      if (isAbort(signal)) {
        throw new DebridError("transient", "Aborted.", { provider: "realdebrid" });
      }
      const info = await getInfo(token, id, signal);
      const status = (info.status ?? "").toLowerCase();
      if (
        status === "magnet_error" ||
        status === "error" ||
        status === "virus" ||
        status === "dead"
      ) {
        throw new DebridError(
          "validation",
          `Real Debrid could not process this magnet (${info.status}).`,
          { provider: "realdebrid" },
        );
      }
      if (status !== "magnet_conversion" && (info.files?.length ?? 0) > 0) {
        return info;
      }
      await sleep(POLL_DELAY_MS);
    }
    throw new DebridError(
      "transient",
      "Timed out waiting for Real Debrid to fetch torrent metadata.",
      { provider: "realdebrid" },
    );
  }

  /** Select files on a torrent (defaults to every file). REQUIRED after add. */
  async function selectFiles(
    token: string,
    id: string,
    files: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await request<void>(token, `/torrents/selectFiles/${encodeURIComponent(id)}`, {
      method: "POST",
      body: new URLSearchParams({ files }).toString(),
      headers: URLENCODED,
      signal,
      retries: 0,
    });
  }

  /** Shared add → poll → selectFiles orchestration for magnets and files. */
  async function finishAdd(
    token: string,
    added: RawAdd,
    signal: AbortSignal | undefined,
  ): Promise<AddResult> {
    const id = added.id != null && added.id !== "" ? String(added.id) : "";
    if (!id) {
      throw new DebridError("validation", "Real Debrid did not return a torrent id.", {
        provider: "realdebrid",
      });
    }
    await waitForFiles(token, id, signal);
    // Default to selecting every file so it "just downloads". A future pick-files
    // UI can thread an explicit id list through here instead of "all".
    await selectFiles(token, id, "all", signal);
    return { id };
  }

  const provider: DebridProvider = {
    id: "realdebrid",
    label: "Real Debrid",

    isConfigured: base.isConfigured,

    async checkAuth(signal): Promise<AccountInfo> {
      const token = requireToken();
      const user = await getUser(token, signal);
      const premium = user.type === "premium";
      return { email: user.email, plan: premium ? "Premium" : "Free", premium };
    },

    async addMagnet(magnet, opts): Promise<AddResult> {
      const token = requireToken();
      await ensurePremium(token, opts?.signal);
      const added = await request<RawAdd>(token, "/torrents/addMagnet", {
        method: "POST",
        body: new URLSearchParams({ magnet }).toString(),
        headers: URLENCODED,
        signal: opts?.signal,
        retries: 0, // adds are non-idempotent; never auto-retry.
      });
      return finishAdd(token, added, opts?.signal);
    },

    async addTorrentFile(data, _name, opts): Promise<AddResult> {
      const token = requireToken();
      await ensurePremium(token, opts?.signal);
      const added = await request<RawAdd>(token, "/torrents/addTorrent", {
        method: "PUT",
        body: data,
        headers: { "Content-Type": "application/x-bittorrent" },
        signal: opts?.signal,
        retries: 0,
      });
      return finishAdd(token, added, opts?.signal);
    },

    async listTransfers(signal): Promise<Transfer[]> {
      const token = requireToken();
      const rows = await request<RawTorrent[]>(token, `/torrents?limit=${LIST_LIMIT}`, {
        signal,
      });
      return (Array.isArray(rows) ? rows : []).map(mapTransfer);
    },

    async getTransfer(id, signal): Promise<Transfer> {
      const token = requireToken();
      return mapTransfer(await getInfo(token, id, signal));
    },

    async remove(id, signal): Promise<void> {
      const token = requireToken();
      await request<void>(token, `/torrents/delete/${encodeURIComponent(id)}`, {
        method: "DELETE",
        signal,
        retries: 0,
      });
    },

    async resolveFileUrl(transferId, fileId, signal): Promise<ResolvedFile> {
      const token = requireToken();
      const info = await getInfo(token, transferId, signal);
      // `links` map 1:1, in order, onto the SELECTED files only.
      const selected = (info.files ?? []).filter((f) => f.selected === 1);
      const links = info.links ?? [];
      const idx = selected.findIndex((f) => String(f.id ?? "") === String(fileId));
      if (idx === -1) {
        throw new DebridError(
          "validation",
          `File ${fileId} is not a selected file of this transfer.`,
          { provider: "realdebrid" },
        );
      }
      const link = links[idx];
      if (!link) {
        throw new DebridError(
          "transient",
          "Real Debrid has no download link for this file yet.",
          { provider: "realdebrid" },
        );
      }
      const data = await request<RawUnrestrict>(token, "/unrestrict/link", {
        method: "POST",
        body: new URLSearchParams({ link }).toString(),
        headers: URLENCODED,
        signal,
        retries: 1,
      });
      if (!data.download) {
        throw new DebridError("validation", "Real Debrid returned no direct download URL.", {
          provider: "realdebrid",
        });
      }
      return {
        url: data.download,
        filename: data.filename || basename(data.download),
        sizeBytes: typeof data.filesize === "number" ? data.filesize : undefined,
      };
    },
  };

  return provider;
}
