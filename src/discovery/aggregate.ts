import type { DiscoverySnapshot } from "./adapter";
import { isWithinDateRange } from "./dates";
import {
  LANGUAGE_LABELS,
  normalizeIdentityTitle,
  normalizeLanguage,
} from "./normalize";
import type {
  CatalogRating,
  CatalogTitle,
  DiscoverySource,
  EvidenceConfidence,
  MediaType,
  ReleaseEvent,
  SourceEvidence,
} from "./types";
import {
  formatRatingValue,
  mergeRatings,
  selectPreferredRating,
} from "./ratings/types";

export interface CanonicalIdentityDiagnostics {
  /** Ambiguous external-ID or title/year buckets deliberately left separate. */
  ambiguousIdentity: number;
  /** Canonical groups that still have neither TMDB nor IMDb identity. */
  unresolvedIdentity: number;
}

export interface CanonicalIdentityResult {
  titles: CatalogTitle[];
  canonicalIdBySourceTitleId: Map<string, string>;
  diagnostics: CanonicalIdentityDiagnostics;
}

export interface CanonicalEventResult {
  events: ReleaseEvent[];
  duplicateEvents: number;
}

export interface DiscoveryEventDateSelection {
  direction: "past" | "upcoming";
  /** Omit for All; active ranges require day-precision source dates. */
  range?: { start: string; end: string };
}

export interface DiscoveryFeedEntry {
  title?: CatalogTitle;
  event?: ReleaseEvent;
}

export interface DiscoveryFeedClassification {
  trending: DiscoveryFeedEntry[];
  popular: DiscoveryFeedEntry[];
  charts: DiscoveryFeedEntry[];
  community: DiscoveryFeedEntry[];
  ott: DiscoveryFeedEntry[];
  bluray: DiscoveryFeedEntry[];
  tamilmv: DiscoveryFeedEntry[];
  india: DiscoveryFeedEntry[];
}

export interface DiscoveryFeedClassificationOptions {
  includeStreamingUpcoming?: boolean;
  includeGenericPhysical?: boolean;
  indianTitlesOnly?: boolean;
}

export interface DiscoveryFeedFilters {
  mediaTypes?: readonly MediaType[];
  providerIds?: readonly string[];
  date?: DiscoveryEventDateSelection;
  formatLabels?: readonly string[];
  languageCodes?: readonly string[];
  genreIds?: readonly number[];
  indianTitlesOnly?: boolean;
  yearFilter?: string;
  minImdbRating?: number;
  minImdbVotes?: number;
}

export interface DiscoveryRankingOptions {
  direction: "past" | "upcoming";
}

export interface DiscoverySourceContribution {
  snapshots: number;
  titles: number;
  events: number;
  evidence: number;
}

export interface DiscoveryDiagnostics extends CanonicalIdentityDiagnostics {
  unknownDate: number;
  conflictingDate: number;
  duplicateEvents: number;
  missingMetadata: number;
  sourceContribution: Record<DiscoverySource, DiscoverySourceContribution>;
}

export interface DiscoveryAggregation {
  titles: CatalogTitle[];
  events: ReleaseEvent[];
  feeds: DiscoveryFeedClassification;
  diagnostics: DiscoveryDiagnostics;
}

class DisjointSet {
  private readonly parents: number[];

  constructor(size: number) {
    this.parents = Array.from({ length: size }, (_, index) => index);
  }

  find(index: number): number {
    const parent = this.parents[index]!;
    if (parent === index) return index;
    const root = this.find(parent);
    this.parents[index] = root;
    return root;
  }

  union(left: number, right: number): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    this.parents[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
  }
}

function groupIndexes(
  titles: CatalogTitle[],
  keyFor: (title: CatalogTitle) => string | undefined,
): Map<string, number[]> {
  const grouped = new Map<string, number[]>();
  for (const [index, title] of titles.entries()) {
    const key = keyFor(title);
    if (!key) continue;
    const bucket = grouped.get(key) ?? [];
    bucket.push(index);
    grouped.set(key, bucket);
  }
  return grouped;
}

function unionAll(set: DisjointSet, indexes: number[]): void {
  const first = indexes[0];
  if (first === undefined) return;
  for (const index of indexes.slice(1)) set.union(first, index);
}

