// TorBox adapter. Maps the TorBox v1 API onto the shared `DebridProvider`
// contract so the TUI never branches on a provider. Verified against the
// `minch` Swift client's endpoint/field usage (see download-to-torbox-idea.md).

import { infoHashFromMagnet } from "../sources/magnet";
import type { Config } from "../config/config";
import { clamp01, createDebridBase } from "./base";
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

// The trailing `/api` is part of the base; paths are appended to it.
const BASE = "https://api.torbox.app/v1/api";
const WEBDL_PREFIX = "webdl:";

/** Every TorBox response is wrapped in this envelope; fields are snake_case. */
interface Envelope<T> {
  success?: boolean;
  detail?: string;
  error?: string | null;
  data?: T;
}

interface RawFile {
  id?: number | string;
  name?: string;
  short_name?: string;
  size?: number;
  mimetype?: string;
}

interface RawTransfer {
  id?: number | string;
  hash?: string;
  name?: string;
  size?: number;
  /** Already 0..1 from TorBox. */
  progress?: number;
  download_state?: string;
  download_speed?: number;
  eta?: number;
  files?: RawFile[];
  created_at?: string;
}

interface AddData {
  torrent_id?: number | string | null;
  hash?: string | null;
  queued_id?: number | string | null;
}

interface RawUser {
  email?: string;
  plan?: number | string;
  is_subscribed?: boolean;
}

const TORBOX_PLANS: Record<string, string> = {
  "0": "Free",
  "1": "Essential",
  "2": "Pro",
  "3": "Standard",
};

/** Map TorBox `download_state` onto the normalized transfer status. */
export function mapDownloadState(state: string | undefined): TransferStatus {
  const s = (state ?? "").toLowerCase();
  if (s === "downloading" || s === "metadl" || s === "downloadingmetadata")
    return "downloading";
  if (s === "uploading" || s === "seeding") return "seeding";
  if (s === "completed" || s === "cached" || s === "downloaded" || s === "finished")
    return "done";
  if (s === "paused") return "queued";
  if (s === "error" || s === "failed" || s === "missingfiles") return "error";
  return "queued";
}

/** Statuses that mean the transfer is still progressing (poll faster, bypass cache). */
function isActiveStatus(status: TransferStatus): boolean {
  return (
    status === "queued" ||
    status === "downloading" ||
    status === "seeding" ||
    status === "needs_selection"
  );
}

function kindForStatus(status: number): DebridErrorKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 402 || status === 429) return "quota";
  if (status === 400 || status === 422) return "validation";
  if (status >= 500) return "transient";
  return "unknown";
}

function messageFrom(env: Envelope<unknown> | undefined, fallback: string): string {
  const m = env?.detail || env?.error;
  return m ? String(m) : fallback;
}

function mapTransfer(raw: RawTransfer, web: boolean): Transfer {
  const rawId = String(raw.id ?? "");
  const files: TransferFile[] = (raw.files ?? []).map((f) => ({
    id: String(f.id ?? ""),
    name: f.short_name || f.name || "",
    sizeBytes: typeof f.size === "number" ? f.size : 0,
    selected: true,
  }));
  const addedMs = raw.created_at ? Date.parse(raw.created_at) : NaN;
  return {
    provider: "torbox",
    id: web ? `${WEBDL_PREFIX}${rawId}` : rawId,
    name: raw.name || "Untitled",
    sizeBytes: typeof raw.size === "number" ? raw.size : 0,
    progress: clamp01(raw.progress),
    status: mapDownloadState(raw.download_state),
    downloadSpeedBps:
      typeof raw.download_speed === "number" ? raw.download_speed : undefined,
    etaSeconds: typeof raw.eta === "number" ? raw.eta : undefined,
    files,
    hash: raw.hash || undefined,
    addedAt: Number.isFinite(addedMs) ? Math.floor(addedMs / 1000) : undefined,
  };
}

/** Interpret a createtorrent / createwebdownload response into an AddResult. */
export function interpretAdd(env: Envelope<AddData>): AddResult {
  const data = env.data ?? {};
  const id =
    data.torrent_id != null && data.torrent_id !== ""
      ? String(data.torrent_id)
      : undefined;
  const queuedId =
    data.queued_id != null && data.queued_id !== ""
      ? String(data.queued_id)
      : undefined;
  const detail = env.detail || env.error || undefined;
  // torrent_id == null && queued_id == null ⇒ failure (even if success was true).
  if (!id && !queuedId) {
    throw new DebridError(
      "validation",
      detail ? String(detail) : "TorBox did not accept this torrent.",
      { provider: "torbox" },
    );
  }
  return {
    id,
    queuedId,
    hash: data.hash ? String(data.hash) : undefined,
    detail: detail ? String(detail) : undefined,
    alreadyPresent: detail ? /already|found cached/i.test(String(detail)) : false,
  };
}

