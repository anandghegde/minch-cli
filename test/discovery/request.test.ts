import { describe, expect, it } from "vitest";
import {
  DiscoveryRequestError,
  validateDiscoveryRequest,
  type DiscoveryRequest,
} from "../../src/discovery/request";

function request(overrides: Partial<DiscoveryRequest> = {}): DiscoveryRequest {
  return {
    region: "IN",
    feedKind: "streaming_added",
    dateRange: {
      start: "2026-06-09",
      end: "2026-07-10",
      direction: "past",
    },
    mediaTypes: ["movie", "series"],
    providerIds: ["netflix", "prime"],
    pageLimit: 4,
    ...overrides,
  };
}

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof DiscoveryRequestError ? error.code : "unexpected";
  }
}

describe("validateDiscoveryRequest", () => {
  it("accepts a bounded India streaming request", () => {
    const value = request();
    expect(validateDiscoveryRequest(value)).toBe(value);
  });

  it("rejects invalid regions, impossible dates, and reversed ranges", () => {
    expect(errorCode(() => validateDiscoveryRequest(request({ region: "in" }))))
      .toBe("invalid_region");
    expect(
      errorCode(() =>
        validateDiscoveryRequest(
          request({ dateRange: { start: "2026-02-30", end: "2026-03-01", direction: "past" } }),
        ),
      ),
    ).toBe("invalid_date");
    expect(
      errorCode(() =>
        validateDiscoveryRequest(
          request({ dateRange: { start: "2026-07-10", end: "2026-07-09", direction: "past" } }),
        ),
      ),
    ).toBe("reversed_date_range");
  });

  it("enforces the 31-day streaming range and four-page cap", () => {
    expect(
      errorCode(() =>
        validateDiscoveryRequest(
          request({ dateRange: { start: "2026-06-08", end: "2026-07-10", direction: "past" } }),
        ),
      ),
    ).toBe("date_range_too_large");
    expect(errorCode(() => validateDiscoveryRequest(request({ pageLimit: 5 }))))
      .toBe("invalid_page_limit");
  });

  it("rejects malformed provider IDs and cursors before an adapter sees them", () => {
    expect(errorCode(() => validateDiscoveryRequest(request({ providerIds: [" netflix"] }))))
      .toBe("invalid_provider");
    expect(errorCode(() => validateDiscoveryRequest(request({ cursor: "" }))))
      .toBe("invalid_cursor");
  });
});
