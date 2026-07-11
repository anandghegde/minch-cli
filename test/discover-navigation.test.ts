import { describe, expect, it } from "vitest";
import { TAB_LABELS, TAB_ORDER } from "../src/ui/App";

describe("incremental Discover navigation", () => {
  it("keeps the internal trending key while exposing Discover", () => {
    expect(TAB_ORDER).toContain("trending");
    expect(TAB_ORDER).not.toContain("discover" as never);
    expect(TAB_LABELS.trending).toBe("Discover");
  });
});
