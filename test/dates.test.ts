import { describe, expect, it } from "vitest";
import { fromTimeAgo, fromUnknown, parseGoLayout } from "../src/cardigann/dates";

describe("dates", () => {
  it("parses relative times", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(fromTimeAgo("just now")).toBeCloseTo(now, -1);
    const twoDays = fromTimeAgo("2 days ago")!;
    expect(now - twoDays).toBeGreaterThan(86400);
    expect(now - twoDays).toBeLessThan(3 * 86400);
  });

  it("returns null for non-relative input", () => {
    expect(fromTimeAgo("2024-01-01")).toBeNull();
  });

  it("treats the bare 'now' fallback sentinel as unknown", () => {
    // 1337x et al. emit "now" when no date selector matched; it must not be
    // treated as the current time, or old torrents bypass the date filter.
    expect(fromTimeAgo("now")).toBeNull();
    // A genuine "just now" is a real relative time and still resolves to ~now.
    expect(fromTimeAgo("just now")).not.toBeNull();
  });

  it("parses Go layouts", () => {
    const t = parseGoLayout("2024-03-15", "2006-01-02")!;
    const d = new Date(t * 1000);
    expect(d.getUTCFullYear()).toBe(2024);
    expect(d.getUTCMonth()).toBe(2);
    expect(d.getUTCDate()).toBe(15);
  });

  it("fromUnknown handles ISO and named months", () => {
    expect(new Date(fromUnknown("2023-06-01")! * 1000).getUTCFullYear()).toBe(2023);
    const dmy = fromUnknown("12 Jan 2022")!;
    expect(new Date(dmy * 1000).getUTCFullYear()).toBe(2022);
  });
});
