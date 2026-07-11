import { describe, expect, it } from "vitest";
import { editText } from "../src/ui/text-input";

describe("shared text input editing", () => {
  it("inserts and deletes at the caret", () => {
    expect(editText("hello", 2, "X", {})).toMatchObject({ value: "heXllo", cursor: 3 });
    expect(editText("hello", 2, "", { backspace: true })).toMatchObject({ value: "hllo", cursor: 1 });
    expect(editText("hello", 2, "", { delete: true })).toMatchObject({ value: "helo", cursor: 2 });
  });

  it("supports arrow and readline-style start/end navigation", () => {
    expect(editText("hello", 2, "", { leftArrow: true }).cursor).toBe(1);
    expect(editText("hello", 2, "a", { ctrl: true }).cursor).toBe(0);
    expect(editText("hello", 2, "e", { ctrl: true }).cursor).toBe(5);
  });
});
