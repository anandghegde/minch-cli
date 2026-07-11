import type {
  CatalogTitle,
  DiscoverySource,
  MediaType,
  ReleaseEvent,
} from "./types";
import type { DiscoveryFeedKind, DiscoveryRequest } from "./request";
import type { NormalizedProvider } from "./normalize";

export type DiscoveryCapability =
  | "trending"
  | "regional_release"
  | "watch_providers"
  | "bluray"
  | "streaming_changes"
  | "streaming_upcoming"
  | "provider_dictionary"
  | "cursor_pagination";

export interface DiscoveryAdapterCapabilities {
  features: readonly DiscoveryCapability[];
  mediaTypes: readonly MediaType[];
  /** Empty means the source does not expose trustworthy region evidence. */
  regions: readonly string[];
}

export interface DiscoveryWarning {
  code: string;
  message: string;
  sourceRecordId?: string;
}

export interface DiscoveryAttribution {
  source: DiscoverySource;
  sourceLabel: string;
  sourceUrl: string;
  notice?: string;
  logoGuidanceUrl?: string;
  additionalNotices?: string[];
}

export interface DiscoverySnapshot {
  source: DiscoverySource;
  /** Request provenance used for feed classification after cache reload. */
  feedKind?: DiscoveryFeedKind;
  titles: CatalogTitle[];
  events: ReleaseEvent[];
  /** Unix milliseconds when this source response was fetched. */
  fetchedAt: number;
  /** Opaque source cursor, present only when another page is available. */
  cursor?: string;
  /** Optional source resume hint; callers must subtract the retained overlap. */
  resume?: {
    newestTimestampUnixSeconds: number;
    overlapSeconds: number;
  };
  warnings: DiscoveryWarning[];
  attribution?: DiscoveryAttribution;
  providers?: NormalizedProvider[];
}

export interface DiscoveryFetchOptions {
  signal?: AbortSignal;
  /** Explicit dependency injection keeps adapter tests offline. */
  fetchImpl: typeof fetch;
}

/**
 * Common adapter boundary. Phase 2 request types plug into `Request`; source
 * implementations may reject unsupported combinations without weakening the
 * shared normalized snapshot.
 */
export interface DiscoveryAdapter<Request = DiscoveryRequest> {
  readonly id: DiscoverySource;
  readonly label: string;
  readonly capabilities: DiscoveryAdapterCapabilities;
  /** Optional user switch; disabled is distinct from missing credentials. */
  isEnabled?(): boolean;
  isConfigured(): boolean;
  fetch(request: Request, options: DiscoveryFetchOptions): Promise<DiscoverySnapshot>;
}
