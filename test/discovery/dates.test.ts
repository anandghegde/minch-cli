import { describe, expect, it } from "vitest";
import {
  compareDateOnly,
  indiaToday,
  isWithinDateRange,
  parseDateOnly,
  statusForDate,
} from "../../src/discovery/dates";

describe("parseDateOnly", () => {
  it("accepts real calendar dates including leap days", () => {
    expect(parseDateOnly("2024-02-29")).toMatchObject({
      value: "2024-02-29",
      year: 2024,
      month: 2,
      day: 29,
    });
  });

  it("rejects impossible, normalized, or timestamp-shaped values", () => {
    expect(parseDateOnly("2026-02-29")).toBeUndefined();
    expect(parseDateOnly("2026-04-31")).toBeUndefined();
    expect(parseDateOnly("2026-7-10")).toBeUndefined();
    expect(parseDateOnly("2026-07-10T00:00:00Z")).toBeUndefined();
    expect(parseDateOnly(undefined)).toBeUndefined();
  });
});

describe("India-local date behavior", () => {
  it("changes day at midnight in Asia/Kolkata, independent of process TZ", () => {
    expect(indiaToday(new Date("2026-07-09T18:29:59.999Z"))).toBe("2026-07-09");
    expect(indiaToday(new Date("2026-07-09T18:30:00.000Z"))).toBe("2026-07-10");
  });

  it("uses inclusive windows and rejects missing dates", () => {
    expect(isWithinDateRange("2026-07-01", "2026-07-01", "2026-07-10")).toBe(true);
    expect(isWithinDateRange("2026-07-10", "2026-07-01", "2026-07-10")).toBe(true);
    expect(isWithinDateRange("2026-06-30", "2026-07-01", "2026-07-10")).toBe(false);
    expect(isWithinDateRange(undefined, "2026-07-01", "2026-07-10")).toBe(false);
  });

  it("calculates past, today, upcoming, and unknown status", () => {
    expect(statusForDate("2026-07-09", "2026-07-10")).toBe("past");
    expect(statusForDate("2026-07-10", "2026-07-10")).toBe("today");
    expect(statusForDate("2026-07-11", "2026-07-10")).toBe("upcoming");
    expect(statusForDate(undefined, "2026-07-10")).toBe("unknown");
    expect(statusForDate("2026-02-30", "2026-07-10")).toBe("unknown");
  });
});

describe("compareDateOnly", () => {
  const dates = [undefined, "2026-07-11", "invalid", "2026-07-09"];

  it("keeps unknown dates last in either direction", () => {
    const ascending = dates.slice().sort((a, b) => compareDateOnly(a, b, "asc"));
    const descending = dates.slice().sort((a, b) => compareDateOnly(a, b, "desc"));
    expect(ascending.slice(0, 2)).toEqual(["2026-07-09", "2026-07-11"]);
    expect(descending.slice(0, 2)).toEqual(["2026-07-11", "2026-07-09"]);
    expect(ascending.slice(2)).toEqual(expect.arrayContaining([undefined, "invalid"]));
    expect(descending.slice(2)).toEqual(expect.arrayContaining([undefined, "invalid"]));
  });
});
