import { describe, expect, it, vi } from "vitest";
import type { BudgetStatus, RequestLedger } from "../../src/discovery/budget";
import {
  formatDiscoveryUsageReport,
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

    expect(canSpend).toHaveBeenCalledTimes(4);
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
    expect(text).not.toMatch(/api.?key|read.?token|authorization|credential/i);
  });
});