function rootIndexes(set: DisjointSet, indexes: number[]): number[] {
  return [...new Set(indexes.map((index) => set.find(index)))];
}

function externalIds(
  set: DisjointSet,
  titles: CatalogTitle[],
  roots: number[],
): { tmdb: Set<number>; imdb: Set<string> } {
  const rootSet = new Set(roots);
  const tmdb = new Set<number>();
  const imdb = new Set<string>();
  for (const [index, title] of titles.entries()) {
    if (!rootSet.has(set.find(index))) continue;
    if (title.tmdbId !== undefined) tmdb.add(title.tmdbId);
    if (title.imdbId) imdb.add(title.imdbId);
  }
  return { tmdb, imdb };
}

function completeness(title: CatalogTitle): number {
  return [
    title.tmdbId,
    title.imdbId,
    title.originalTitle,
    title.year,
    title.originalLanguage,
    title.posterUrl,
    title.popularity,
  ].filter((value) => value !== undefined).length +
    title.originCountries.length +
    title.genreIds.length +
    (title.genreLabels?.length ?? 0);
}

function authority(title: CatalogTitle): number {
  if (title.id.startsWith("tmdb:")) return 3;
  if (title.tmdbId !== undefined) return 2;
  if (title.imdbId) return 1;
  return 0;
}

function representative(members: CatalogTitle[]): CatalogTitle {
  return members.slice().sort((left, right) =>
    authority(right) - authority(left) ||
    completeness(right) - completeness(left) ||
    left.id.localeCompare(right.id))[0]!;
}

function firstDefined<T>(members: CatalogTitle[], value: (title: CatalogTitle) => T | undefined) {
  for (const member of members) {
    const candidate = value(member);
    if (candidate !== undefined) return candidate;
  }
  return undefined;
}

function canonicalId(members: CatalogTitle[], chosen: CatalogTitle): string {
  const tmdbIds = [...new Set(members.flatMap((title) =>
    title.tmdbId === undefined ? [] : [title.tmdbId]))];
  if (tmdbIds.length === 1) return `canonical:${chosen.mediaType}:tmdb:${tmdbIds[0]}`;
  const imdbIds = [...new Set(members.flatMap((title) => title.imdbId ? [title.imdbId] : []))];
  if (imdbIds.length === 1) return `canonical:${chosen.mediaType}:imdb:${imdbIds[0]}`;
  const normalized = normalizeIdentityTitle(chosen.title).replace(/ /g, "-") || "untitled";
  return `canonical:${chosen.mediaType}:title:${normalized}:${chosen.year ?? "unknown"}:${chosen.id}`;
}

