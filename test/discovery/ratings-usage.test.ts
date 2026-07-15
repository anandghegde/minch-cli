import { describe, expect, it, vi } from "vitest";
import {
  createRatingsUsageLedger,
  MDBLIST_DAILY_CAP,
  MdblistBudgetExceededError,
} from "../../src/discovery/ratings/usage";

describe("MDBList daily usage", () => {
  it("records attempts by UTC day and stops before call 951", async () => {
    const writeJson = vi.fn(async () => {});
    const ledger = createRatingsUsageLedger({
      readFile: vi.fn(async () => JSON.stringify({
        version: 1,
        days: { "2026-07-11": { mdblistAttempts: MDBLIST_DAILY_CAP - 1 } },
      })),
      writeJson,
    });
    const now = Date.parse("2026-07-11T12:00:00Z");
    expect((await ledger.recordAttempt(now)).used).toBe(MDBLIST_DAILY_CAP);
    await expect(ledger.recordAttempt(now)).rejects.toBeInstanceOf(MdblistBudgetExceededError);
    expect(writeJson).toHaveBeenCalledOnce();
  });
});
