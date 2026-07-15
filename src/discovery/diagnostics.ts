import {
  createRequestLedger,
  type BudgetStatus,
  type RequestLedger,
} from "./budget";
import type { DiscoverySource } from "./types";
import { IMDB_REQUIRED_NOTICE } from "./attribution";
import type { Config } from "../config/config";
import { createRatingsCacheRepository } from "./ratings/cache-repository";
import type { RatingsCacheRepository } from "./ratings/cache-repository";
import { createRatingsUsageLedger, type RatingsUsageLedger } from "./ratings/usage";

const SOURCES: readonly { source: DiscoverySource; label: string }[] = [
  { source: "tmdb", label: "TMDB" },
  { source: "bluray", label: "Blu-ray.com RSS" },
  { source: "streaming-availability", label: "Streaming Availability" },
  { source: "apify", label: "Apify" },
  { source: "tamilmv", label: "1TamilMV (Firecrawl)" },
  { source: "trakt", label: "Trakt" },
];

export interface DiscoveryUsageLine {
  source: DiscoverySource;
  label: string;
  used: number;
  allowed: boolean;
  warning: boolean;
  softWarning?: number;
  hardCap?: number;
  remaining?: number;
}

export interface DiscoveryUsageReport {
  month: string;
  lines: DiscoveryUsageLine[];
}

function line(
  source: DiscoverySource,
  label: string,
  status: BudgetStatus,
): DiscoveryUsageLine {
  return {
    source,
    label,
    used: status.used,
    allowed: status.allowed,
    warning: status.warning,
    ...(status.softWarning !== undefined ? { softWarning: status.softWarning } : {}),
    ...(status.hardCap !== undefined ? { hardCap: status.hardCap } : {}),
    ...(status.remaining !== undefined ? { remaining: status.remaining } : {}),
  };
}

/** Read-only local counters; this never records an attempt or resolves credentials. */
export async function readDiscoveryUsageReport(
  requestLedger: Pick<RequestLedger, "canSpend"> = createRequestLedger(),
  now: Date | number = Date.now(),
): Promise<DiscoveryUsageReport> {
  const statuses = await Promise.all(SOURCES.map(async ({ source, label }) => ({
    source,
    label,
    status: await requestLedger.canSpend(source, "diagnostic", now),
  })));
  return {
    month: statuses[0]!.status.month,
    lines: statuses.map(({ source, label, status }) => line(source, label, status)),
  };
}

export function formatDiscoveryUsageReport(report: DiscoveryUsageReport): string {
  const rows = report.lines.map((item) => {
    const usage = item.hardCap === undefined
      ? `${item.used}/unlimited`
      : `${item.used}/${item.hardCap}`;
    const detail = item.hardCap === 0
      ? "disabled by policy"
      : item.hardCap === undefined
        ? "no local hard cap"
        : `${item.remaining ?? Math.max(0, item.hardCap - item.used)} remaining` +
          (item.softWarning !== undefined ? ` · warning at ${item.softWarning}` : "") +
          (item.warning ? " · warning reached" : "");
    return `${item.label.padEnd(25)} ${usage.padEnd(15)} ${detail}`;
  });
  return [
    `Discovery request usage · ${report.month} UTC · local only`,
    ...rows,
  ].join("\n");
}

export interface DiscoveryRatingsDiagnostics {
  provider: "off" | "imdb-dataset" | "mdblist";
  datasetChecked?: number;
  datasetRevision?: string;
  cachedExactRatings: number;
  cachedUnresolvedIdentities: number;
  mdblistCallsToday: number;
  mdblistDailyCap: number;
}

export async function readDiscoveryRatingsDiagnostics(
  config: Config,
  now: number | Date = Date.now(),
  dependencies: {
    repository?: Pick<RatingsCacheRepository, "snapshot">;
    usage?: Pick<RatingsUsageLedger, "status">;
  } = {},
): Promise<DiscoveryRatingsDiagnostics> {
  const repository = dependencies.repository ?? createRatingsCacheRepository();
  const usageLedger = dependencies.usage ?? createRatingsUsageLedger();
  const [document, usage] = await Promise.all([
    repository.snapshot(),
    usageLedger.status(now),
  ]);
  return {
    provider: config.discovery?.ratingProvider ?? "off",
    ...(document.dataset.checkedAt !== undefined ? { datasetChecked: document.dataset.checkedAt } : {}),
    ...(document.dataset.etag
      ? { datasetRevision: document.dataset.etag.replace(/^W\//, "").replace(/"/g, "").slice(0, 12) }
      : {}),
    cachedExactRatings: Object.values(document.ratings)
      .filter((entry) => entry.rating.system === "imdb").length,
    cachedUnresolvedIdentities: Object.values(document.identities)
      .filter((entry) => entry.unresolved === true).length,
    mdblistCallsToday: usage.used,
    mdblistDailyCap: usage.hardCap,
  };
}

function age(timestamp: number | undefined, now = Date.now()): string {
  if (timestamp === undefined) return "never";
  const hours = Math.max(0, Math.floor((now - timestamp) / 3_600_000));
  return hours < 1 ? "less than 1h ago" : `${hours}h ago`;
}

export function formatDiscoveryRatingsDiagnostics(
  report: DiscoveryRatingsDiagnostics,
  now = Date.now(),
): string {
  const provider = report.provider === "imdb-dataset" ? "IMDb dataset"
    : report.provider === "mdblist" ? "MDBList" : "Off (fallback ratings only)";
  return [
    "Ratings",
    `  Provider: ${provider}`,
    `  Dataset checked: ${age(report.datasetChecked, now)}`,
    `  Dataset revision: ${report.datasetRevision ?? "none"}`,
    `  Cached exact ratings: ${report.cachedExactRatings}`,
    `  Cached unresolved identities: ${report.cachedUnresolvedIdentities}`,
    `  Attribution: ${IMDB_REQUIRED_NOTICE}`,
    "",
    "MDBList",
    `  Calls today: ${report.mdblistCallsToday} / ${report.mdblistDailyCap} local safety cap`,
  ].join("\n");
}
