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
    "Latest and recently added listings scraped via Firecrawl from 1TamilMV; not an official release calendar. Coverage and mirrors change frequently.",
};

/** Cap retained rows per refresh so Discover stays usable. */
export const TAMILMV_MAX_ITEMS = 250;

/** Listing paths relative to the configured base URL (homepage first). */
export const TAMILMV_LISTING_PATHS = [
  "", // homepage: Week Releases + Topics + embedded recent links
  "index.php?/forums/", // forum index: recently active topics
  "index.php?/discover/", // all activity stream when permitted
] as const;

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
  let value = sanitizeDiscoveryText(rawTitle)
    // URL-slug style titles: hyphens → spaces
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const parenYear = /\((19\d{2}|20\d{2})\)/.exec(value);
  const bareYear = !parenYear
    ? /\b(19\d{2}|20\d{2})\b/.exec(value)
    : undefined;
  const yearMatch = parenYear ?? bareYear;
  const year = yearMatch ? Number(yearMatch[1]) : undefined;

  // Prefer the name before the first year token when present.
  if (yearMatch && yearMatch.index !== undefined && yearMatch.index > 0) {
    value = value.slice(0, yearMatch.index);
  } else {
    const cut = value.search(
      /\b(?:TRUE\s+WEB-?DL|WEB-?DL|WEBRip|HDRip|PreDVD|Blu-?Ray|BLURAY|REMUX|HQ\s+PreDVD|S\d{1,2})\b/i,
    );
    if (cut > 0) value = value.slice(0, cut);
  }

  value = value
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\b(?:Tamil|Telugu|Hindi|Malayalam|Kannada|Eng(?:lish)?|TAM|TEL|HIN|MAL|KAN)\b/gi, " ")
    .replace(/\s*[-|]+\s*$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  value = value.replace(/\s*\((?:19\d{2}|20\d{2})\)\s*$/, "").trim() || value;
  // Drop trailing bare year if still present.
  value = value.replace(/\s+(?:19\d{2}|20\d{2})\s*$/, "").trim() || value;
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

/** Rebuild a release-style title from a topic URL slug when anchor text is empty/noisy. */
export function titleFromTamilmvSlug(url: string): string | undefined {
  try {
    const path = decodeURIComponent(new URL(url).pathname + new URL(url).search);
    const match = /\/topic\/\d+-([^/?#]+)/i.exec(path) ??
      /topic\/\d+-([^/?#&]+)/i.exec(path);
    if (!match?.[1]) return undefined;
    const raw = match[1]
      .replace(/\.+/g, " ")
      .replace(/[-_]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    return raw.length >= 6 ? raw : undefined;
  } catch {
    return undefined;
  }
}

function looksLikeReleaseTitle(value: string): boolean {
  if (value.length < 6) return false;
  if (/^(languages|forums|home|login|register|members)$/i.test(value)) return false;
  // Prefer titles that carry a year, season, or known release token.
  return (
    /\((?:19|20)\d{2}\)/.test(value) ||
    /\b(?:19|20)\d{2}\b/.test(value) ||
    /\bS\d{1,2}\b/i.test(value) ||
    /\b(?:WEB-?DL|WEBRip|Blu-?Ray|BLURAY|PreDVD|HDRip|REMUX)\b/i.test(value)
  );
}

function listedDateNearAnchor(anchor: { closest: (sel: string) => { find: (sel: string) => { first: () => { attr: (name: string) => string | undefined } }; }; parent: () => { parent: () => { find: (sel: string) => { first: () => { attr: (name: string) => string | undefined } } } } }): string | undefined {
  const root = anchor.closest(".ipsDataItem, .ipsStreamItem, li, article");
  const datetime =
    root.find("time[datetime]").first().attr("datetime") ??
    anchor.parent().parent().find("time[datetime]").first().attr("datetime");
  if (!datetime) return undefined;
  return parseDateOnly(datetime.slice(0, 10))?.value;
}

function resolveListingUrls(baseUrl: string, pageLimit: number): string[] {
  const base = new URL(baseUrl);
  // Ensure trailing slash on base for relative resolution of index.php paths.
  if (!base.pathname.endsWith("/")) base.pathname = `${base.pathname}/`;
  const limit = Math.max(1, Math.min(pageLimit, TAMILMV_LISTING_PATHS.length));
  return TAMILMV_LISTING_PATHS.slice(0, limit).map((path) => {
    if (!path) return new URL(baseUrl).href;
    return new URL(path, base).href;
  });
}

export function mergeTamilmvItems(
  batches: readonly TamilmvListItem[],
  maxItems = TAMILMV_MAX_ITEMS,
): TamilmvListItem[] {
  const seen = new Set<string>();
  const merged: TamilmvListItem[] = [];
  for (const item of batches) {
    const key = item.topicId ?? item.sourceUrl ?? `${item.title}\u0000${item.year ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
    if (merged.length >= maxItems) break;
  }
  return merged;
}

/**
 * Parse latest/recent topic rows from a listing page.
 * Prefer prominent title anchors, then other release-looking links, then URL slugs.
 */
export function parseTamilmvLatestHtml(
  html: string,
  baseUrl: string,
  options: { maxItems?: number } = {},
): { items: TamilmvListItem[]; warnings: DiscoveryWarning[] } {
  const maxItems = options.maxItems ?? TAMILMV_MAX_ITEMS;
  const $ = load(html);
  const warnings: DiscoveryWarning[] = [];
  const byTopic = new Map<string, TamilmvListItem & { rank: number }>();
  let rank = 0;

  const consider = (
    rawHref: string | undefined,
    rawText: string,
    listedDate: string | undefined,
    priority: number,
  ): void => {
    const sourceUrl = safeTamilmvLink(rawHref, baseUrl);
    if (!sourceUrl || !/\/topic\/\d{5,}/i.test(sourceUrl)) {
      if (rawHref && safeTamilmvLink(rawHref, baseUrl) === undefined) {
        warnings.push({
          code: "unsafe-link",
          message: "Dropped unsafe TamilMV link",
        });
      }
      return;
    }
    const topicId = topicIdFromUrl(sourceUrl);
    if (!topicId) return;

    let rawTitle = sanitizeDiscoveryText(rawText);
    // "View the topic Foo" title attributes.
    const viewTopic = /^View the topic\s+(.+)$/i.exec(rawTitle);
    if (viewTopic) rawTitle = sanitizeDiscoveryText(viewTopic[1]!);

    if (!looksLikeReleaseTitle(rawTitle)) {
      const fromSlug = titleFromTamilmvSlug(sourceUrl);
      if (fromSlug && looksLikeReleaseTitle(fromSlug)) {
        rawTitle = fromSlug;
      } else if (!looksLikeReleaseTitle(rawTitle)) {
        return;
      }
    }

    const cleaned = cleanTamilmvTitle(rawTitle);
    if (!cleaned.title || cleaned.title.length < 2) return;

    const candidateRank = priority * 1_000_000 + rank;
    const existing = byTopic.get(topicId);
    if (existing) {
      // Keep the higher-priority (lower rank) hit; only upgrade title quality.
      const betterTitle = rawTitle.length > existing.rawTitle.length + 8;
      if (candidateRank >= existing.rank && !betterTitle) {
        if (listedDate && !existing.listedDate) {
          byTopic.set(topicId, { ...existing, listedDate });
        }
        return;
      }
      if (candidateRank >= existing.rank && betterTitle) {
        byTopic.set(topicId, {
          ...existing,
          rawTitle,
          title: cleaned.title,
          ...(cleaned.year ? { year: cleaned.year } : {}),
          mediaType: detectTamilmvMediaType(rawTitle),
          ...(detectTamilmvFormat(rawTitle) ? { formatLabel: detectTamilmvFormat(rawTitle) } : {}),
          audioLanguages: detectTamilmvLanguages(rawTitle),
          ...(listedDate || existing.listedDate
            ? { listedDate: listedDate ?? existing.listedDate }
            : {}),
        });
        return;
      }
    }

    byTopic.set(topicId, {
      rawTitle,
      title: cleaned.title,
      ...(cleaned.year ? { year: cleaned.year } : {}),
      mediaType: detectTamilmvMediaType(rawTitle),
      ...(detectTamilmvFormat(rawTitle) ? { formatLabel: detectTamilmvFormat(rawTitle) } : {}),
      audioLanguages: detectTamilmvLanguages(rawTitle),
      sourceUrl,
      topicId,
      ...(listedDate ? { listedDate } : {}),
      rank: candidateRank,
    });
    rank += 1;
  };

  // 1) Primary listing titles (homepage Week Releases / Topics, forum rows).
  $("a.ipsDataItem_title, .ipsDataItem_title a").each((_, el) => {
    const anchor = $(el);
    consider(
      anchor.attr("href"),
      anchor.text() || anchor.attr("title") || "",
      listedDateNearAnchor(anchor),
      0,
    );
  });

  // 2) Any other topic anchors with release-looking text or title attrs.
  $("a[href*='/forums/topic/'], a[href*='topic/']").each((_, el) => {
    const anchor = $(el);
    const href = anchor.attr("href");
    if (!href || !/topic\/\d{5,}/i.test(href)) return;
    if (anchor.is(".ipsDataItem_title") || anchor.closest(".ipsDataItem_title").length) return;
    const text = anchor.text() || anchor.attr("title") || "";
    consider(href, text, listedDateNearAnchor(anchor), 1);
  });

  // 3) Slug fallback for remaining unique topic URLs embedded in the page.
  const hrefs = new Set<string>();
  $("a[href*='topic/']").each((_, el) => {
    const href = $(el).attr("href");
    if (href) hrefs.add(href);
  });
  // Also scan raw HTML for topic URLs not wrapped as primary anchors.
  for (const match of html.matchAll(/https?:\/\/[^"'<\s]+\/forums\/topic\/\d{5,}-[^"'<\s]*/gi)) {
    hrefs.add(match[0]!);
  }
  for (const match of html.matchAll(/(?:index\.php\?\/)?forums\/topic\/\d{5,}-[^"'<\s]*/gi)) {
    hrefs.add(match[0]!);
  }
  for (const href of hrefs) {
    const sourceUrl = safeTamilmvLink(href, baseUrl);
    if (!sourceUrl) continue;
    const topicId = topicIdFromUrl(sourceUrl);
    if (!topicId || byTopic.has(topicId)) continue;
    const slugTitle = titleFromTamilmvSlug(sourceUrl);
    if (!slugTitle) continue;
    consider(sourceUrl, slugTitle, undefined, 2);
  }

  const items = [...byTopic.values()]
    .sort((left, right) => left.rank - right.rank)
    .slice(0, maxItems)
    .map(({ rank: _rank, ...item }) => item);

  if (items.length === 0) {
    warnings.push({
      code: "empty-listing",
      message: "No TamilMV topic titles found in scraped HTML",
    });
  }
  return { items, warnings };
}

export function buildTamilmvListingUrls(baseUrl: string, pageLimit: number): string[] {
  return resolveListingUrls(baseUrl, pageLimit);
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
      const listingUrls = buildTamilmvListingUrls(baseUrl, request.pageLimit);
      const collected: TamilmvListItem[] = [];
      const warnings: DiscoveryWarning[] = [];

      for (const [index, listingUrl] of listingUrls.entries()) {
        const endpoint = index === 0 ? "scrape:homepage" : `scrape:listing:${index}`;
        const budget = await options.ledger.canSpend("tamilmv", endpoint);
        if (!budget.allowed) {
          if (collected.length === 0) {
            throw new DiscoveryBudgetExceededError(budget);
          }
          warnings.push({
            code: "budget-truncated",
            message: `Stopped after ${collected.length} titles; budget exhausted for further listings`,
          });
          break;
        }

        await options.ledger.recordAttempt("tamilmv", endpoint);

        try {
          const scraped = await scrape({
            apiKey: credential.apiKey,
            url: listingUrl,
            formats: ["html"],
            fetchImpl: fetchOptions.fetchImpl,
            signal: fetchOptions.signal,
            retries: options.retries ?? 1,
            ...(options.sleepImpl ? { sleepImpl: options.sleepImpl } : {}),
          });
          const html = scraped.html ?? "";
          if (!html) {
            warnings.push({
              code: "empty-html",
              message: `Firecrawl returned no HTML for ${listingUrl}`,
            });
            continue;
          }
          const parsed = parseTamilmvLatestHtml(html, baseUrl);
          warnings.push(...parsed.warnings);
          collected.push(...parsed.items);
        } catch (error) {
          if (error instanceof FirecrawlContractError) {
            if (collected.length === 0) {
              throw new TamilmvContractError(error.message);
            }
            warnings.push({ code: "scrape-failed", message: error.message });
            continue;
          }
          if (collected.length === 0) throw error;
          warnings.push({
            code: "scrape-failed",
            message: error instanceof Error ? error.message : "TamilMV scrape failed",
          });
        }
      }

      const items = mergeTamilmvItems(collected, TAMILMV_MAX_ITEMS);
      if (items.length === 0 && warnings.every((warning) => warning.code !== "empty-listing")) {
        warnings.push({
          code: "empty-listing",
          message: "No TamilMV topic titles found across listing pages",
        });
      }

      const observedAt = now();
      const titles: CatalogTitle[] = [];
      const events: ReleaseEvent[] = [];
      const today = indiaToday(observedAt);

      for (const item of items) {
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
