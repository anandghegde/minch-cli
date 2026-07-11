import type { MediaType } from "./types";
import { parseDateOnly } from "./dates";

export const MAX_DISCOVERY_PAGES = 4;
export const MAX_PROVIDER_IDS = 32;
export const MAX_STREAMING_RANGE_DAYS = 31;
export const MAX_CATALOG_RANGE_DAYS = 366;

export type DiscoveryFeedKind =
  | "trending"
  | "streaming_added"
  | "streaming_upcoming"
  | "digital"
  | "physical"
  | "bluray"
  | "provider_dictionary";

export type DateRangeDirection = "past" | "upcoming";

export interface DiscoveryDateRange {
  start: string;
  end: string;
  direction: DateRangeDirection;
}

export interface DiscoveryRequest {
  region: string;
  feedKind: DiscoveryFeedKind;
  dateRange?: DiscoveryDateRange;
  mediaTypes: MediaType[];
  providerIds: string[];
  /** Maximum pages/cursor advances an adapter may consume for this request. */
  pageLimit: number;
  /** Opaque resume cursor supplied by a source snapshot. */
  cursor?: string;
}

export type DiscoveryRequestErrorCode =
  | "invalid_region"
  | "invalid_date"
  | "reversed_date_range"
  | "date_range_too_large"
  | "invalid_page_limit"
  | "too_many_providers"
  | "invalid_provider"
  | "invalid_cursor";

export class DiscoveryRequestError extends Error {
  constructor(
    readonly code: DiscoveryRequestErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DiscoveryRequestError";
  }
}

/** Validate all source-independent bounds before a request reaches an adapter. */
export function validateDiscoveryRequest(request: DiscoveryRequest): DiscoveryRequest {
  if (!/^[A-Z]{2}$/.test(request.region)) {
    throw new DiscoveryRequestError(
      "invalid_region",
      "region must be an uppercase ISO alpha-2 code or ZZ",
    );
  }
  if (!Number.isInteger(request.pageLimit) || request.pageLimit < 1 || request.pageLimit > MAX_DISCOVERY_PAGES) {
    throw new DiscoveryRequestError(
      "invalid_page_limit",
      `pageLimit must be between 1 and ${MAX_DISCOVERY_PAGES}`,
    );
  }
  if (request.providerIds.length > MAX_PROVIDER_IDS) {
    throw new DiscoveryRequestError(
      "too_many_providers",
      `providerIds cannot exceed ${MAX_PROVIDER_IDS}`,
    );
  }
  if (request.providerIds.some((id) => !id.trim() || id !== id.trim())) {
    throw new DiscoveryRequestError(
      "invalid_provider",
      "provider IDs must be non-empty and already trimmed",
    );
  }
  if (request.cursor !== undefined && (!request.cursor || request.cursor.length > 2_048)) {
    throw new DiscoveryRequestError(
      "invalid_cursor",
      "cursor must be non-empty and at most 2048 characters",
    );
  }
  if (request.dateRange) {
    const start = parseDateOnly(request.dateRange.start);
    const end = parseDateOnly(request.dateRange.end);
    if (!start || !end) {
      throw new DiscoveryRequestError(
        "invalid_date",
        "date ranges require real YYYY-MM-DD calendar dates",
      );
    }
    if (end.epochDay < start.epochDay) {
      throw new DiscoveryRequestError(
        "reversed_date_range",
        "date range end cannot precede start",
      );
    }
    const streaming =
      request.feedKind === "streaming_added" || request.feedKind === "streaming_upcoming";
    const maxDays = streaming ? MAX_STREAMING_RANGE_DAYS : MAX_CATALOG_RANGE_DAYS;
    if (end.epochDay - start.epochDay > maxDays) {
      throw new DiscoveryRequestError(
        "date_range_too_large",
        `${request.feedKind} date range cannot exceed ${maxDays} days`,
      );
    }
  }
  return request;
}
