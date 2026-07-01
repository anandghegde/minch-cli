// Date parsing for Cardigann's dateparse/timeparse/timeago/fuzzytime filters.
// Cardigann uses Go reference-time layouts; we support the layouts that appear
// in public definitions plus a best-effort fuzzy fallback. Returns unix seconds.

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  january: 0, february: 1, march: 2, april: 3, june: 5, july: 6,
  august: 7, september: 8, october: 9, november: 10, december: 11,
};

function clean(s: string): string {
  return s.replace(/(\d+)(st|nd|rd|th)/gi, "$1").replace(/\s+/g, " ").trim();
}

/** "5 hours ago", "2 days ago", "yesterday", "10 minutes ago", "just now". */
export function fromTimeAgo(input: string): number | null {
  const s = input.toLowerCase().trim();
  const now = Date.now();
  if (/just now|now|moments? ago/.test(s)) return Math.floor(now / 1000);
  if (/yesterday/.test(s)) return Math.floor((now - 86400_000) / 1000);
  if (/today/.test(s)) return Math.floor(now / 1000);

  let total = 0;
  let matched = false;
  const re =
    /(\d+(?:\.\d+)?)\s*(sec|second|min|minute|hour|hr|day|week|month|year|mo|yr|y|w|d|h|m|s)s?\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    matched = true;
    const n = parseFloat(m[1]!);
    const unit = m[2]!;
    const mult: Record<string, number> = {
      s: 1, sec: 1, second: 1,
      m: 60, min: 60, minute: 60,
      h: 3600, hr: 3600, hour: 3600,
      d: 86400, day: 86400,
      w: 604800, week: 604800,
      mo: 2592000, month: 2592000,
      y: 31536000, yr: 31536000, year: 31536000,
    };
    total += n * (mult[unit] ?? 0);
  }
  if (!matched) return null;
  return Math.floor((now - total * 1000) / 1000);
}

const GO_TOKENS: [RegExp, string][] = [
  [/2006/g, "(?<year>\\d{4})"],
  [/06/g, "(?<year2>\\d{2})"],
  [/January/g, "(?<monthName>[A-Za-z]+)"],
  [/Jan/g, "(?<monthAbbr>[A-Za-z]{3,})"],
  [/01/g, "(?<month>\\d{1,2})"],
  [/Monday/g, "[A-Za-z]+"],
  [/Mon/g, "[A-Za-z]{3,}"],
  [/02/g, "(?<day>\\d{1,2})"],
  [/_2/g, "\\s*(?<day>\\d{1,2})"],
  [/2\b/g, "(?<day>\\d{1,2})"],
  [/15/g, "(?<hour>\\d{1,2})"],
  [/03/g, "(?<hour12>\\d{1,2})"],
  [/04/g, "(?<min>\\d{1,2})"],
  [/05/g, "(?<sec>\\d{1,2})"],
  [/PM/g, "(?<ampm>[AaPp][Mm])"],
  [/-0700/g, "[+-]\\d{4}"],
  [/-07:00/g, "[+-]\\d{2}:\\d{2}"],
  [/MST/g, "[A-Za-z]+"],
  [/Z07:00/g, "(?:Z|[+-]\\d{2}:\\d{2})"],
];

function escapeLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Parse a date string given a Go-style layout (best effort). */
export function parseGoLayout(input: string, layout: string): number | null {
  // Build a regex from the layout by replacing reference-time tokens.
  let pattern = "";
  let rest = layout;
  // Tokenize: greedily replace known tokens, escaping literal runs between.
  const tokenRe =
    /(2006|January|Jan|Monday|Mon|15|01|02|03|04|05|06|_2|2|PM|Z07:00|-07:00|-0700|MST)/g;
  let last = 0;
  let mm: RegExpExecArray | null;
  while ((mm = tokenRe.exec(rest)) !== null) {
    pattern += escapeLiteral(rest.slice(last, mm.index));
    const tok = mm[0]!;
    const found = GO_TOKENS.find(([re]) => {
      re.lastIndex = 0;
      return re.test(tok);
    });
    pattern += found ? found[1] : escapeLiteral(tok);
    last = mm.index + tok.length;
  }
  pattern += escapeLiteral(rest.slice(last));

  let re: RegExp;
  try {
    re = new RegExp(pattern, "i");
  } catch {
    return null;
  }
  const m = re.exec(clean(input));
  if (!m || !m.groups) return fromUnknown(input);
  const g = m.groups;
  const year = g.year
    ? Number(g.year)
    : g.year2
      ? 2000 + Number(g.year2)
      : new Date().getFullYear();
  let month = 0;
  if (g.month) month = Number(g.month) - 1;
  else if (g.monthName || g.monthAbbr) {
    const name = (g.monthName ?? g.monthAbbr ?? "").toLowerCase().slice(0, 3);
    month = MONTHS[name] ?? 0;
  }
  const day = g.day ? Number(g.day) : 1;
  let hour = g.hour ? Number(g.hour) : g.hour12 ? Number(g.hour12) : 0;
  if (g.ampm) {
    const pm = /p/i.test(g.ampm);
    if (pm && hour < 12) hour += 12;
    if (!pm && hour === 12) hour = 0;
  }
  const min = g.min ? Number(g.min) : 0;
  const sec = g.sec ? Number(g.sec) : 0;
  const t = Date.UTC(year, month, day, hour, min, sec);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

/** Last-resort parser: native Date, common formats, then timeago. */
export function fromUnknown(input: string): number | null {
  const s = clean(input);
  if (!s) return null;
  const ago = fromTimeAgo(s);
  if (ago !== null) return ago;
  const native = Date.parse(s);
  if (!Number.isNaN(native)) return Math.floor(native / 1000);
  // "12 Jan 2024", "Jan 12 2024", "2024-01-12"
  const dmy = s.match(/(\d{1,2})\s+([A-Za-z]+)\.?\s+(\d{4})/);
  if (dmy) {
    const mo = MONTHS[dmy[2]!.toLowerCase().slice(0, 3)];
    if (mo !== undefined) {
      const t = Date.UTC(Number(dmy[3]), mo, Number(dmy[1]));
      if (Number.isFinite(t)) return Math.floor(t / 1000);
    }
  }
  return null;
}
