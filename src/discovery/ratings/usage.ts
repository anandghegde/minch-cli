import { promises as fs } from "node:fs";
import { discoveryRatingsUsageFile } from "../../config/paths";
import { serializeWrites, writeJsonAtomic } from "../../util/atomic";

export const RATINGS_USAGE_VERSION = 1 as const;
export const MDBLIST_DAILY_WARNING = 800;
export const MDBLIST_DAILY_CAP = 950;

export interface RatingsUsageDocument {
  version: typeof RATINGS_USAGE_VERSION;
  days: Record<string, { mdblistAttempts: number }>;
}

export interface MdblistUsageStatus {
  day: string;
  used: number;
  allowed: boolean;
  warning: boolean;
  warningAt: number;
  hardCap: number;
  remaining: number;
}

export class MdblistBudgetExceededError extends Error {
  constructor(readonly status: MdblistUsageStatus) {
    super(`MDBList daily request cap reached for ${status.day}`);
    this.name = "MdblistBudgetExceededError";
  }
}

export interface RatingsUsageLedger {
  status(now?: number | Date): Promise<MdblistUsageStatus>;
  recordAttempt(now?: number | Date): Promise<MdblistUsageStatus>;
  flush(): Promise<void>;
}

export interface RatingsUsageLedgerOptions {
  file?: string;
  readFile?: (file: string) => Promise<string>;
  writeJson?: (file: string, value: unknown) => Promise<void>;
}

function utcDay(now: number | Date): string {
  const date = typeof now === "number" ? new Date(now) : now;
  if (!Number.isFinite(date.getTime())) throw new RangeError("now must be a valid date");
  return date.toISOString().slice(0, 10);
}

function empty(): RatingsUsageDocument { return { version: RATINGS_USAGE_VERSION, days: {} }; }
function parse(value: unknown): RatingsUsageDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return empty();
  const raw = value as Record<string, unknown>;
  if (raw.version !== RATINGS_USAGE_VERSION || !raw.days || typeof raw.days !== "object") return empty();
  const days: RatingsUsageDocument["days"] = {};
  for (const [day, entry] of Object.entries(raw.days as Record<string, unknown>)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !entry || typeof entry !== "object") continue;
    const attempts = (entry as Record<string, unknown>).mdblistAttempts;
    if (Number.isInteger(attempts) && Number(attempts) >= 0) days[day] = { mdblistAttempts: Number(attempts) };
  }
  return { version: RATINGS_USAGE_VERSION, days };
}

export function createRatingsUsageLedger(
  options: RatingsUsageLedgerOptions = {},
): RatingsUsageLedger {
  const file = options.file ?? discoveryRatingsUsageFile;
  const readFile = options.readFile ?? ((target) => fs.readFile(target, "utf8"));
  const writeJson = options.writeJson ?? ((target, value) => writeJsonAtomic(target, value, { mode: 0o600 }));
  const writes = serializeWrites();
  let document = empty();
  let loaded: Promise<void> | undefined;
  let pending: Promise<void> | undefined;

  async function load() {
    loaded ??= (async () => {
      try { document = parse(JSON.parse(await readFile(file)) as unknown); }
      catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT") &&
            !(error instanceof SyntaxError)) throw error;
      }
    })();
    await loaded;
  }
  function makeStatus(day: string): MdblistUsageStatus {
    const used = document.days[day]?.mdblistAttempts ?? 0;
    return { day, used, allowed: used < MDBLIST_DAILY_CAP,
      warning: used >= MDBLIST_DAILY_WARNING, warningAt: MDBLIST_DAILY_WARNING,
      hardCap: MDBLIST_DAILY_CAP, remaining: Math.max(0, MDBLIST_DAILY_CAP - used) };
  }
  async function status(now: number | Date = Date.now()) { await load(); return makeStatus(utcDay(now)); }
  async function recordAttempt(now: number | Date = Date.now()) {
    await load();
    const day = utcDay(now);
    const before = makeStatus(day);
    if (!before.allowed) throw new MdblistBudgetExceededError(before);
    (document.days[day] ??= { mdblistAttempts: 0 }).mdblistAttempts += 1;
    pending = writes(() => writeJson(file, structuredClone(document))).finally(() => { pending = undefined; });
    await pending;
    return makeStatus(day);
  }
  return { status, recordAttempt, async flush() { await load(); if (pending) await pending; await writes.flush(); } };
}
