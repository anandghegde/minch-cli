// Shared foundation for debrid adapters (RealDebrid, TorBox, …). Each provider
// re-implemented the same fetch/auth/backoff/error-translation plumbing with
// only cosmetic differences (see refactoring-oppty.md, B1). This module hosts
// that shared behavior; adapters keep only their provider-specific envelope
// parsing and status/kind mapping.

import { fetchResilient, HttpError, parseRetryAfter, USER_AGENT } from "../util/net";
import type { Config } from "../config/config";
import { resolveKey, type ResolvedKey } from "./keys";
import { DebridError, type DebridErrorKind, type DebridId } from "./types";

/**
 * Conservative default backoff when a quota response carries no parseable
 * Retry-After header. Both providers rate-limit per-minute-ish windows.
 */
export const QUOTA_BACKOFF_MS = 60_000;

export function clamp01(n: number | undefined): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function isAbort(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export interface DebridBaseOptions {
  provider: DebridId;
  /** Human label used in generic messages, e.g. "Real Debrid" or "TorBox". */
  label: string;
  /** API origin, e.g. "https://api.torbox.app/v1/api". Paths are appended to it. */
  baseUrl: string;
  /** Message thrown by `requireKey()` when no key/token is configured. */
  noKeyMessage: string;
  /** Map an HTTP status onto a DebridErrorKind (providers disagree on a few, e.g. 402). */
  kindForStatus: (status: number) => DebridErrorKind;
}

export interface DebridBase {
  resolved: ResolvedKey;
  isConfigured(): boolean;
  /** Returns the resolved key, or throws a DebridError("auth", noKeyMessage). */
  requireKey(): string;
  /** This provider's kindForStatus, exposed so adapters don't redefine it. */
  kindForStatus(status: number): DebridErrorKind;
  /** Resilient, bearer-authenticated fetch against `baseUrl + path`. */
  call(
    key: string,
    path: string,
    init?: RequestInit & { signal?: AbortSignal; retries?: number },
  ): Promise<Response>;
  /** Best-effort JSON body parse; undefined for empty/invalid bodies. */
  readJson<T>(res: Response): Promise<T | undefined>;
  /** Build a DebridError for a known HTTP status, with an optional kind override. */
  errorForStatus(
    status: number,
    message: string,
    opts?: { kind?: DebridErrorKind; headers?: Headers },
  ): DebridError;
}

export function createDebridBase(config: Config, opts: DebridBaseOptions): DebridBase {
  const resolved = resolveKey(opts.provider, config);

  function requireKey(): string {
    if (!resolved.key) {
      throw new DebridError("auth", opts.noKeyMessage, { provider: opts.provider });
    }
    return resolved.key;
  }

  function errorForStatus(
    status: number,
    message: string,
    o: { kind?: DebridErrorKind; headers?: Headers } = {},
  ): DebridError {
    const kind = o.kind ?? opts.kindForStatus(status);
    const retryAfterMs =
      kind === "quota"
        ? (parseRetryAfter(o.headers?.get("retry-after") ?? null) ?? QUOTA_BACKOFF_MS)
        : undefined;
    return new DebridError(kind, message, { provider: opts.provider, status, retryAfterMs });
  }

  async function call(
    key: string,
    path: string,
    init: RequestInit & { signal?: AbortSignal; retries?: number } = {},
  ): Promise<Response> {
    const { retries = 2, headers, signal, ...rest } = init;
    try {
      return await fetchResilient(`${opts.baseUrl}${path}`, {
        ...rest,
        signal,
        retries,
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: "application/json",
          "User-Agent": USER_AGENT,
          ...(headers ?? {}),
        },
      });
    } catch (e) {
      if (isAbort(signal)) throw e;
      if (e instanceof HttpError) {
        throw errorForStatus(e.status, `${opts.label} request failed (HTTP ${e.status}).`);
      }
      if (e instanceof DebridError) throw e;
      throw new DebridError("transient", e instanceof Error ? e.message : String(e), {
        provider: opts.provider,
        cause: e,
      });
    }
  }

  async function readJson<T>(res: Response): Promise<T | undefined> {
    const text = await res.text().catch(() => "");
    if (!text) return undefined;
    try {
      return JSON.parse(text) as T;
    } catch {
      return undefined;
    }
  }

  return {
    resolved,
    isConfigured: () => resolved.key !== undefined,
    requireKey,
    kindForStatus: opts.kindForStatus,
    call,
    readJson,
    errorForStatus,
  };
}
