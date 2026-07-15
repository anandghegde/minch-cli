import { describe, expect, it, vi } from "vitest";
import type { BudgetStatus, RequestLedger } from "../../src/discovery/budget";
import {
  formatDiscoveryUsageReport,
  formatDiscoveryRatingsDiagnostics,
  readDiscoveryRatingsDiagnostics,
  readDiscoveryUsageReport,
} from "../../src/discovery/diagnostics";

describe("local discovery usage diagnostics", () => {
  it("reports source totals and enforced limits without resolving credentials", async () => {
    const canSpend = vi.fn<Pick<RequestLedger, "canSpend">["canSpend"]>(
      async (source, endpoint) => {
        const streaming = source === "streaming-availability";
        const trakt = source === "trakt";
        return {
          source,
          endpoint,
          month: "2026-07",
          used: streaming ? 84 : source === "tmdb" ? 3 : 0,
          endpointUsed: 0,
          allowed: !trakt,
          warning: false,
          ...(streaming
            ? { softWarning: 350, hardCap: 450, remaining: 366 }
            : trakt
              ? { softWarning: 0, hardCap: 0, remaining: 0 }
              : {}),
        } satisfies BudgetStatus;
      },
    );

    const report = await readDiscoveryUsageReport({ canSpend }, new Date("2026-07-10"));
    const text = formatDiscoveryUsageReport(report);

    expect(canSpend).toHaveBeenCalledTimes(6);
    expect(canSpend.mock.calls.every((call) => call[1] === "diagnostic")).toBe(true);
    expect(text).toContain("2026-07 UTC · local only");
    expect(text).toContain("TMDB");
    expect(text).toContain("3/unlimited");
    expect(text).toContain("Streaming Availability");
    expect(text).toContain("84/450");
    expect(text).toContain("366 remaining · warning at 350");
    expect(text).toContain("Trakt");
    expect(text).toContain("0/0");
    expect(text).toContain("disabled by policy");
    expect(text).toContain("1TamilMV");
    expect(text).not.toMatch(/api.?key|read.?token|authorization|credential/i);
  });

  it("keeps rating-provider diagnostics separate and secret-free", async () => {
    const report = await readDiscoveryRatingsDiagnostics({
      sources: {}, torznab: [], firstRunDone: true,
      discovery: { ratingProvider: "mdblist", mdblist: { apiKey: "must-not-print" } },
    }, Date.parse("2026-07-11T12:00:00Z"), {
      repository: { snapshot: vi.fn(async () => ({
        version: 1 as const,
        ratings: { exact: { key: "exact", rating: {
          system: "imdb" as const, provider: "mdblist" as const, value: 8,
          scale: 10 as const, observedAt: 1,
        }, fetchedAt: 1, expiresAt: 2, staleUntil: 3 } },
        identities: { unresolved: { key: "unresolved", unresolved: true,
          resolvedAt: 1, expiresAt: 2 } },
        missing: {},
        dataset: { etag: 'W/"revision-secret-looking"', checkedAt: Date.parse("2026-07-11T06:00:00Z") },
      })) },
      usage: { status: vi.fn(async () => ({ day: "2026-07-11", used: 18,
        allowed: true, warning: false, warningAt: 800, hardCap: 950, remaining: 932 })) },
    });
    const text = formatDiscoveryRatingsDiagnostics(report, Date.parse("2026-07-11T12:00:00Z"));
    expect(text).toContain("Ratings");
    expect(text).toContain("Provider: MDBList");
    expect(text).toContain("Dataset checked: 6h ago");
    expect(text).toContain("Cached exact ratings: 1");
    expect(text).toContain("Cached unresolved identities: 1");
    expect(text).toContain("Calls today: 18 / 950 local safety cap");
    expect(text).not.toContain("must-not-print");
  });
});
