import { createHash } from "node:crypto";
import { load } from "cheerio";
import type { Config } from "../../config/config";
import type {
  DiscoveryAdapter,
  DiscoveryAttribution,
  DiscoverySnapshot,
  DiscoveryWarning,
} from "../adapter";
import { DiscoveryBudgetExceededError, type RequestLedger } from "../budget";
import {
  isDiscoveryAdapterEnabled,
  resolveFirecrawlCredential,
  resolveTamilmvBaseUrl,
} from "../config";
import { indiaToday, parseDateOnly, statusForDate } from "../dates";
import { validateDiscoveryRequest } from "../request";
import { sanitizeDiscoverySnapshot, sanitizeDiscoveryText } from "../security";
import type { CatalogTitle, MediaType, ReleaseEvent } from "../types";
import { HttpError, type SleepImpl } from "../../util/net";
import { firecrawlScrape, FirecrawlContractError } from "./firecrawl";

export const TAMILMV_ATTRIBUTION: DiscoveryAttribution = {
  source: "tamilmv",
  sourceLabel: "1TamilMV",
  sourceUrl: "https://www.1tamilmv.reisen/",
  notice:
    "Latest listing scraped via Firecrawl from 1TamilMV; not an official release calendar. Coverage and mirrors change frequently.",
};

export class TamilmvContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TamilmvContractError";
  }
}

export interface TamilmvListItem {
  rawTitle: string;
  title: string;
  year?: number;
  mediaType: MediaType;
  formatLabel?: string;
  audioLanguages: string[];
  sourceUrl?: string;
  topicId?: string;
  listedDate?: string;
}

const LANGUAGE_TOKENS: ReadonlyArray<{ pattern: RegExp; code: string }> = [
  { pattern: /\btamil\b/i, code: "ta" },
  { pattern: /\btelugu\b/i, code: "te" },
  { pattern: /\bhindi\b/i, code: "hi" },
  { pattern: /\bmalayalam\b/i, code: "ml" },
  { pattern: /\bkannada\b/i, code: "kn" },
  { pattern: /\b(?:eng(?:lish)?)\b/i, code: "en" },
];

const FORMAT_PATTERNS: ReadonlyArray<{ pattern: RegExp; label: string }> = [
  { pattern: /\bTRUE\s+WEB-?DL\b/i, label: "TRUE WEB-DL" },
  { pattern: /\bWEB-?DL\b/i, label: "WEB-DL" },
  { pattern: /\bWEBRip\b/i, label: "WEBRip" },
  { pattern: /\bHDRip\b/i, label: "HDRip" },
  { pattern: /\bPreDVD\b/i, label: "PreDVD" },
  { pattern: /\b(?:Blu-?Ray|BLURAY)\b/i, label: "BluRay" },
  { pattern: /\bREMUX\b/i, label: "Remux" },
  { pattern: /\bHQ\b/i, label: "HQ" },
];

function hostAllowed(hostname: string, allowedHost: string): boolean {
  const host = hostname.toLowerCase();
  const allowed = allowedHost.toLowerCase();
  return host === allowed || host === `www.${allowed}` || allowed === `www.${host}` ||
    host.endsWith(`.${allowed.replace(/^www\./, "")}`);
}

