import { describe, expect, it } from "vitest";
import { createRequestGovernor } from "../src/cardigann/rate-limit";

describe("Cardigann request governor", () => {
  it("spaces requests according to the definition's requests-per-second limit", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const governor = createRequestGovernor(2, {
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
    });

    await governor.wait();
    await governor.wait();
    await governor.wait();

    expect(sleeps).toEqual([500, 500]);
  });

  it("does not leave a cancelled request blocking the source", async () => {
    const governor = createRequestGovernor(1, { sleep: async () => {} });
    await governor.wait();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(governor.wait(ctrl.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(governor.wait()).resolves.toBeUndefined();
  });
});