function mergeTitles(members: CatalogTitle[]): CatalogTitle {
  const chosen = representative(members);
  const ordered = [chosen, ...members.filter((title) => title !== chosen)
    .sort((left, right) => left.id.localeCompare(right.id))];
  const images = {
    verticalPoster: firstDefined(ordered, (title) => title.images?.verticalPoster),
    horizontalPoster: firstDefined(ordered, (title) => title.images?.horizontalPoster),
    horizontalBackdrop: firstDefined(ordered, (title) => title.images?.horizontalBackdrop),
    verticalBackdrop: firstDefined(ordered, (title) => title.images?.verticalBackdrop),
  };
  const presentImages = Object.entries(images).filter(
    (entry): entry is [keyof typeof images, string] => entry[1] !== undefined,
  );
  const popularity = Math.max(
    ...members.flatMap((title) => title.popularity === undefined ? [] : [title.popularity]),
  );
  const ratings = mergeRatings(...members.map((title) => title.ratings));
  return {
    id: canonicalId(members, chosen),
    title: chosen.title,
    ...(firstDefined(ordered, (title) => title.originalTitle) !== undefined
      ? { originalTitle: firstDefined(ordered, (title) => title.originalTitle) }
      : {}),
    ...(firstDefined(ordered, (title) => title.year) !== undefined
      ? { year: firstDefined(ordered, (title) => title.year) }
      : {}),
    mediaType: chosen.mediaType,
    ...(firstDefined(ordered, (title) => title.tmdbId) !== undefined
      ? { tmdbId: firstDefined(ordered, (title) => title.tmdbId) }
      : {}),
    ...(firstDefined(ordered, (title) => title.imdbId) !== undefined
      ? { imdbId: firstDefined(ordered, (title) => title.imdbId) }
      : {}),
    ...(firstDefined(ordered, (title) => title.traktId) !== undefined
      ? { traktId: firstDefined(ordered, (title) => title.traktId) }
      : {}),
    ...(firstDefined(ordered, (title) => title.originalLanguage) !== undefined
      ? { originalLanguage: firstDefined(ordered, (title) => title.originalLanguage) }
      : {}),
    originCountries: [...new Set(members.flatMap((title) => title.originCountries))].sort(),
    genreIds: [...new Set(members.flatMap((title) => title.genreIds))].sort((a, b) => a - b),
    ...([...new Set(members.flatMap((title) => title.genreLabels ?? []))].length > 0
      ? { genreLabels: [...new Set(members.flatMap((title) => title.genreLabels ?? []))].sort() }
      : {}),
    ...([...new Set(members.flatMap((title) => title.providerIds ?? []))].length > 0
      ? { providerIds: [...new Set(members.flatMap((title) => title.providerIds ?? []))].sort() }
      : {}),
    ...([...new Set(members.flatMap((title) => title.providerLabels ?? []))].length > 0
      ? { providerLabels: [...new Set(members.flatMap((title) => title.providerLabels ?? []))].sort() }
      : {}),
    ...(firstDefined(ordered, (title) => title.posterUrl) !== undefined
      ? { posterUrl: firstDefined(ordered, (title) => title.posterUrl) }
      : {}),
    ...(presentImages.length > 0 ? { images: Object.fromEntries(presentImages) } : {}),
    ...(Number.isFinite(popularity) ? { popularity } : {}),
    ...(ratings.length > 0 ? { ratings } : {}),
  };
}

function fallbackKey(title: CatalogTitle): string | undefined {
  if (title.year === undefined) return undefined;
  const normalized = normalizeIdentityTitle(title.title);
  return normalized ? `${title.mediaType}\u0000${normalized}\u0000${title.year}` : undefined;
}

/**
 * Pure cached-snapshot canonicalization. External identities are resolved
 * before conservative exact-title/year fallback; no adapter or network is used.
 */
export function canonicalizeSnapshotTitles(
  snapshots: readonly DiscoverySnapshot[],
): CanonicalIdentityResult {
  const titles = snapshots.flatMap((snapshot) => snapshot.titles);
  const set = new DisjointSet(titles.length);
  let ambiguousIdentity = 0;

  for (const indexes of groupIndexes(titles, (title) => title.id).values()) unionAll(set, indexes);
  for (const indexes of groupIndexes(titles, (title) =>
    title.tmdbId === undefined ? undefined : `${title.mediaType}\u0000${title.tmdbId}`).values()) {
    unionAll(set, indexes);
  }

  for (const indexes of groupIndexes(titles, (title) =>
    title.imdbId ? `${title.mediaType}\u0000${title.imdbId}` : undefined).values()) {
    const roots = rootIndexes(set, indexes);
    if (externalIds(set, titles, roots).tmdb.size > 1) {
      ambiguousIdentity += 1;
      continue;
    }
    unionAll(set, roots);
  }

  for (const indexes of groupIndexes(titles, fallbackKey).values()) {
    const roots = rootIndexes(set, indexes);
    if (roots.length < 2) continue;
    const ids = externalIds(set, titles, roots);
    if (ids.tmdb.size > 1 || ids.imdb.size > 1) {
      ambiguousIdentity += 1;
      continue;
    }
    unionAll(set, roots);
  }

  const groups = new Map<number, CatalogTitle[]>();
  for (const [index, title] of titles.entries()) {
    const root = set.find(index);
    const members = groups.get(root) ?? [];
    members.push(title);
    groups.set(root, members);
  }

  const canonicalIdBySourceTitleId = new Map<string, string>();
  const canonicalTitles = [...groups.values()].map((members) => {
    const title = mergeTitles(members);
    for (const member of members) canonicalIdBySourceTitleId.set(member.id, title.id);
    return title;
  }).sort((left, right) => left.id.localeCompare(right.id));

  return {
    titles: canonicalTitles,
    canonicalIdBySourceTitleId,
    diagnostics: {
      ambiguousIdentity,
      unresolvedIdentity: canonicalTitles.filter(
        (title) => title.tmdbId === undefined && !title.imdbId,
      ).length,
    },
  };
}