/** Build the `hash` CSV for a checkcached request, deriving each BTIH client-side. */
export function cacheCheckHashes(magnetsOrHashes: string[]): string[] {
  const out: string[] = [];
  for (const item of magnetsOrHashes) {
    const v = item.trim();
    if (!v) continue;
    const hash = v.startsWith("magnet:") ? infoHashFromMagnet(v) : v.toLowerCase();
    if (hash && !out.includes(hash)) out.push(hash);
  }
  return out;
}

function filenameFromUrl(url: string): string {
  try {
    const path = new URL(url).pathname;
    const last = path.split("/").filter(Boolean).pop() ?? "";
    return decodeURIComponent(last) || "download";
  } catch {
    return "download";
  }
}

// Tracks, per key, whether the last poll saw an active transfer. Persists across
// provider rebuilds so `?bypass_cache=true` is only sent while something runs.
const activeByKey = new Map<string, boolean>();

export function createTorbox(config: Config): DebridProvider {
  const base = createDebridBase(config, {
    provider: "torbox",
    label: "TorBox",
    baseUrl: BASE,
    noKeyMessage: "No TorBox key configured.",
    kindForStatus,
  });
  const requireKey = base.requireKey;

  async function readEnvelope<T>(
    res: Response,
    opts: { allowFailure?: boolean } = {},
  ): Promise<Envelope<T>> {
    const env = (await base.readJson<Envelope<T>>(res)) ?? {};
    if (!res.ok) {
      throw base.errorForStatus(
        res.status,
        messageFrom(env, `TorBox request failed (HTTP ${res.status}).`),
        { headers: res.headers },
      );
    }
    // The envelope can report failure even on HTTP 200; treat it as an error
    // unless the caller wants to inspect the body itself (e.g. add flows).
    if (!opts.allowFailure && env.success === false) {
      const kind = kindForStatus(res.status);
      throw new DebridError(
        kind === "unknown" ? "validation" : kind,
        messageFrom(env, "TorBox reported an error."),
        { provider: "torbox", status: res.status },
      );
    }
    return env;
  }

  async function addMultipart(
    path: string,
    build: (form: FormData) => void,
    opts: AddOptions | undefined,
  ): Promise<AddResult> {
    const key = requireKey();
    const form = new FormData();
    build(form);
    if (opts?.name) form.append("name", opts.name);
    if (opts?.cacheOnly) form.append("as_queued", "false");
    const res = await base.call(key, path, {
      method: "POST",
      body: form,
      signal: opts?.signal,
      retries: 0, // adds are non-idempotent; never auto-retry.
    });
    const env = await readEnvelope<AddData>(res, { allowFailure: true });
    return interpretAdd(env);
  }

  async function fetchList(
    key: string,
    path: string,
    web: boolean,
    signal: AbortSignal | undefined,
  ): Promise<Transfer[]> {
    const res = await base.call(key, path, { signal });
    const env = await readEnvelope<RawTransfer[] | RawTransfer>(res);
    const data = env.data;
    const rows = Array.isArray(data) ? data : data ? [data] : [];
    return rows.map((r) => mapTransfer(r, web));
  }

  const provider: DebridProvider = {
    id: "torbox",
    label: "TorBox",

    isConfigured: base.isConfigured,

    async checkAuth(signal): Promise<AccountInfo> {
      const key = requireKey();
      const res = await base.call(key, "/user/me", { signal, retries: 1 });
      const env = await readEnvelope<RawUser>(res);
      const u = env.data ?? {};
      const planKey = u.plan != null ? String(u.plan) : undefined;
      return {
        email: u.email,
        plan: planKey ? (TORBOX_PLANS[planKey] ?? `Plan ${planKey}`) : undefined,
        premium: planKey ? planKey !== "0" : undefined,
      };
    },

    addMagnet(magnet, opts): Promise<AddResult> {
      return addMultipart(
        "/torrents/createtorrent",
        (form) => form.append("magnet", magnet),
        opts,
      );
    },

    addTorrentFile(data, name, opts): Promise<AddResult> {
      const filename = name.toLowerCase().endsWith(".torrent")
        ? name
        : `${name}.torrent`;
      return addMultipart(
        "/torrents/createtorrent",
        (form) =>
          form.append(
            "file",
            new Blob([data], { type: "application/x-bittorrent" }),
            filename,
          ),
        opts,
      );
    },

    async listTransfers(signal): Promise<Transfer[]> {
      const key = requireKey();
      const bypass = activeByKey.get(key) === true;
      const torrentsPath = `/torrents/mylist${bypass ? "?bypass_cache=true" : ""}`;
      // Torrents are the primary list; a webdl failure (e.g. plan without web
      // downloads) must never blank the screen, so settle them independently.
      const [torrents, webdls] = await Promise.allSettled([
        fetchList(key, torrentsPath, false, signal),
        fetchList(key, "/webdl/mylist", true, signal),
      ]);
      if (torrents.status === "rejected") throw torrents.reason;
      const out = [...torrents.value];
      if (webdls.status === "fulfilled") out.push(...webdls.value);
      activeByKey.set(key, out.some((t) => isActiveStatus(t.status)));
      return out;
    },

    async getTransfer(id, signal): Promise<Transfer> {
      const all = await provider.listTransfers(signal);
      const found = all.find((t) => t.id === id);
      if (!found) {
        throw new DebridError("validation", `Transfer ${id} not found.`, {
          provider: "torbox",
        });
      }
      return found;
    },

    async remove(id, signal): Promise<void> {
      const key = requireKey();
      if (id.startsWith(WEBDL_PREFIX)) {
        const form = new FormData();
        form.append("web_id", id.slice(WEBDL_PREFIX.length));
        form.append("operation", "delete");
        const res = await base.call(key, "/webdl/controlwebdownload", {
          method: "POST",
          body: form,
          signal,
          retries: 0,
        });
        await readEnvelope(res);
        return;
      }
      const res = await base.call(key, "/torrents/controltorrent", {
        method: "POST",
        body: JSON.stringify({ torrent_id: Number(id), operation: "delete" }),
        headers: { "Content-Type": "application/json" },
        signal,
        retries: 0,
      });
      await readEnvelope(res);
    },

    async checkCached(magnetsOrHashes, signal): Promise<Record<string, boolean>> {
      const key = requireKey();
      const hashes = cacheCheckHashes(magnetsOrHashes);
      const out: Record<string, boolean> = {};
      for (const h of hashes) out[h] = false;
      if (hashes.length === 0) return out;
      const params = new URLSearchParams({
        hash: hashes.join(","),
        format: "object",
        list_files: "false",
      });
      const res = await base.call(key, `/torrents/checkcached?${params.toString()}`, { signal });
      const env = await readEnvelope<Record<string, unknown> | false | null>(res);
      // `data` is a hash-keyed object (present ⇒ cached) or false/null per hash.
      if (env.data && typeof env.data === "object") {
        for (const h of Object.keys(env.data)) out[h.toLowerCase()] = true;
      }
      return out;
    },

    async resolveFileUrl(transferId, fileId, signal): Promise<ResolvedFile> {
      const key = requireKey();
      // A normalized file id may be stored composite (`<transferId>:<fileId>`);
      // TorBox only wants the raw numeric file id.
      const rawFile = fileId.includes(":") ? fileId.slice(fileId.lastIndexOf(":") + 1) : fileId;
      const web = transferId.startsWith(WEBDL_PREFIX);
      const params = new URLSearchParams();
      if (web) params.set("web_id", transferId.slice(WEBDL_PREFIX.length));
      else params.set("torrent_id", transferId);
      params.set("file_id", rawFile);
      params.set("append_name", "true");
      // The key must also be passed as the `token` query param, in addition to
      // the Bearer header.
      params.set("token", key);
      const path = `${web ? "/webdl" : "/torrents"}/requestdl?${params.toString()}`;
      const res = await base.call(key, path, { signal });
      const env = await readEnvelope<string>(res);
      const url = typeof env.data === "string" ? env.data : "";
      if (!url) {
        throw new DebridError("validation", "TorBox returned no download URL.", {
          provider: "torbox",
        });
      }
      return { url, filename: filenameFromUrl(url) };
    },
  };

  return provider;
}
