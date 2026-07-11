import { describe, expect, it } from "vitest";
import { selectEventsByDate } from "../../src/discovery/aggregate";
import type { DatePrecision, ReleaseEvent } from "../../src/discovery/types";

function event(
  id: string,
  date: string | undefined,
  datePrecision: DatePrecision = date ? "day" : "unknown",
): ReleaseEvent {
  return {
    id,
    titleId: `title:${id}`,
    kind: "streaming_added",
    region: "IN",
    ...(date ? { date } : {}),
    datePrecision,
    status: date ? "past" : "unknown",
    firstObservedAt: 1,
    lastObservedAt: 1,
    evidence: [{ source: "streaming-availability", observedAt: 1, confidence: "exact" }],
  };
}

describe("aggregated event date selection", () => {
  const events = [
    event("unknown", undefined),
    event("older", "2026-07-02"),
    event("newer", "2026-07-09"),
    event("month-only", "2026-07-01", "month"),
  ];

  it("requires a day-precision known date under an active range", () => {
    const selected = selectEventsByDate(events, {
      direction: "past",
      range: { start: "2026-07-03", end: "2026-07-10" },
    });

    expect(selected.map((item) => item.id)).toEqual(["newer"]);
  });

  it("keeps unknown dates only in All and sorts them after every known date", () => {
    const selected = selectEventsByDate(events, { direction: "past" });

    expect(selected.map((item) => item.id)).toEqual([
      "newer",
      "older",
      "month-only",
      "unknown",
    ]);
  });

  it("sorts upcoming dates soonest first with stable ID ties", () => {
    const selected = selectEventsByDate([
      event("later", "2026-07-20"),
      event("same-b", "2026-07-12"),
      event("same-a", "2026-07-12"),
      event("unknown", undefined),
    ], { direction: "upcoming" });

    expect(selected.map((item) => item.id)).toEqual([
      "same-a",
      "same-b",
      "later",
      "unknown",
    ]);
  });
});