export function compatibleMediaType(left: MediaType, right: MediaType): boolean {
  return left === right;
}

function evidenceKey(evidence: SourceEvidence): string {
  return [
    evidence.source,
    evidence.sourceId ?? "",
    evidence.sourceUrl ?? "",
    evidence.observedAt,
    evidence.confidence,
  ].join("\u0000");
}

function canonicalEventKey(event: ReleaseEvent, canonicalTitleId: string): string {
  return [
    canonicalTitleId,
    event.providerId ?? "",
    event.region,
    event.kind,
    event.date ?? "",
    event.datePrecision,
    event.formatLabel ?? "",
    event.accessType ?? "",
  ].join("\u0000");
}

function mergeEventGroup(events: ReleaseEvent[], canonicalTitleId: string): ReleaseEvent {
  const ordered = events.slice().sort((left, right) => left.id.localeCompare(right.id));
  const chosen = ordered[0]!;
  const evidence = new Map<string, SourceEvidence>();
  for (const event of ordered) {
    for (const item of event.evidence) evidence.set(evidenceKey(item), item);
  }
  const audioLanguages = [...new Set(events.flatMap((event) => event.audioLanguages ?? []))]
    .sort();
  const subtitleLanguages = [
    ...new Set(events.flatMap((event) => event.subtitleLanguages ?? [])),
  ].sort();
  return {
    ...chosen,
    titleId: canonicalTitleId,
    firstObservedAt: Math.min(...events.map((event) => event.firstObservedAt)),
    lastObservedAt: Math.max(...events.map((event) => event.lastObservedAt)),
    ...(audioLanguages.length > 0 ? { audioLanguages } : {}),
    ...(subtitleLanguages.length > 0 ? { subtitleLanguages } : {}),
    evidence: [...evidence.values()].sort((left, right) =>
      evidenceKey(left).localeCompare(evidenceKey(right))),
  };
}

/** Remap source title IDs, then merge only semantically identical events. */
export function canonicalizeSnapshotEvents(
  snapshots: readonly DiscoverySnapshot[],
  canonicalIdBySourceTitleId: ReadonlyMap<string, string>,
): CanonicalEventResult {
  const groups = new Map<string, { canonicalTitleId: string; events: ReleaseEvent[] }>();
  const inputEvents = snapshots.flatMap((snapshot) => snapshot.events);
  for (const event of inputEvents) {
    const canonicalTitleId = canonicalIdBySourceTitleId.get(event.titleId) ?? event.titleId;
    const key = canonicalEventKey(event, canonicalTitleId);
    const group = groups.get(key) ?? { canonicalTitleId, events: [] };
    group.events.push(event);
    groups.set(key, group);
  }
  const events = [...groups.values()]
    .map((group) => mergeEventGroup(group.events, group.canonicalTitleId))
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    events,
    duplicateEvents: inputEvents.length - events.length,
  };
}

/** Apply honest date-window semantics, then sort known dates before unknowns. */
export function selectEventsByDate(
  events: readonly ReleaseEvent[],
  selection: DiscoveryEventDateSelection,
): ReleaseEvent[] {
  const selected = selection.range
    ? events.filter((event) =>
        event.datePrecision === "day" &&
        isWithinDateRange(event.date, selection.range!.start, selection.range!.end))
    : [...events];
  return selected.sort((left, right) => {
    if (!!left.date !== !!right.date) return left.date ? -1 : 1;
    if (left.date && right.date && left.date !== right.date) {
      return selection.direction === "past"
        ? right.date.localeCompare(left.date)
        : left.date.localeCompare(right.date);
    }
    return left.id.localeCompare(right.id);
  });
}

function entriesForEvents(
  events: readonly ReleaseEvent[],
  titleById: ReadonlyMap<string, CatalogTitle>,
): DiscoveryFeedEntry[] {
  return events.map((event) => ({
    event,
    ...(titleById.get(event.titleId) ? { title: titleById.get(event.titleId) } : {}),
  }));
}

