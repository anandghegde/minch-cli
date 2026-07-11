/** Pure discovery-domain types. This module must not depend on torrent or UI contracts. */

export type MediaType = "movie" | "series" | "season" | "episode";

export type ReleaseKind =
  | "streaming_added"
  | "streaming_upcoming"
  | "digital"
  | "physical"
  | "bluray"
  | "uhd_bluray";

export type DatePrecision = "day" | "month" | "year" | "unknown";
export type EvidenceConfidence = "exact" | "source_claim" | "inferred";
export type ReleaseStatus = "past" | "today" | "upcoming" | "unknown";

/** Trakt remains a dormant value while ADR 002's no-go decision is in force. */
export type DiscoverySource =
  | "tmdb"
  | "bluray"
  | "trakt"
  | "streaming-availability";

/** ISO 3166-1 alpha-2 when known; `ZZ` is the explicit unknown-region sentinel. */
export type RegionCode = string;
export const UNKNOWN_REGION: RegionCode = "ZZ";

export interface CatalogTitle {
  /** Stable deterministic internal identity, not a display title. */
  id: string;
  title: string;
  originalTitle?: string;
  year?: number;
  mediaType: MediaType;
  tmdbId?: number;
  imdbId?: string;
  traktId?: number;
  /** ISO 639-1 when the source supplies it. */
  originalLanguage?: string;
  /** ISO 3166-1 alpha-2; empty means unknown, never inferred from language. */
  originCountries: string[];
  genreIds: number[];
  genreLabels?: string[];
  posterUrl?: string;
  images?: {
    verticalPoster?: string;
    horizontalPoster?: string;
    horizontalBackdrop?: string;
    verticalBackdrop?: string;
  };
  popularity?: number;
}

export interface ReleaseEvent {
  /** Deterministic event identity. */
  id: string;
  titleId: string;
  kind: ReleaseKind;
  /** Region evidence such as `IN`, or explicit `ZZ`; never silently global. */
  region: RegionCode;
  /** Calendar date in strict YYYY-MM-DD form when known. */
  date?: string;
  datePrecision: DatePrecision;
  providerId?: string;
  providerLabel?: string;
  formatLabel?: string;
  accessType?: string;
  audioLanguages?: string[];
  subtitleLanguages?: string[];
  status: ReleaseStatus;
  /** Unix milliseconds of local observation; not a release date. */
  firstObservedAt: number;
  /** Unix milliseconds of local observation; not a release date. */
  lastObservedAt: number;
  evidence: SourceEvidence[];
}

export interface SourceEvidence {
  source: DiscoverySource;
  sourceId?: string;
  sourceUrl?: string;
  /** Unix milliseconds at which this evidence was observed. */
  observedAt: number;
  confidence: EvidenceConfidence;
}
