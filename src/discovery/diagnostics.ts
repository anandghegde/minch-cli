import {
  createRequestLedger,
  type BudgetStatus,
  type RequestLedger,
} from "./budget";
import type { DiscoverySource } from "./types";

const SOURCES: readonly { source: DiscoverySource; label: string }[] = [
  { source: "tmdb", label: "TMDB" },
  { source: "bluray", label: "Blu-ray.com RSS" },
  { source: "streaming-availability", label: "Streaming Availability" },
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