/** Classify canonical cached data without reinterpreting source event meaning. */
export function classifyDiscoveryFeeds(
  snapshots: readonly DiscoverySnapshot[],
  identities: CanonicalIdentityResult,
  events: readonly ReleaseEvent[],
  options: DiscoveryFeedClassificationOptions = {},
): DiscoveryFeedClassification {
  const titleById = new Map(identities.titles.map((title) => [title.id, title]));
  const trendingIds = new Set<string>();
  const popularIds = new Set<string>();
  const chartIds = new Set<string>();
  const communityIds = new Set<string>();
  for (const snapshot of snapshots) {
    const ids = snapshot.feedKind === "provider_popular"
      ? popularIds
      : snapshot.feedKind === "streaming_charts"
        ? chartIds
        : snapshot.feedKind === "community_popular"
          ? communityIds
        : undefined;
    if (ids) {
      for (const title of snapshot.titles) {
        const canonicalId = identities.canonicalIdBySourceTitleId.get(title.id);
        if (canonicalId) ids.add(canonicalId);
      }
      continue;
    }
    if (snapshot.source !== "tmdb" || snapshot.feedKind !== "trending") continue;
    for (const title of snapshot.titles) {
      const canonicalId = identities.canonicalIdBySourceTitleId.get(title.id);
      if (canonicalId) trendingIds.add(canonicalId);
    }
  }
  const includeUpcoming = options.includeStreamingUpcoming ?? true;
  const ottEvents = events.filter((event) =>
    event.kind === "streaming_added" ||
    (includeUpcoming && event.kind === "streaming_upcoming"));
  const blurayEvents = events.filter((event) =>
    event.kind === "bluray" ||
    event.kind === "uhd_bluray" ||
    (options.includeGenericPhysical === true && event.kind === "physical"));
  const tamilmvEvents = events.filter((event) =>
    event.evidence.some((evidence) => evidence.source === "tamilmv"));
  const indiaEvents = events.filter((event) => {
    if (event.region !== "IN") return false;
    // Keep TamilMV listing events on their dedicated feed only.
    if (event.evidence.some((evidence) => evidence.source === "tamilmv")) return false;
    if (!options.indianTitlesOnly) return true;
    return titleById.get(event.titleId)?.originCountries.includes("IN") === true;
  });
  return {
    trending: [...trendingIds]
      .sort()
      .flatMap((id) => titleById.get(id) ? [{ title: titleById.get(id)! }] : []),
    popular: [...popularIds]
      .sort()
      .flatMap((id) => titleById.get(id) ? [{ title: titleById.get(id)! }] : []),
    charts: [...chartIds]
      .sort()
      .flatMap((id) => titleById.get(id) ? [{ title: titleById.get(id)! }] : []),
    community: [...communityIds]
      .sort()
      .flatMap((id) => titleById.get(id) ? [{ title: titleById.get(id)! }] : []),
    ott: entriesForEvents(ottEvents, titleById),
    bluray: entriesForEvents(blurayEvents, titleById),
    tamilmv: entriesForEvents(tamilmvEvents, titleById),
    india: entriesForEvents(indiaEvents, titleById),
  };
}

function normalizedLanguages(entry: DiscoveryFeedEntry): Set<string> {
  const values = [
    entry.title?.originalLanguage,
    ...(entry.event?.audioLanguages ?? []),
  ];
  return new Set(values.flatMap((value) => {
    const normalized = normalizeLanguage(value);
    const fallback = value?.trim().toLowerCase();
    return normalized ? [normalized.code] : fallback ? [fallback] : [];
  }));
}

export function matchesYearFilter(
  year: number | undefined,
  yearFilter: string | undefined,
): boolean {
  if (!yearFilter || yearFilter === "all") return true;
  if (year === undefined || !Number.isFinite(year)) return false;
  if (yearFilter === "pre-1980") return year < 1980;
  const decade = /^(\d{4})s$/.exec(yearFilter);
  if (decade) {
    const start = Number(decade[1]);
    return year >= start && year <= start + 9;
  }
  const exact = Number(yearFilter);
  if (Number.isInteger(exact)) return year === exact;
  return true;
}

