import { XMLParser } from "fast-xml-parser";
import { fetchResilient, HttpError, USER_AGENT } from "../util/net";
import type { TestResult, TorrentResult } from "./types";

/**
 * Shared toolkit for native source adapters. Each adapter keeps only its
 * provider-specific parsing; this module owns the fetch / limit / date / RSS /
 * probe skeletons that were previously copy-pasted across apibay, nyaa, yts,
 * solidtorrents, torznab, and cardigann/source.ts.
 */

/** Identity reused in both makeResult and an exported Source descriptor. */
export interface SourceIdentity {
  id: string;
  label: string;
}

/**
 * Map a thrown error to a machine-readable code. The single error→code
 * mapping for the whole search path (adapters, the health probe, and the
 * concurrent search fan-out). Abort wins; an HttpError with a real status
 * surfaces "HTTP {n}"; status 0 (connection failure / "unreachable") and
 * non-HTTP errors collapse to "no response". This replaces the previous
 * /HTTP \d+/ message regex that round-tripped a structured status through a
 * string.
 */
export function errorToCode(e: unknown, aborted: boolean): string {
  if (aborted) return "timed out";
  if (e instanceof HttpError && e.status > 0) return `HTTP ${e.status}`;
  return "no response";
}

/** Apply opts.limit to a result array when set. */
export function applyLimit<T>(rows: T[], opts: { limit?: number }): T[] {
  return typeof opts.limit === "number" ? rows.slice(0, opts.limit) : rows;
}

/**
 * Convert a date string or epoch-ms number to floored unix seconds. Returns
 * undefined for missing or unparseable input — fixes the NaN-added smell where
 * nyaa/torznab previously emitted NaN on an unparseable pubDate.
 */
export function toUnixSeconds(
  value: string | number | null | undefined,
): number | undefined {
  if (value === undefined || value === null) return undefined;
  const ms = typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(ms)) return undefined;
  return Math.floor(ms / 1000);
}

const rssParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

/**
 * Parse RSS XML and return channel.item as an array (empty when absent).
 * Callers cast each item to their own provider shape; only the RSS extraction
 * (parser config + channel.item unwrap) is shared.
 */
export function parseRssItems(xml: string): unknown[] {
  const doc = rssParser.parse(xml);
  const raw = doc?.rss?.channel?.item;
  return Array.isArray(raw) ? raw : raw ? [raw] : [];
}

/** Inject the source id/label into a result built without them. */
export function makeResult(
  source: SourceIdentity,
  row: Omit<TorrentResult, "source" | "sourceLabel">,
): TorrentResult {
  return { ...row, source: source.id, sourceLabel: source.label };
}

interface FetchOpts {
  signal?: AbortSignal;
  retries?: number;
}

/** fetchResilient options tuned like the native adapters (retries default 1). */
function resilientOpts(opts: FetchOpts): Parameters<typeof fetchResilient>[1] {
  return {
    headers: { "User-Agent": USER_AGENT },
    signal: opts.signal,
    retries: opts.retries ?? 1,
  };
}

/**
 * Fetch a single URL and parse its JSON body. Throws HttpError on a non-ok
 * response (or a transient failure that exhausts retries).
 */
export async function fetchJson<T>(
  url: string,
  opts: FetchOpts = {},
): Promise<T> {
  const res = await fetchResilient(url, resilientOpts(opts));
  if (!res.ok) throw new HttpError(res.status, `${url} returned ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Try each URL in order, returning the first ok response parsed via `parse`.
 * Abort-aware: an aborted signal rethrows immediately rather than falling
 * through to the next host. Throws the last error (or HttpError(0) if none was
 * an Error) when every host fails — matching the previous per-adapter
 * multi-host fallback loops.
 */
export async function fetchFirstOk<T>(
  urls: string[],
  opts: FetchOpts = {},
  parse: (res: Response) => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (const url of urls) {
    try {
      const res = await fetchResilient(url, resilientOpts(opts));
      if (res.ok) return await parse(res);
      lastError = new HttpError(res.status, `${url} returned ${res.status}`);
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      lastError = e;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new HttpError(0, "all hosts unreachable");
}

/** Shape returned by a runProbe body callback. */
export interface ProbeBody {
  count: number;
  /** Override the default ok = count > 0. */
  ok?: boolean;
  /** Override the default status string. */
  status?: string;
  /** Override the default success code (undefined). */
  code?: string;
}

/**
 * Wrap a probe in the standard test() envelope: measure latency, return a
 * count-based success, and map any thrown error to a code via errorToCode.
 * `body` does the fetch+parse and reports the row count, plus optional
 * overrides (e.g. torznab's always-ok caps probe, or the "empty" code some
 * adapters use for a successful but zero-row probe).
 */
export async function runProbe(
  opts: { signal?: AbortSignal },
  body: () => Promise<ProbeBody>,
): Promise<TestResult> {
  const started = Date.now();
  try {
    const res = await body();
    const latency = Date.now() - started;
    const ok = res.ok ?? res.count > 0;
    return {
      ok,
      status: res.status ?? (ok ? `${res.count} results` : "no results"),
      latency,
      count: res.count,
      code: res.code,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: msg,
      latency: Date.now() - started,
      code: errorToCode(e, Boolean(opts.signal?.aborted)),
    };
  }
}
