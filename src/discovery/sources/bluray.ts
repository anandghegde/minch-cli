import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { load } from "cheerio";
import type { Config } from "../../config/config";
import type {
  DiscoveryAdapter,
  DiscoveryAttribution,
  DiscoverySnapshot,
  DiscoveryWarning,
} from "../adapter";
import type { RequestLedger } from "../budget";
import { isDiscoveryAdapterEnabled } from "../config";
import { indiaToday, parseDateOnly, statusForDate } from "../dates";
import { validateDiscoveryRequest } from "../request";
import { UNKNOWN_REGION, type CatalogTitle, type ReleaseEvent, type ReleaseKind } from "../types";
import {
  disposeResponse,
  fetchResilient,
  HttpError,
  USER_AGENT,
  type FetchImpl,
  type SleepImpl,
} from "../../util/net";
import { cleanText } from "../../util/format";
import { normalizeIdentityTitle } from "../normalize";

export const BLURAY_RSS_URL = "https://www.blu-ray.com/rss/newreleasesfeed.xml";

export const BLURAY_ATTRIBUTION: DiscoveryAttribution = {
  source: "bluray",
  sourceLabel: "Blu-ray.com",
  sourceUrl: "https://www.blu-ray.com",
  notice: "Release dates and links supplied by Blu-ray.com.",
};

const rssParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

interface BlurayRssItem {
  title: string;
  link?: string;
  guid?: string;
  pubDate?: string;
  category?: string;
  studio?: string;
  year?: number;
  description?: string;
  tmdbId?: number;
  imdbId?: string;
}

export class BlurayContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlurayContractError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number") {
    const cleaned = String(value).trim();
    return cleaned || undefined;
  }
  return undefined;
}

export function sanitizeBlurayText(value: string): string {
  const withoutAnsi = value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  return cleanText(load(withoutAnsi).text());
}

function safeLink(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      (url.hostname === "blu-ray.com" || url.hostname.endsWith(".blu-ray.com"))
    ) {
      return url.href;
    }
  } catch {
    // Invalid/unsafe links are omitted but the item remains usable.
  }
  return undefined;
}

export function parseBlurayRss(xml: string): {
  items: BlurayRssItem[];
  warnings: DiscoveryWarning[];
} {
  let document: unknown;
  try {
    document = rssParser.parse(xml) as unknown;
  } catch {
    throw new BlurayContractError("Blu-ray RSS is not valid XML");
  }
  if (!isRecord(document) || !isRecord(document.rss) || !isRecord(document.rss.channel)) {
    throw new BlurayContractError("Blu-ray RSS channel is missing");
  }
  const rawItems = Array.isArray(document.rss.channel.item)
    ? document.rss.channel.item
    : document.rss.channel.item
      ? [document.rss.channel.item]
      : [];
  const items: BlurayRssItem[] = [];
  const warnings: DiscoveryWarning[] = [];
  for (const [index, raw] of rawItems.entries()) {
    const rawTitle = isRecord(raw) ? text(raw.title) : undefined;
    const title = rawTitle ? sanitizeBlurayText(rawTitle) : "";
    if (!isRecord(raw) || !title) {
      warnings.push({ code: "malformed-item", message: `Skipped malformed Blu-ray RSS item ${index}` });
      continue;
    }
    const rawLink = text(raw.link);
    const link = safeLink(rawLink);
    if (rawLink && !link) {
      warnings.push({ code: "unsafe-link", message: `Dropped unsafe Blu-ray RSS link ${index}` });
    }
    const guidText = text(raw.guid);
    const guid = guidText ? sanitizeBlurayText(guidText) : undefined;
    const pubDate = text(raw.pubDate);
    const categoryText = text(raw.category);
    const category = categoryText ? sanitizeBlurayText(categoryText) : undefined;
    const studioText = text(raw.studio);
    const studio = studioText ? sanitizeBlurayText(studioText) : undefined;
    const descriptionText = text(raw.description);
    const description = descriptionText ? sanitizeBlurayText(descriptionText) : undefined;
    const yearValue = Number(raw.year);
    const tmdbIdValue = Number(raw.tmdbId);
    const imdbId = text(raw.imdbId);
    items.push({
      title,
      ...(link ? { link } : {}),
      ...(guid ? { guid } : {}),
      ...(pubDate ? { pubDate } : {}),
      ...(category ? { category } : {}),
      ...(studio ? { studio } : {}),
      ...(description ? { description } : {}),
      ...(Number.isInteger(yearValue) && yearValue > 1800 ? { year: yearValue } : {}),
      ...(Number.isInteger(tmdbIdValue) && tmdbIdValue > 0 ? { tmdbId: tmdbIdValue } : {}),
      ...(imdbId && /^tt\d+$/.test(imdbId) ? { imdbId } : {}),
    });
  }
  return { items, warnings };
}

