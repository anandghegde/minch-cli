// Provider-agnostic debrid foundation. Every cloud service (TorBox, Real Debrid,
// …) implements `DebridProvider`, and each adapter normalizes its raw API onto
// the shared `Transfer` model below so the TUI never branches on a specific
// provider.

export type DebridId = "torbox" | "realdebrid";

/** Every known provider id, in display order. Adapters register in registry.ts. */
export const DEBRID_IDS: readonly DebridId[] = ["torbox", "realdebrid"] as const;

/** Human labels, used for badges/notices without instantiating a provider. */
export const PROVIDER_LABELS: Record<DebridId, string> = {
  torbox: "TorBox",
  realdebrid: "Real Debrid",
};

export type TransferStatus =
  | "queued"
  | "downloading"
  | "seeding"
  | "done"
  | "error"
  | "needs_selection";

export interface TransferFile {
  id: string;
  name: string;
  sizeBytes: number;
  selected: boolean;
}

export interface Transfer {
  provider: DebridId;
  /** Provider-native id, as a string. */
  id: string;
  name: string;
  sizeBytes: number;
  /** 0..1 */
  progress: number;
  status: TransferStatus;
  downloadSpeedBps?: number;
  etaSeconds?: number;
  files: TransferFile[];
  hash?: string;
  /** Unix seconds. */
  addedAt?: number;
}

export interface AddOptions {
  name?: string;
  /** When true, only add if already cached on the provider (don't queue). */
  cacheOnly?: boolean;
  signal?: AbortSignal;
}

export interface AddResult {
  id?: string;
  queuedId?: string;
  hash?: string;
  /** Human-facing message from the provider envelope, when present. */
  detail?: string;
  alreadyPresent?: boolean;
}

export interface ResolvedFile {
  url: string;
  filename: string;
  sizeBytes?: number;
}

export interface AccountInfo {
  email?: string;
  plan?: string;
  premium?: boolean;
}

/**
 * One interface implemented by every service so the TUI stays
 * provider-agnostic. Adapters live in `src/debrid/<provider>.ts`.
 */
export interface DebridProvider {
  id: DebridId;
  /** Human label, e.g. "TorBox". */
  label: string;
  /** True once a usable key/token is available (env var or config). */
  isConfigured(): boolean;

  /** Validate the key and report account/plan info. */
  checkAuth(signal?: AbortSignal): Promise<AccountInfo>;

  addMagnet(magnet: string, opts?: AddOptions): Promise<AddResult>;
  addTorrentFile?(
    data: Uint8Array,
    name: string,
    opts?: AddOptions,
  ): Promise<AddResult>;

  /** Normalized list of every transfer the account currently holds. */
  listTransfers(signal?: AbortSignal): Promise<Transfer[]>;
  getTransfer(id: string, signal?: AbortSignal): Promise<Transfer>;
  remove(id: string, signal?: AbortSignal): Promise<void>;

  /**
   * Optional pre-flight: report which of the given magnets/info-hashes are
   * already cached on the provider (keyed by lowercase BTIH). Lets the UI label
   * an add as instant vs queued without branching on the provider.
   */
  checkCached?(
    magnetsOrHashes: string[],
    signal?: AbortSignal,
  ): Promise<Record<string, boolean>>;

  /**
   * Resolve ONE finished file to a direct, range-capable HTTPS URL (consumed by
   * the local accelerator).
   */
  resolveFileUrl(
    transferId: string,
    fileId: string,
    signal?: AbortSignal,
  ): Promise<ResolvedFile>;
}

export type DebridErrorKind =
  | "auth"
  | "quota"
  | "validation"
  | "transient"
  | "unknown";

/**
 * Normalized error surfaced by every adapter. `kind` lets the UI react
 * (re-auth prompt, back off, etc.) without parsing provider-specific bodies.
 */
export class DebridError extends Error {
  readonly kind: DebridErrorKind;
  readonly provider?: DebridId;
  /** HTTP status, when the failure originated from a response. */
  readonly status?: number;
  /** Suggested backoff before retrying, in milliseconds. */
  readonly retryAfterMs?: number;

  constructor(
    kind: DebridErrorKind,
    message: string,
    opts: {
      provider?: DebridId;
      status?: number;
      retryAfterMs?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = "DebridError";
    this.kind = kind;
    this.provider = opts.provider;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
    if (opts.cause !== undefined) (this as { cause?: unknown }).cause = opts.cause;
  }
}

export function isDebridError(e: unknown): e is DebridError {
  return e instanceof DebridError;
}