export function safeTamilmvLink(
  value: string | undefined,
  baseUrl: string,
): string | undefined {
  if (!value) return undefined;
  try {
    const base = new URL(baseUrl);
    const url = new URL(value, base);
    if (url.protocol !== "https:") return undefined;
    if (!hostAllowed(url.hostname, base.hostname)) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export function detectTamilmvMediaType(rawTitle: string): MediaType {
  if (/\bS\d{1,2}\b/i.test(rawTitle) || /\bEP\b/i.test(rawTitle) || /\bCOMPLETE\b/i.test(rawTitle)) {
    return "series";
  }
  return "movie";
}

export function detectTamilmvFormat(rawTitle: string): string | undefined {
  for (const entry of FORMAT_PATTERNS) {
    if (entry.pattern.test(rawTitle)) return entry.label;
  }
  return undefined;
}

export function detectTamilmvLanguages(rawTitle: string): string[] {
  const codes: string[] = [];
  for (const entry of LANGUAGE_TOKENS) {
    if (entry.pattern.test(rawTitle) && !codes.includes(entry.code)) codes.push(entry.code);
  }
  return codes;
}

/** Strip quality / audio / size noise for search handoff and display. */
export function cleanTamilmvTitle(rawTitle: string): { title: string; year?: number } {
  let value = sanitizeDiscoveryText(rawTitle);
  const yearMatch = /\((19\d{2}|20\d{2})\)/.exec(value);
  const year = yearMatch ? Number(yearMatch[1]) : undefined;

  // Prefer the name before the first year parentheses when present.
  if (yearMatch && yearMatch.index !== undefined && yearMatch.index > 0) {
    value = value.slice(0, yearMatch.index);
  } else {
    const cut = value.search(
      /\b(?:TRUE\s+WEB-?DL|WEB-?DL|WEBRip|HDRip|PreDVD|Blu-?Ray|BLURAY|REMUX|HQ\s+PreDVD)\b/i,
    );
    if (cut > 0) value = value.slice(0, cut);
  }

  value = value
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\b(?:Tamil|Telugu|Hindi|Malayalam|Kannada|Eng(?:lish)?)\b/gi, " ")
    .replace(/\s*[-|]+\s*$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  value = value.replace(/\s*\((?:19\d{2}|20\d{2})\)\s*$/, "").trim() || value;
  if (!value) value = sanitizeDiscoveryText(rawTitle).slice(0, 80);

  return {
    title: value,
    ...(year ? { year } : {}),
  };
}

function topicIdFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const match = /\/topic\/(\d+)(?:-|$)/i.exec(url);
  return match?.[1];
}

export function parseTamilmvLatestHtml(
  html: string,
  baseUrl: string,
): { items: TamilmvListItem[]; warnings: DiscoveryWarning[] } {
  const $ = load(html);
  const items: TamilmvListItem[] = [];
  const warnings: DiscoveryWarning[] = [];
  const seen = new Set<string>();

  $("a.ipsDataItem_title, .ipsDataItem_title a").each((index, el) => {
    const anchor = $(el);
    const rawHref = anchor.attr("href");
    const rawTitle = sanitizeDiscoveryText(anchor.text() || anchor.attr("title") || "");
    if (!rawTitle) {
      warnings.push({
        code: "malformed-item",
        message: `Skipped empty TamilMV title at index ${index}`,
      });
      return;
    }
    const sourceUrl = safeTamilmvLink(rawHref, baseUrl);
    // Real release topics use long numeric ids; short sticky/chrome topics are dropped.
    if (!sourceUrl || !/\/topic\/\d{5,}/i.test(sourceUrl)) {
      if (rawHref) {
        warnings.push({
          code: sourceUrl ? "chrome-link" : "unsafe-link",
          message: `Skipped non-topic or unsafe TamilMV link at index ${index}`,
        });
      }
      return;
    }
    const cleaned = cleanTamilmvTitle(rawTitle);
    const topicId = topicIdFromUrl(sourceUrl);
    const dedupeKey = topicId ?? `${cleaned.title}\u0000${cleaned.year ?? ""}\u0000${rawTitle}`;
    if (seen.has(dedupeKey)) {
      warnings.push({
        code: "duplicate-item",
        message: "Skipped duplicate TamilMV listing item",
        sourceRecordId: topicId ?? cleaned.title,
      });
      return;
    }
    seen.add(dedupeKey);
    const root = anchor.closest(".ipsDataItem");
    const datetime =
      root.find("time[datetime]").first().attr("datetime") ??
      anchor.parent().parent().find("time[datetime]").first().attr("datetime");
    const listedDate = datetime ? parseDateOnly(datetime.slice(0, 10))?.value : undefined;
    const formatLabel = detectTamilmvFormat(rawTitle);
    const audioLanguages = detectTamilmvLanguages(rawTitle);
    items.push({
      rawTitle,
      title: cleaned.title,
      ...(cleaned.year ? { year: cleaned.year } : {}),
      mediaType: detectTamilmvMediaType(rawTitle),
      ...(formatLabel ? { formatLabel } : {}),
      audioLanguages,
      sourceUrl,
      ...(topicId ? { topicId } : {}),
      ...(listedDate ? { listedDate } : {}),
    });
  });

  if (items.length === 0) {
    warnings.push({
      code: "empty-listing",
      message: "No TamilMV topic titles found in scraped HTML",
    });
  }
  return { items, warnings };
}

function localSourceId(item: TamilmvListItem): string {
  if (item.topicId) return item.topicId;
  if (item.sourceUrl) return item.sourceUrl;
  return createHash("sha256")
    .update(`${item.rawTitle}\u0000${item.listedDate ?? ""}`)
    .digest("hex")
    .slice(0, 20);
}

export interface TamilmvAdapterOptions {
  ledger: Pick<RequestLedger, "recordAttempt" | "canSpend">;
  config: Config;
  now?: () => number;
  retries?: number;
  sleepImpl?: SleepImpl;
  /** Injected scrape for offline tests; defaults to Firecrawl. */
  scrapeImpl?: typeof firecrawlScrape;
  /** Dependency injection for credential resolution in tests. */
  env?: Record<string, string | undefined>;
}

export function createTamilmvAdapter(options: TamilmvAdapterOptions): DiscoveryAdapter {
  const now = options.now ?? Date.now;
  const scrape = options.scrapeImpl ?? firecrawlScrape;
  const env = options.env;

  return {
    id: "tamilmv",
    label: "1TamilMV",
    capabilities: {
      features: ["tamilmv_latest"],
      mediaTypes: ["movie", "series"],
      regions: ["IN"],
    },
    isEnabled: () => isDiscoveryAdapterEnabled(options.config, "tamilmv"),
    isConfigured: () => !!resolveFirecrawlCredential(options.config, env ?? process.env).apiKey,
    fetch: async (request, fetchOptions) => {
      validateDiscoveryRequest(request);
      if (!isDiscoveryAdapterEnabled(options.config, "tamilmv")) {
        throw new HttpError(403, "TamilMV discovery adapter is disabled");
      }
      if (request.feedKind !== "tamilmv_latest") {
        throw new TamilmvContractError(`1TamilMV does not support ${request.feedKind} feeds`);
      }
      if (request.region !== "IN") {
        throw new TamilmvContractError("1TamilMV latest feed is scoped to region IN");
      }
      const credential = resolveFirecrawlCredential(options.config, env ?? process.env);
      if (!credential.apiKey) {
        throw new HttpError(401, "Firecrawl API key is not configured");
      }
      const baseUrl = resolveTamilmvBaseUrl(options.config);
      const budget = await options.ledger.canSpend("tamilmv", "scrape:homepage");
      if (!budget.allowed) {
        throw new DiscoveryBudgetExceededError(budget);
      }

      await options.ledger.recordAttempt("tamilmv", "scrape:homepage");

      let html: string;
      try {
        const scraped = await scrape({
          apiKey: credential.apiKey,
          url: baseUrl,
          formats: ["html"],
          fetchImpl: fetchOptions.fetchImpl,
          signal: fetchOptions.signal,
          retries: options.retries ?? 1,
          ...(options.sleepImpl ? { sleepImpl: options.sleepImpl } : {}),
        });
        html = scraped.html ?? "";
        if (!html) {
          throw new FirecrawlContractError("Firecrawl returned no HTML for TamilMV homepage");
        }
      } catch (error) {
        if (error instanceof FirecrawlContractError) {
          throw new TamilmvContractError(error.message);
        }
        throw error;
      }

      const parsed = parseTamilmvLatestHtml(html, baseUrl);
      const observedAt = now();
      const titles: CatalogTitle[] = [];
      const events: ReleaseEvent[] = [];
      const warnings = [...parsed.warnings];
      const today = indiaToday(observedAt);

      for (const item of parsed.items) {
        const sourceId = localSourceId(item);
        const titleId = `tamilmv:${createHash("sha256").update(sourceId).digest("hex").slice(0, 20)}`;
        const originalLanguage =
          item.audioLanguages.length === 1 ? item.audioLanguages[0] : undefined;
        titles.push({
          id: titleId,
          title: item.title,
          ...(item.year ? { year: item.year } : {}),
          mediaType: item.mediaType,
          ...(originalLanguage ? { originalLanguage } : {}),
          originCountries: ["IN"],
          genreIds: [],
        });
        const date = item.listedDate;
        events.push({
          id: `${titleId}:IN:digital:${date ?? "unknown"}`,
          titleId,
          kind: "digital",
          region: "IN",
          ...(date ? { date } : {}),
          datePrecision: date ? "day" : "unknown",
          ...(item.formatLabel ? { formatLabel: item.formatLabel } : {}),
          ...(item.audioLanguages.length > 0 ? { audioLanguages: item.audioLanguages } : {}),
          status: statusForDate(date, today),
          firstObservedAt: observedAt,
          lastObservedAt: observedAt,
          evidence: [{
            source: "tamilmv",
            sourceId,
            ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}),
            observedAt,
            confidence: "source_claim",
          }],
        });
      }

      const snapshot: DiscoverySnapshot = {
        source: "tamilmv",
        feedKind: request.feedKind,
        titles,
        events,
        fetchedAt: observedAt,
        warnings,
        attribution: {
          ...TAMILMV_ATTRIBUTION,
          sourceUrl: baseUrl,
        },
      };
      return sanitizeDiscoverySnapshot(snapshot, [credential.apiKey]);
    },
  };
}
