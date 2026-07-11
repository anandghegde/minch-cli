import { describe, expect, it } from "vitest";
import { mapPool } from "../src/util/concurrency";

describe("mapPool", () => {
  it("returns an empty array for no items", async () => {
    expect(await mapPool([], 4, async () => 1)).toEqual([]);
  });

  it("rejects a non-positive or non-finite concurrency limit", async () => {
    await expect(mapPool([1], 0, async () => 1)).rejects.toThrow(RangeError);
    await expect(mapPool([1], Number.NaN, async () => 1)).rejects.toThrow(RangeError);
  });

  it("preserves insertion order and maps every item exactly once", async () => {
    const items = [1, 2, 3, 4, 5];
    const settled = await mapPool(items, 2, async (n) => n * 10);
    expect(
      settled.map((r) => (r.status === "fulfilled" ? r.value : null)),
    ).toEqual([10, 20, 30, 40, 50]);
  });

  it("clamps concurrency below the item count (no overspawn)", async () => {
    let live = 0;
    let peak = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);
    await mapPool(items, 3, async (n) => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return n;
    });
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("isolates rejections: one failure does not abort the batch", async () => {
    const items = [1, 2, 3];
    const settled = await mapPool(items, 2, async (n) => {
      if (n === 2) throw new Error("boom");
      return n;
    });
    expect(settled[0]).toEqual({ status: "fulfilled", value: 1 });
    expect(settled[1]!.status).toBe("rejected");
    expect(settled[2]).toEqual({ status: "fulfilled", value: 3 });
  });

  it("passes the correct index for each item", async () => {
    const seen: number[] = [];
    await mapPool(["a", "b", "c"], 1, async (_item, i) => {
      seen.push(i);
      return i;
    });
    expect(seen).toEqual([0, 1, 2]);
  });

  it("invokes onSettled once per item with the settled result", async () => {
    const items = [1, 2, 3];
    const seen: { item: number; status: string; value: number | undefined }[] = [];
    await mapPool(items, 2, async (n) => n * 10, (item, _i, result) => {
      seen.push({
        item,
        status: result.status,
        value: result.status === "fulfilled" ? result.value : undefined,
      });
    });
    expect(seen).toHaveLength(3);
    expect(seen.sort((a, b) => a.item - b.item)).toEqual([
      { item: 1, status: "fulfilled", value: 10 },
      { item: 2, status: "fulfilled", value: 20 },
      { item: 3, status: "fulfilled", value: 30 },
    ]);
  });

  it("reports rejections to onSettled without throwing", async () => {
    const items = [1, 2, 3];
    const seen: { item: number; status: string; reason: string | undefined }[] = [];
    await mapPool(
      items,
      2,
      async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      },
      (item, _i, result) => {
        seen.push({
          item,
          status: result.status,
          reason:
            result.status === "rejected" ? (result.reason as Error).message : undefined,
        });
      },
    );
    expect(seen).toHaveLength(3);
    expect(seen.sort((a, b) => a.item - b.item)).toEqual([
      { item: 1, status: "fulfilled", reason: undefined },
      { item: 2, status: "rejected", reason: "boom" },
      { item: 3, status: "fulfilled", reason: undefined },
    ]);
  });

  it("continues all work when an onSettled observer throws", async () => {
    const settled = await mapPool([1, 2, 3], 1, async (item) => item, () => {
      throw new Error("observer failure");
    });
    expect(settled.map((result) => result.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "fulfilled",
    ]);
  });
});
