import { promises as fs } from "node:fs";
import { discoveryUsageFile } from "../config/paths";
import { serializeWrites, writeJsonAtomic } from "../util/atomic";
import type { DiscoverySource } from "./types";

export const DISCOVERY_USAGE_VERSION = 1 as const;

export interface SourceBudget {
  softWarning?: number;
  hardCap?: number;
}

/** Fixed conservative policy; callers cannot raise these through configuration. */
export const SOURCE_BUDGETS: Readonly<Partial<Record<DiscoverySource, SourceBudget>>> = {
  "streaming-availability": { softWarning: 350, hardCap: 450 },
  apify: { softWarning: 80, hardCap: 100 },
  // Multi-page listing scrapes (homepage + forums + activity).
  tamilmv: { softWarning: 80, hardCap: 120 },
  trakt: { softWarning: 0, hardCap: 0 },
};

export interface SourceUsage {
  attempts: number;
  endpoints: Record<string, number>;
}

export interface UsageMonth {
  sources: Partial<Record<DiscoverySource, SourceUsage>>;
}

export interface DiscoveryUsageDocument {
  version: typeof DISCOVERY_USAGE_VERSION;
  months: Record<string, UsageMonth>;
}

export interface BudgetStatus {
  source: DiscoverySource;
  endpoint: string;
  month: string;
  used: number;
  endpointUsed: number;
  allowed: boolean;
  warning: boolean;
  softWarning?: number;
  hardCap?: number;
  remaining?: number;
}

export class DiscoveryBudgetExceededError extends Error {
  constructor(readonly status: BudgetStatus) {
    super(`${status.source} request budget exhausted for ${status.month}`);
    this.name = "DiscoveryBudgetExceededError";
  }
}

export interface RequestLedgerOptions {
  file?: string;
  readFile?: (file: string) => Promise<string>;
  writeJson?: (file: string, value: unknown) => Promise<void>;
}

export interface RequestLedger {
  canSpend(source: DiscoverySource, endpoint: string, now?: Date | number): Promise<BudgetStatus>;
  recordAttempt(source: DiscoverySource, endpoint: string, now?: Date | number): Promise<BudgetStatus>;
  flush(): Promise<void>;
}

function emptyUsage(): DiscoveryUsageDocument {
  return { version: DISCOVERY_USAGE_VERSION, months: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseUsage(value: unknown): DiscoveryUsageDocument {
  if (!isRecord(value) || value.version !== DISCOVERY_USAGE_VERSION || !isRecord(value.months)) {
    return emptyUsage();
  }
  const months: Record<string, UsageMonth> = {};
  for (const [month, rawMonth] of Object.entries(value.months)) {
    if (!/^\d{4}-\d{2}$/.test(month) || !isRecord(rawMonth) || !isRecord(rawMonth.sources)) {
      continue;
    }
    const sources: Partial<Record<DiscoverySource, SourceUsage>> = {};
    for (const [source, rawUsage] of Object.entries(rawMonth.sources)) {
      if (!isRecord(rawUsage) || !Number.isInteger(rawUsage.attempts) || Number(rawUsage.attempts) < 0) {
        continue;
      }
      if (!isRecord(rawUsage.endpoints)) continue;
      const endpoints: Record<string, number> = {};
      let valid = true;
      for (const [endpoint, count] of Object.entries(rawUsage.endpoints)) {
        if (!endpoint || !Number.isInteger(count) || Number(count) < 0) {
          valid = false;
          break;
        }
        endpoints[endpoint] = Number(count);
      }
      if (!valid) continue;
      sources[source as DiscoverySource] = {
        attempts: Number(rawUsage.attempts),
        endpoints,
      };
    }
    months[month] = { sources };
  }
  return { version: DISCOVERY_USAGE_VERSION, months };
}

function utcMonth(now: Date | number): string {
  const date = typeof now === "number" ? new Date(now) : now;
  if (!Number.isFinite(date.getTime())) throw new RangeError("now must be a valid date");
  return date.toISOString().slice(0, 7);
}

function isMissingFile(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

export function createRequestLedger(options: RequestLedgerOptions = {}): RequestLedger {
  const file = options.file ?? discoveryUsageFile;
  const readFile = options.readFile ?? ((target: string) => fs.readFile(target, "utf8"));
  const writeJson = options.writeJson ?? ((target, value) =>
    writeJsonAtomic(target, value, { mode: 0o600 }));
  const writes = serializeWrites();

  let document = emptyUsage();
  let loaded: Promise<void> | undefined;
  let dirty = false;
  let pendingWrite: Promise<void> | undefined;

  async function ensureLoaded(): Promise<void> {
    loaded ??= (async () => {
      try {
        const text = await readFile(file);
        try {
          document = parseUsage(JSON.parse(text) as unknown);
        } catch {
          document = emptyUsage();
        }
      } catch (error) {
        if (!isMissingFile(error)) throw error;
      }
    })();
    await loaded;
  }

  function scheduleWrite(): Promise<void> {
    dirty = true;
    if (pendingWrite) return pendingWrite;
    pendingWrite = writes(async () => {
      await Promise.resolve();
      while (dirty) {
        dirty = false;
        try {
          await writeJson(file, structuredClone(document));
        } catch (error) {
          dirty = true;
          throw error;
        }
      }
    }).finally(() => {
      pendingWrite = undefined;
    });
    return pendingWrite;
  }

  function status(source: DiscoverySource, endpoint: string, month: string): BudgetStatus {
    const usage = document.months[month]?.sources[source];
    const used = usage?.attempts ?? 0;
    const endpointUsed = usage?.endpoints[endpoint] ?? 0;
    const budget = SOURCE_BUDGETS[source];
    const allowed = budget?.hardCap === undefined || used < budget.hardCap;
    const warning = budget?.softWarning !== undefined && used >= budget.softWarning;
    return {
      source,
      endpoint,
      month,
      used,
      endpointUsed,
      allowed,
      warning,
      ...(budget?.softWarning !== undefined ? { softWarning: budget.softWarning } : {}),
      ...(budget?.hardCap !== undefined
        ? { hardCap: budget.hardCap, remaining: Math.max(0, budget.hardCap - used) }
        : {}),
    };
  }

  async function canSpend(
    source: DiscoverySource,
    endpoint: string,
    now: Date | number = Date.now(),
  ): Promise<BudgetStatus> {
    await ensureLoaded();
    if (!endpoint.trim()) throw new TypeError("endpoint must be non-empty");
    return status(source, endpoint, utcMonth(now));
  }

  async function recordAttempt(
    source: DiscoverySource,
    endpoint: string,
    now: Date | number = Date.now(),
  ): Promise<BudgetStatus> {
    await ensureLoaded();
    if (!endpoint.trim()) throw new TypeError("endpoint must be non-empty");
    const month = utcMonth(now);
    const before = status(source, endpoint, month);
    if (!before.allowed) throw new DiscoveryBudgetExceededError(before);
    const bucket = (document.months[month] ??= { sources: {} });
    const usage = (bucket.sources[source] ??= { attempts: 0, endpoints: {} });
    usage.attempts += 1;
    usage.endpoints[endpoint] = (usage.endpoints[endpoint] ?? 0) + 1;
    await scheduleWrite();
    return status(source, endpoint, month);
  }

  async function flush(): Promise<void> {
    await ensureLoaded();
    if (dirty && !pendingWrite) await scheduleWrite();
    else if (pendingWrite) await pendingWrite;
    await writes.flush();
  }

  return { canSpend, recordAttempt, flush };
}
