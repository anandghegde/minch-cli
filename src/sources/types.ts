export type SourceKind = "api" | "rss" | "torznab" | "cardigann" | "html";

export interface TorrentResult {
  /** Stable id for the result; info hash when known, else a derived key. */
  infoHash: string;
  name: string;
  sizeBytes: number;
  seeders: number;
  leechers: number;
  /** Source id that produced this result. */
  source: string;
  /** Human label of the producing source, for display. */
  sourceLabel?: string;
  magnet: string;
  /** Direct .torrent / download URL when the source exposes one. */
  downloadUrl?: string;
  /** Details / comments page URL. */
  detailsUrl?: string;
  /** Publish date, unix seconds. */
  added?: number;
  category?: string;
}

export interface SearchOptions {
  signal?: AbortSignal;
  /** Soft cap on rows to return; sources should honor it when cheap to do so. */
  limit?: number;
}

export interface TestResult {
  ok: boolean;
  /** Short human status, e.g. "ok", "42 results", error summary. */
  status: string;
  /** Round-trip latency in ms. */
  latency?: number;
  /** Result/row count from the probe, when applicable. */
  count?: number;
  /** Machine-readable error code, e.g. "HTTP 503", "timed out". */
  code?: string;
}

/**
 * Unified interface implemented by both the Cardigann executor and native
 * TypeScript sources. The registry stores these; enabled/health state lives
 * separately in config.
 */
export interface Source {
  id: string;
  label: string;
  kind: SourceKind;
  /** Mirror base URLs; single-element for sources with one URL. */
  links: string[];
  /** Site language tag, if known (informational). */
  language?: string;
  /** True if the source cannot run until the user supplies config (e.g. API key). */
  requiresConfig: boolean;
  /** Whether the source should be enabled by default once it passes a probe. */
  defaultEnabled: boolean;

  /**
   * Cheap health probe. Should hit a small feed / list / known-query endpoint
   * rather than running a broad search. Resolves with ok/false + a summary.
   */
  test(opts?: SearchOptions & { baseUrl?: string }): Promise<TestResult>;

  /**
   * Run a keyword search and return normalized results. `baseUrl` overrides
   * the active mirror for this call (used when switching/testing mirrors).
   */
  search(
    query: string,
    opts?: SearchOptions & { baseUrl?: string },
  ): Promise<TorrentResult[]>;
}
