import type { ReleaseStatus } from "./types";

const DAY_MS = 86_400_000;
const INDIA_TIME_ZONE = "Asia/Kolkata";
const INDIA_DATE_FORMAT = new Intl.DateTimeFormat("en-CA", {
  timeZone: INDIA_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export interface ParsedDateOnly {
  value: string;
  year: number;
  month: number;
  day: number;
  epochDay: number;
}

export type DateSortDirection = "asc" | "desc";

/** Parse a real calendar date without allowing JS date normalization. */
export function parseDateOnly(value: unknown): ParsedDateOnly | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return undefined;

  const date = new Date(0);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }

  return {
    value,
    year,
    month,
    day,
    epochDay: Math.floor(date.getTime() / DAY_MS),
  };
}

/** Return today's calendar date in India regardless of the process timezone. */
export function indiaToday(now: Date | number = Date.now()): string {
  const date = typeof now === "number" ? new Date(now) : now;
  if (!Number.isFinite(date.getTime())) throw new RangeError("now must be a valid date");
  const parts = Object.fromEntries(
    INDIA_DATE_FORMAT.formatToParts(date).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Shift a strict calendar date by whole days without local-time normalization. */
export function shiftDateOnly(value: string, days: number): string {
  const parsed = parseDateOnly(value);
  if (!parsed || !Number.isInteger(days)) throw new RangeError("invalid date shift");
  return new Date((parsed.epochDay + days) * DAY_MS).toISOString().slice(0, 10);
}

/** Inclusive comparison; any invalid or missing date fails the window. */
export function isWithinDateRange(
  value: string | undefined,
  start: string,
  end: string,
): boolean {
  const date = parseDateOnly(value);
  const lower = parseDateOnly(start);
  const upper = parseDateOnly(end);
  return !!date && !!lower && !!upper && lower.epochDay <= date.epochDay && date.epochDay <= upper.epochDay;
}

/** Sort known dates chronologically while keeping missing/invalid values last. */
export function compareDateOnly(
  a: string | undefined,
  b: string | undefined,
  direction: DateSortDirection,
): number {
  const left = parseDateOnly(a);
  const right = parseDateOnly(b);
  if (!!left !== !!right) return left ? -1 : 1;
  if (!left || !right) return 0;
  return direction === "asc"
    ? left.epochDay - right.epochDay
    : right.epochDay - left.epochDay;
}

export function statusForDate(
  value: string | undefined,
  today: string = indiaToday(),
): ReleaseStatus {
  const date = parseDateOnly(value);
  const reference = parseDateOnly(today);
  if (!date || !reference) return "unknown";
  if (date.epochDay < reference.epochDay) return "past";
  if (date.epochDay > reference.epochDay) return "upcoming";
  return "today";
}