const MONTHS: Record<string, number> = {
  Jan: 1,
  Feb: 2,
  Mar: 3,
  Apr: 4,
  May: 5,
  Jun: 6,
  Jul: 7,
  Aug: 8,
  Sep: 9,
  Oct: 10,
  Nov: 11,
  Dec: 12,
};

/** Preserve the advertised RFC calendar day instead of timezone-shifting it. */
export function blurayCalendarDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^(?:[A-Za-z]{3},\s+)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\b/.exec(value.trim());
  if (!match) return undefined;
  const month = MONTHS[match[2]!];
  if (!month) return undefined;
  const date = `${match[3]}-${String(month).padStart(2, "0")}-${String(Number(match[1])).padStart(2, "0")}`;
  return parseDateOnly(date)?.value;
}

function formatFor(item: BlurayRssItem): { kind: ReleaseKind; label: string } {
  const title = item.title.toLowerCase();
  const category = item.category?.toLowerCase() ?? "";
  if (/\b4k\b|\buhd\b/.test(title)) return { kind: "uhd_bluray", label: "4K UHD Blu-ray" };
  if (title.includes("blu-ray") || category.includes("blu-ray")) {
    return { kind: "bluray", label: "Blu-ray" };
  }
  return { kind: "physical", label: "Physical" };
}

function baseTitle(value: string): { title: string; year?: number } {
  const embeddedYear = /\((19\d{2}|20\d{2})\)/.exec(value);
  const title = value
    .replace(/\s*\(Blu-ray\)\s*$/i, "")
    .replace(/\s+(?:4K|UHD)\s*$/i, "")
    .replace(/\s*\((?:19\d{2}|20\d{2})\)\s*$/, "")
    .trim();
  return {
    title: title || value.trim(),
    ...(embeddedYear ? { year: Number(embeddedYear[1]) } : {}),
  };
}

function localSourceId(item: BlurayRssItem, date: string | undefined, format: string): string {
  if (item.guid) return item.guid;
  if (item.link) return item.link;
  return `local:${createHash("sha256")
    .update(`${item.title}\u0000${date ?? ""}\u0000${format}`)
    .digest("hex")
    .slice(0, 20)}`;
}

export interface BlurayAdapterOptions {
  ledger: Pick<RequestLedger, "recordAttempt">;
  config?: Config;
  now?: () => number;
  retries?: number;
  sleepImpl?: SleepImpl;
}

