import { describe, expect, it } from "vitest";
import { cleanText } from "../src/util/format";

describe("cleanText", () => {
  it("returns an empty string for blank or control-only input", () => {
    expect(cleanText(" \u200b\u0000\u009b\u2066\u2069 ")).toBe("");
  });

  it("normalizes non-empty display text", () => {
    expect(cleanText("  Dune\u200b  Part Two  ")).toBe("Dune Part Two");
  });
});
