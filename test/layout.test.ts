import { describe, expect, it } from "vitest";
import { listRowsForTerminal } from "../src/ui/layout";

describe("terminal layout budgeting", () => {
  it.each([
    [24, 40, 9],
    [24, 60, 12],
    [24, 80, 14],
  ])("leaves room for narrow-terminal chrome at %ix%i", (rows, cols, expected) => {
    expect(listRowsForTerminal(rows, cols)).toBe(expected);
  });

  it("never allocates fewer than four list rows", () => {
    expect(listRowsForTerminal(8, 40)).toBe(4);
  });
});