export function createBlurayAdapter(options: BlurayAdapterOptions): DiscoveryAdapter {
  const now = options.now ?? Date.now;
  return {
    id: "bluray",
    label: "Blu-ray.com RSS",
    capabilities: {
      features: ["bluray"],
      mediaTypes: ["movie"],
      regions: [],
    },
    isEnabled: () =>
      !options.config || isDiscoveryAdapterEnabled(options.config, "bluray"),
    isConfigured: () =>
      !options.config || isDiscoveryAdapterEnabled(options.config, "bluray"),
    fetch: async (request, fetchOptions) => {
      validateDiscoveryRequest(request);
      if (options.config && !isDiscoveryAdapterEnabled(options.config, "bluray")) {
        throw new HttpError(403, "Blu-ray discovery adapter is disabled");
      }
      if (request.feedKind !== "bluray") {
        throw new BlurayContractError(`Blu-ray.com does not support ${request.feedKind} feeds`);
      }
      if (request.region !== UNKNOWN_REGION) {
        throw new BlurayContractError("Blu-ray RSS region must remain unknown (ZZ)");
      }
      const meteredFetch: FetchImpl = async (url, init) => {
        await options.ledger.recordAttempt("bluray", "rss");
        return fetchOptions.fetchImpl(url, init);
      };
      const response = await fetchResilient(BLURAY_RSS_URL, {
        fetchImpl: meteredFetch,
        retries: options.retries ?? 1,
        ...(options.sleepImpl ? { sleepImpl: options.sleepImpl } : {}),
        signal: fetchOptions.signal,
        headers: { accept: "application/rss+xml, application/xml, text/xml", "user-agent": USER_AGENT },
      });
      if (!response.ok) {
        await disposeResponse(response);
        throw new HttpError(response.status, `Blu-ray RSS failed (HTTP ${response.status})`);
      }
      const parsed = parseBlurayRss(await response.text());
      const observedAt = now();
      const titles: CatalogTitle[] = [];
      const events: ReleaseEvent[] = [];
      const warnings = [...parsed.warnings];
      const seenItems = new Set<string>();
      for (const item of parsed.items) {
        const date = blurayCalendarDate(item.pubDate);
        if (item.pubDate && !date) {
          warnings.push({
            code: "invalid-date",
            message: "Retained Blu-ray RSS item with an unknown date",
            sourceRecordId: item.guid ?? item.link,
          });
        }
        const format = formatFor(item);
        const sourceId = localSourceId(item, date, format.label);
        const duplicateKey = `${sourceId}\u0000${date ?? ""}\u0000${format.kind}`;
        if (seenItems.has(duplicateKey)) {
          warnings.push({
            code: "duplicate-item",
            message: "Skipped duplicate Blu-ray RSS item",
            sourceRecordId: sourceId,
          });
          continue;
        }
        seenItems.add(duplicateKey);
        const normalized = baseTitle(item.title);
        const titleId = `bluray:${createHash("sha256").update(sourceId).digest("hex").slice(0, 20)}`;
        titles.push({
          id: titleId,
          title: normalized.title,
          ...(item.year ?? normalized.year ? { year: item.year ?? normalized.year } : {}),
          mediaType: "movie",
          ...(item.tmdbId ? { tmdbId: item.tmdbId } : {}),
          ...(item.imdbId ? { imdbId: item.imdbId } : {}),
          originCountries: [],
          genreIds: [],
        });
        events.push({
          id: `${titleId}:ZZ:${format.kind}:${date ?? "unknown"}`,
          titleId,
          kind: format.kind,
          region: UNKNOWN_REGION,
          ...(date ? { date } : {}),
          datePrecision: date ? "day" : "unknown",
          formatLabel: format.label,
          status: statusForDate(date, indiaToday(observedAt)),
          firstObservedAt: observedAt,
          lastObservedAt: observedAt,
          evidence: [{
            source: "bluray",
            sourceId,
            ...(item.link ? { sourceUrl: item.link } : {}),
            observedAt,
            confidence: "source_claim",
          }],
        });
      }
      return {
        source: "bluray",
        feedKind: request.feedKind,
        titles,
        events,
        fetchedAt: observedAt,
        warnings,
        attribution: BLURAY_ATTRIBUTION,
      } satisfies DiscoverySnapshot;
    },
  };
}

export function normalizeBlurayIdentityTitle(value: string): string {
  return normalizeIdentityTitle(value);
}

/**
 * Enrich RSS titles only from already-cached TMDB candidates. Exact year and a
 * unique normalized-title match are mandatory; this function performs no I/O.
 */
export function enrichBlurayIdentities(
  snapshot: DiscoverySnapshot,
  cachedTmdbTitles: CatalogTitle[],
): DiscoverySnapshot {
  if (snapshot.source !== "bluray") return snapshot;
  const warnings = [...snapshot.warnings];
  const titles = snapshot.titles.map((title) => {
    if (title.tmdbId || title.imdbId || title.year === undefined) return title;
    const normalized = normalizeBlurayIdentityTitle(title.title);
    const matches = cachedTmdbTitles.filter((candidate) =>
      candidate.mediaType === "movie" &&
      candidate.year === title.year &&
      normalizeBlurayIdentityTitle(candidate.title) === normalized);
    const identities = new Map(
      matches
        .filter((candidate) => candidate.tmdbId !== undefined || candidate.imdbId !== undefined)
        .map((candidate) => [`${candidate.tmdbId ?? ""}:${candidate.imdbId ?? ""}`, candidate]),
    );
    if (identities.size !== 1) {
      if (identities.size > 1) {
        warnings.push({
          code: "ambiguous-identity",
          message: "Left Blu-ray title unmatched because cached TMDB candidates are ambiguous",
          sourceRecordId: title.id,
        });
      }
      return title;
    }
    const match = [...identities.values()][0]!;
    return {
      ...title,
      ...(match.tmdbId ? { tmdbId: match.tmdbId } : {}),
      ...(match.imdbId ? { imdbId: match.imdbId } : {}),
      ...(title.originalTitle ? {} : match.originalTitle ? { originalTitle: match.originalTitle } : {}),
      ...(title.originalLanguage ? {} : match.originalLanguage ? { originalLanguage: match.originalLanguage } : {}),
      originCountries: title.originCountries.length > 0
        ? title.originCountries
        : [...match.originCountries],
      genreIds: title.genreIds.length > 0 ? title.genreIds : [...match.genreIds],
      ...(title.posterUrl ? {} : match.posterUrl ? { posterUrl: match.posterUrl } : {}),
      ...(title.popularity !== undefined
        ? {}
        : match.popularity !== undefined
          ? { popularity: match.popularity }
          : {}),
    };
  });
  return { ...snapshot, titles, warnings };
}
