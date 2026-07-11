import { describe, expect, it, vi } from "vitest";
import {
  DiscoveryBudgetExceededError,
  createRequestLedger,
} from "../../src/discovery/budget";

const JANUARY = new Date("2026-01-31T23:59:59.000Z");
const FEBRUARY = new Date("2026-02-01T00:00:00.000Z");

function usage(attempts: number, endpoints: Record<string, number> = {}): string {
  return JSON.stringify({
    version: 1,
    months: {
      "2026-01": {
        sources: {
          "streaming-availability": { attempts, endpoints },
        },
      },
    },
  });
}

describe("monthly discovery request ledger", () => {
  it("warns at 350 and stops before attempt 451", async () => {
    const writes: unknown[] = [];
    const ledger = createRequestLedger({
      readFile: async () => usage(349, { changes: 349 }),
      writeJson: async (_file, value) => void writes.push(value),
    });

    expect(await ledger.canSpend("streaming-availability", "changes", JANUARY))
      .toMatchObject({ used: 349, warning: false, allowed: true, remaining: 101 });
    expect(await ledger.recordAttempt("streaming-availability", "changes", JANUARY))
      .toMatchObject({ used: 350, endpointUsed: 350, warning: true, allowed: true });

    const capped = createRequestLedger({
      readFile: async () => usage(450, { changes: 450 }),
      writeJson: async () => {},
    });
    expect(await capped.canSpend("streaming-availability", "changes", JANUARY))
      .toMatchObject({ used: 450, allowed: false, remaining: 0 });
    await expect(capped.recordAttempt("streaming-availability", "changes", JANUARY))
      .rejects.toBeInstanceOf(DiscoveryBudgetExceededError);
    expect(writes).toHaveLength(1);
  });

  it("tracks endpoint attempts, including retries, in the UTC billing month", async () => {
    const ledger = createRequestLedger({
      readFile: async () => usage(0),
      writeJson: async () => {},
    });

    await ledger.recordAttempt("streaming-availability", "changes", JANUARY);
    await ledger.recordAttempt("streaming-availability", "changes", JANUARY);
    const countries = await ledger.recordAttempt(
      "streaming-availability",
      "countries",
      JANUARY,
    );
    expect(countries).toMatchObject({ used: 3, endpointUsed: 1, month: "2026-01" });
    expect(await ledger.canSpend("streaming-availability", "changes", JANUARY))
      .toMatchObject({ used: 3, endpointUsed: 2 });
    expect(await ledger.canSpend("streaming-availability", "changes", FEBRUARY))
      .toMatchObject({ used: 0, endpointUsed: 0, month: "2026-02" });
  });

  it("atomically admits only attempt 450 under concurrent callers", async () => {
    const writeJson = vi.fn(async () => {});
    const ledger = createRequestLedger({
      readFile: async () => usage(449, { changes: 449 }),
      writeJson,
    });

    const outcomes = await Promise.allSettled([
      ledger.recordAttempt("streaming-availability", "changes", JANUARY),
      ledger.recordAttempt("streaming-availability", "changes", JANUARY),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(await ledger.canSpend("streaming-availability", "changes", JANUARY))
      .toMatchObject({ used: 450, allowed: false });
    expect(writeJson).toHaveBeenCalledTimes(1);
  });

  it("structurally prevents the ADR-disabled Trakt source", async () => {
    const ledger = createRequestLedger({
      readFile: async () => usage(0),
      writeJson: async () => {},
    });
    expect(await ledger.canSpend("trakt", "calendar", JANUARY))
      .toMatchObject({ hardCap: 0, allowed: false });
  });
});