export type DiscoveryRatingsMap = ReadonlyMap<string, readonly CatalogRating[]>;

/** IMDb-only rating for filters/sorts; map wins over title.ratings. */
export function entryImdbRating(
  entry: DiscoveryFeedEntry,
  ratingsByTitleId: DiscoveryRatingsMap = new Map(),
): CatalogRating | undefined {
  const titleId = entry.title?.id;
  const fromMap = titleId ? ratingsByTitleId.get(titleId) : undefined;
  const pool = [
    ...(fromMap ?? []),
    ...(entry.title?.ratings ?? []),
  ].filter((rating) => rating.system === "imdb");
  return selectPreferredRating(pool);
}

/** Apply hard feed filters only; ranking is a separate deterministic step. */
export function filterDiscoveryEntries(
  entries: readonly DiscoveryFeedEntry[],
  filters: DiscoveryFeedFilters,
  ratingsByTitleId: DiscoveryRatingsMap = new Map(),
): DiscoveryFeedEntry[] {
  const mediaTypes = new Set(filters.mediaTypes ?? []);
  const providerIds = new Set(filters.providerIds ?? []);
  const formatLabels = new Set(
    (filters.formatLabels ?? []).map((label) => label.trim().toLowerCase()),
  );
  const otherLanguage = filters.languageCodes?.includes("other") === true;
  const languageCodes = new Set((filters.languageCodes ?? []).flatMap((value) => {
    if (value === "other") return [];
    const normalized = normalizeLanguage(value);
    return normalized ? [normalized.code] : [];
  }));
  const knownLanguageCodes = new Set(Object.keys(LANGUAGE_LABELS));
  const genreIds = new Set(filters.genreIds ?? []);
  const dateIds = filters.date?.range
    ? new Set(selectEventsByDate(
        entries.flatMap((entry) => entry.event ? [entry.event] : []),
        filters.date,
      ).map((event) => event.id))
    : undefined;

  return entries.filter((entry) => {
    if (mediaTypes.size > 0 && (!entry.title || !mediaTypes.has(entry.title.mediaType))) {
      return false;
    }
    if (
      providerIds.size > 0 &&
      (!entry.event?.providerId
        ? !entry.title?.providerIds?.some((providerId) => providerIds.has(providerId))
        : !providerIds.has(entry.event.providerId))
    ) {
      return false;
    }
    if (dateIds && (!entry.event || !dateIds.has(entry.event.id))) return false;
    if (
      formatLabels.size > 0 &&
      (!entry.event?.formatLabel ||
        !formatLabels.has(entry.event.formatLabel.trim().toLowerCase()))
    ) {
      return false;
    }
    if (
      (languageCodes.size > 0 || otherLanguage) &&
      ![...normalizedLanguages(entry)].some((code) =>
        languageCodes.has(code) || (otherLanguage && !knownLanguageCodes.has(code)))
    ) {
      return false;
    }
    if (
      genreIds.size > 0 &&
      (!entry.title || !entry.title.genreIds.some((id) => genreIds.has(id)))
    ) {
      return false;
    }
    if (filters.indianTitlesOnly && !entry.title?.originCountries.includes("IN")) return false;
    if (!matchesYearFilter(entry.title?.year, filters.yearFilter)) return false;
    if (filters.minImdbRating !== undefined || filters.minImdbVotes !== undefined) {
      const rating = entryImdbRating(entry, ratingsByTitleId);
      if (!rating) return false;
      const score = formatRatingValue(rating);
      if (
        filters.minImdbRating !== undefined &&
        score < filters.minImdbRating
      ) {
        return false;
      }
      if (filters.minImdbVotes !== undefined) {
        if (rating.voteCount === undefined || rating.voteCount < filters.minImdbVotes) {
          return false;
        }
      }
    }
    return true;
  });
}

const CONFIDENCE_RANK: Record<EvidenceConfidence, number> = {
  exact: 3,
  source_claim: 2,
  inferred: 1,
};

function entryConfidence(entry: DiscoveryFeedEntry): number {
  return Math.max(
    0,
    ...(entry.event?.evidence.map((evidence) => CONFIDENCE_RANK[evidence.confidence]) ?? []),
  );
}

function stableEntryId(entry: DiscoveryFeedEntry): string {
  return entry.event?.id ?? entry.title?.id ?? "";
}

/** Rank already-filtered entries; popularity is deliberately below date/confidence. */
export function rankDiscoveryEntries(
  entries: readonly DiscoveryFeedEntry[],
  options: DiscoveryRankingOptions,
): DiscoveryFeedEntry[] {
  return [...entries].sort((left, right) => {
    const leftDate = left.event?.date;
    const rightDate = right.event?.date;
    if (!!leftDate !== !!rightDate) return leftDate ? -1 : 1;
    if (leftDate && rightDate && leftDate !== rightDate) {
      return options.direction === "past"
        ? rightDate.localeCompare(leftDate)
        : leftDate.localeCompare(rightDate);
    }
    const confidenceDifference = entryConfidence(right) - entryConfidence(left);
    if (confidenceDifference !== 0) return confidenceDifference;
    const leftPopularity = left.title?.popularity;
    const rightPopularity = right.title?.popularity;
    if (leftPopularity !== rightPopularity) {
      if (leftPopularity === undefined) return 1;
      if (rightPopularity === undefined) return -1;
      return rightPopularity - leftPopularity;
    }
    const titleDifference = (left.title?.title ?? "").localeCompare(right.title?.title ?? "");
    if (titleDifference !== 0) return titleDifference;
    return stableEntryId(left).localeCompare(stableEntryId(right));
  });
}

export type DiscoverySortMode =
  | "default"
  | "date_added"
  | "release_date"
  | "imdb_rating"
  | "imdb_votes"
  | "title";

function observedAt(entry: DiscoveryFeedEntry): number | undefined {
  const event = entry.event;
  if (!event) return undefined;
  return Math.max(event.lastObservedAt ?? 0, event.firstObservedAt ?? 0) || undefined;
}

/** Compare values with missing/empty last. Always returns a number; 0 means equal. */
function cmpMissingLast(
  left: number | string | undefined,
  right: number | string | undefined,
  dir: "asc" | "desc",
): number {
  const leftMissing = left === undefined || left === "";
  const rightMissing = right === undefined || right === "";
  if (leftMissing && rightMissing) return 0;
  if (leftMissing) return 1;
  if (rightMissing) return -1;
  if (left === right) return 0;
  if (typeof left === "number" && typeof right === "number") {
    return dir === "desc" ? right - left : left - right;
  }
  const text = String(left).localeCompare(String(right));
  return dir === "desc" ? -text : text;
}

/** Manual sort modes; `default` keeps the existing ranking cascade. */
export function sortDiscoveryEntries(
  entries: readonly DiscoveryFeedEntry[],
  mode: DiscoverySortMode,
  ranking: DiscoveryRankingOptions,
  ratingsByTitleId: DiscoveryRatingsMap = new Map(),
): DiscoveryFeedEntry[] {
  if (mode === "default") {
    return rankDiscoveryEntries(entries, ranking);
  }

  return [...entries].sort((left, right) => {
    if (mode === "date_added") {
      const primary = cmpMissingLast(observedAt(left), observedAt(right), "desc");
      if (primary !== 0) return primary;
    } else if (mode === "release_date") {
      const primary = cmpMissingLast(left.event?.date, right.event?.date, "desc");
      if (primary !== 0) return primary;
    } else if (mode === "imdb_rating") {
      const leftR = entryImdbRating(left, ratingsByTitleId);
      const rightR = entryImdbRating(right, ratingsByTitleId);
      const primary = cmpMissingLast(
        leftR ? formatRatingValue(leftR) : undefined,
        rightR ? formatRatingValue(rightR) : undefined,
        "desc",
      );
      if (primary !== 0) return primary;
      const votes = cmpMissingLast(leftR?.voteCount, rightR?.voteCount, "desc");
      if (votes !== 0) return votes;
    } else if (mode === "imdb_votes") {
      const leftR = entryImdbRating(left, ratingsByTitleId);
      const rightR = entryImdbRating(right, ratingsByTitleId);
      const primary = cmpMissingLast(leftR?.voteCount, rightR?.voteCount, "desc");
      if (primary !== 0) return primary;
      const rating = cmpMissingLast(
        leftR ? formatRatingValue(leftR) : undefined,
        rightR ? formatRatingValue(rightR) : undefined,
        "desc",
      );
      if (rating !== 0) return rating;
    } else if (mode === "title") {
      const primary = cmpMissingLast(left.title?.title, right.title?.title, "asc");
      if (primary !== 0) return primary;
      const year = cmpMissingLast(left.title?.year, right.title?.year, "asc");
      if (year !== 0) return year;
    }

    const titleCmp = (left.title?.title ?? "").localeCompare(right.title?.title ?? "");
    if (titleCmp !== 0) return titleCmp;
    return stableEntryId(left).localeCompare(stableEntryId(right));
  });
}

/** Public composition boundary: hard filters always run before ranking. */
export function selectDiscoveryEntries(
  entries: readonly DiscoveryFeedEntry[],
  filters: DiscoveryFeedFilters,
  ranking: DiscoveryRankingOptions,
): DiscoveryFeedEntry[] {
  return rankDiscoveryEntries(filterDiscoveryEntries(entries, filters), ranking);
}

function conflictKey(event: ReleaseEvent): string {
  return [
    event.titleId,
    event.providerId ?? "",
    event.region,
    event.kind,
    event.formatLabel ?? "",
    event.accessType ?? "",
  ].join("\u0000");
}

const DISCOVERY_SOURCES: DiscoverySource[] = [
  "tmdb",
  "bluray",
  "trakt",
  "streaming-availability",
  "apify",
  "tamilmv",
];

function emptyContributions(): Record<DiscoverySource, DiscoverySourceContribution> {
  return Object.fromEntries(DISCOVERY_SOURCES.map((source) => [source, {
    snapshots: 0,
    titles: 0,
    events: 0,
    evidence: 0,
  }])) as Record<DiscoverySource, DiscoverySourceContribution>;
}

/** Build operational counters from canonical results without altering feeds. */
export function buildDiscoveryDiagnostics(
  snapshots: readonly DiscoverySnapshot[],
  identities: CanonicalIdentityResult,
  canonicalEvents: CanonicalEventResult,
): DiscoveryDiagnostics {
  const datesByClaim = new Map<string, Set<string>>();
  for (const event of canonicalEvents.events) {
    if (!event.date) continue;
    const dates = datesByClaim.get(conflictKey(event)) ?? new Set<string>();
    dates.add(event.date);
    datesByClaim.set(conflictKey(event), dates);
  }
  const sourceContribution = emptyContributions();
  for (const snapshot of snapshots) {
    const contribution = sourceContribution[snapshot.source];
    contribution.snapshots += 1;
    contribution.titles += snapshot.titles.length;
    contribution.events += snapshot.events.length;
  }
  for (const event of canonicalEvents.events) {
    for (const evidence of event.evidence) {
      sourceContribution[evidence.source].evidence += 1;
    }
  }
  const titleIds = new Set(identities.titles.map((title) => title.id));
  return {
    ...identities.diagnostics,
    unknownDate: canonicalEvents.events.filter(
      (event) => !event.date || event.datePrecision === "unknown",
    ).length,
    conflictingDate: [...datesByClaim.values()].filter((dates) => dates.size > 1).length,
    duplicateEvents: canonicalEvents.duplicateEvents,
    missingMetadata: canonicalEvents.events.filter((event) => !titleIds.has(event.titleId)).length,
    sourceContribution,
  };
}

/** Complete pure aggregation boundary consumed by the discovery UI. */
export function aggregateDiscoverySnapshots(
  snapshots: readonly DiscoverySnapshot[],
  options: DiscoveryFeedClassificationOptions = {},
): DiscoveryAggregation {
  const identities = canonicalizeSnapshotTitles(snapshots);
  const canonicalEvents = canonicalizeSnapshotEvents(
    snapshots,
    identities.canonicalIdBySourceTitleId,
  );
  return {
    titles: identities.titles,
    events: canonicalEvents.events,
    feeds: classifyDiscoveryFeeds(
      snapshots,
      identities,
      canonicalEvents.events,
      options,
    ),
    diagnostics: buildDiscoveryDiagnostics(snapshots, identities, canonicalEvents),
  };
}
