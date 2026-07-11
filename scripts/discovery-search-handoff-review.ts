import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { DiscoverySnapshot } from "../src/discovery/adapter";
import { aggregateDiscoverySnapshots } from "../src/discovery/aggregate";
import { parseDiscoveryCache } from "../src/discovery/cache";
import { normalizeLanguage } from "../src/discovery/normalize";
import { buildDiscoverySearchQuery } from "../src/discovery/search-handoff";
import { sanitizeDiscoveryText } from "../src/discovery/security";
import type { CatalogTitle } from "../src/discovery/types";
import { loadConfig, type Config } from "../src/config/config";
import { cachedSearch } from "../src/sources/cache";
import { errorToCode } from "../src/sources/adapter";
import { activeMirror, buildRegistry, isEnabled } from "../src/sources/registry";
import { matchScore, rankResults, tokenize } from "../src/sources/relevance";
import { parseReleaseName } from "../src/sources/releasename";
import { dedupe, defaultOrder } from "../src/sources/search";
import type { Source, TorrentResult } from "../src/sources/types";
import { mapPool } from "../src/util/concurrency";
import { serializeWrites, writeJsonAtomic } from "../src/util/atomic";

export const SEARCH_HANDOFF_REVIEW_VERSION = 1 as const;
export const SEARCH_HANDOFF_REQUIRED = 20;
export const SEARCH_HANDOFF_REQUIRED_LANGUAGES = 3;

const DEFAULT_SOURCE_IDS = ["thepiratebay", "solidtorrents", "bitsearch", "yts", "nyaa"];
const PER_SOURCE_TIMEOUT_MS = 20_000;
const RESULT_LIMIT = 50;
const STORED_RESULT_LIMIT = 10;

export type SearchHandoffVerdict = "pass" | "error" | "unverifiable";

export interface SearchHandoffAssessment {
  assessedAt: string;
  verdict: SearchHandoffVerdict;
  note?: string;
}

export interface SearchHandoffSourceOutcome {
  source: string;
  sourceLabel: string;
  status: "success" | "error";
  resultCount: number;
  errorCode?: string;
}

export interface SearchHandoffStoredResult {
  source: string;
  name: string;
  seeders: number;
  titleMatch: boolean;
  yearCompatible: boolean;
}

export interface SearchHandoffLaunch {
  launchedAt: string;
  query: string;
  sourceOutcomes: SearchHandoffSourceOutcome[];
  totalResults: number;
  relevantResults: number;
  rankedTop5Relevant: number;
  legacyTop5Relevant: number;
  topResultRelevant: boolean;
  results: SearchHandoffStoredResult[];
}

export interface SearchHandoffNoiseComparison {
  launchedAt: string;
  /** Discovery metadata deliberately appended only as a validation baseline. */
  noiseLabel: string;
  query: string;
  sourceOutcomes: SearchHandoffSourceOutcome[];
  totalResults: number;
  relevantResults: number;
  topResultRelevant: boolean;
}

export interface SearchHandoffReviewItem {
  id: string;
  title: string;
  year?: number;
  mediaType: "movie" | "series";
  languageCode?: string;
  languageLabel?: string;
  providerLabels: string[];
  formatLabels: string[];
  query: string;
  queryMatchesProductionBuilder: boolean;
  appendedNoise: boolean;
  launch?: SearchHandoffLaunch;
  noiseComparison?: SearchHandoffNoiseComparison;
  assessment?: SearchHandoffAssessment;
}

export interface SearchHandoffReviewDocument {
  version: typeof SEARCH_HANDOFF_REVIEW_VERSION;
  createdAt: string;
  updatedAt: string;
  requirements: {
    titles: number;
    languages: number;
    mediaTypes: Array<"movie" | "series">;
  };
  available: {
    titles: number;
    movies: number;
    series: number;
    languages: string[];
  };
  samples: SearchHandoffReviewItem[];
}

export interface SearchHandoffReviewSummary {
  required: SearchHandoffReviewDocument["requirements"];
  available: SearchHandoffReviewDocument["available"];
  sampled: number;
  launched: number;
  assessed: number;
  passed: number;
  errors: number;
  unverifiable: number;
  launchedByMediaType: { movie: number; series: number };
  launchedLanguages: string[];
  appendedNoiseQueries: number;
  productionQueryMismatches: number;
  searchesWithResults: number;
  relevantTopResults: number;
  rankingImproved: number;
  rankingTied: number;
  rankingRegressed: number;
  noiseComparisonEligible: number;
  noiseComparisons: number;
  cleanRelevantResults: number;
  noisyRelevantResults: number;
  cleanComparisonWins: number;
  comparisonTies: number;
  noisyComparisonWins: number;
  cleanImprovedOverNoise: boolean;
  sourceOutcomes: Record<string, { success: number; error: number; results: number }>;
  complete: boolean;
}

interface SearchRunner {
  (
    source: Source,
    query: string,
    config: Config,
    signal: AbortSignal,
  ): Promise<TorrentResult[]>;
}

function reviewDirectory(): string {
  const configured = process.env.MINCH_BETA_DIR?.trim();
  if (!configured) {
    throw new Error("Set MINCH_BETA_DIR to the isolated persistent beta directory");
  }
  return path.resolve(configured);
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function candidateFor(
  title: CatalogTitle,
  providerLabels: string[],
  formatLabels: string[],
): SearchHandoffReviewItem | undefined {
  if (title.mediaType !== "movie" && title.mediaType !== "series") return undefined;
  const query = buildDiscoverySearchQuery(title);
  if (!query) return undefined;
  const language = normalizeLanguage(title.originalLanguage);
  const cleanProviders = [...new Set(providerLabels
    .map((label) => sanitizeDiscoveryText(label)).filter(Boolean))]
    .sort();
  const cleanFormats = [...new Set(formatLabels
    .map((label) => sanitizeDiscoveryText(label)).filter(Boolean))]
    .sort();
  const cleanTitle = sanitizeDiscoveryText(title.title);
  const expected = `${cleanTitle}${title.year ? ` ${title.year}` : ""}`;
  return {
    id: `handoff-${stableHash(title.id).slice(0, 16)}`,
    title: cleanTitle,
    ...(title.year !== undefined ? { year: title.year } : {}),
    mediaType: title.mediaType,
    ...(language ? { languageCode: language.code, languageLabel: language.label } : {}),
    providerLabels: cleanProviders,
    formatLabels: cleanFormats,
    query,
    queryMatchesProductionBuilder:
      query === buildDiscoverySearchQuery({ title: cleanTitle, year: title.year }),
    appendedNoise: query !== expected,
  };
}

/** Deterministically interleave media/language buckets before any one dominates. */
export function searchHandoffCandidates(
  snapshots: readonly DiscoverySnapshot[],
): SearchHandoffReviewItem[] {
  const aggregation = aggregateDiscoverySnapshots(snapshots, {
    includeGenericPhysical: true,
    includeStreamingUpcoming: true,
  });
  const labelsByTitle = new Map<string, { providers: string[]; formats: string[] }>();
  for (const event of aggregation.events) {
    const labels = labelsByTitle.get(event.titleId) ?? { providers: [], formats: [] };
    if (event.providerLabel) labels.providers.push(event.providerLabel);
    if (event.formatLabel) labels.formats.push(event.formatLabel);
    labelsByTitle.set(event.titleId, labels);
  }
  const buckets = new Map<string, SearchHandoffReviewItem[]>();
  for (const title of aggregation.titles) {
    const labels = labelsByTitle.get(title.id) ?? { providers: [], formats: [] };
    const candidate = candidateFor(title, labels.providers, labels.formats);
    if (!candidate) continue;
    const key = `${candidate.mediaType}:${candidate.languageCode ?? "unknown"}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(candidate);
    buckets.set(key, bucket);
  }
  const orderedBuckets = [...buckets.entries()]
    .sort(([left], [right]) => {
      const leftUnknown = left.endsWith(":unknown");
      const rightUnknown = right.endsWith(":unknown");
      return Number(leftUnknown) - Number(rightUnknown) || left.localeCompare(right);
    })
    .map(([, bucket]) => bucket.sort((left, right) => left.id.localeCompare(right.id)));
  const interleaved: SearchHandoffReviewItem[] = [];
  for (let index = 0; orderedBuckets.some((bucket) => index < bucket.length); index += 1) {
    for (const bucket of orderedBuckets) {
      const item = bucket[index];
      if (item) interleaved.push(item);
    }
  }
  return interleaved;
}

export function initializeSearchHandoffReview(
  snapshots: readonly DiscoverySnapshot[],
  existing: SearchHandoffReviewDocument | undefined,
  now = Date.now(),
): SearchHandoffReviewDocument {
  const candidates = searchHandoffCandidates(snapshots);
  const candidateById = new Map(candidates.map((item) => [item.id, item]));
  const retained = existing?.samples.map((item) => {
    const refreshed = candidateById.get(item.id);
    return refreshed
      ? {
          ...structuredClone(refreshed),
          ...(item.launch ? { launch: structuredClone(item.launch) } : {}),
          ...(item.noiseComparison
            ? { noiseComparison: structuredClone(item.noiseComparison) }
            : {}),
          ...(item.assessment ? { assessment: structuredClone(item.assessment) } : {}),
        }
      : structuredClone(item);
  }) ?? [];
  const retainedIds = new Set(retained.map((item) => item.id));
  for (const candidate of candidates) {
    if (retained.length >= SEARCH_HANDOFF_REQUIRED) break;
    if (retainedIds.has(candidate.id)) continue;
    retained.push(candidate);
    retainedIds.add(candidate.id);
  }
  const nowIso = new Date(now).toISOString();
  const languages = [...new Set(candidates.flatMap((item) =>
    item.languageCode ? [item.languageCode] : []))].sort();
  return {
    version: SEARCH_HANDOFF_REVIEW_VERSION,
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
    requirements: {
      titles: SEARCH_HANDOFF_REQUIRED,
      languages: SEARCH_HANDOFF_REQUIRED_LANGUAGES,
      mediaTypes: ["movie", "series"],
    },
    available: {
      titles: candidates.length,
      movies: candidates.filter((item) => item.mediaType === "movie").length,
      series: candidates.filter((item) => item.mediaType === "series").length,
      languages,
    },
    samples: retained,
  };
}

function resultRelevant(item: SearchHandoffReviewItem, result: TorrentResult): boolean {
  const titleMatch = matchScore(result.name, tokenize(item.title)).tier >= 2;
  const resultYear = parseReleaseName(result.name).year;
  return titleMatch && (item.year === undefined || resultYear === null || resultYear === item.year);
}

export function evaluateSearchHandoffResults(
  item: SearchHandoffReviewItem,
  results: readonly TorrentResult[],
  rankingQuery = item.query,
): Pick<SearchHandoffLaunch,
  | "totalResults"
  | "relevantResults"
  | "rankedTop5Relevant"
  | "legacyTop5Relevant"
  | "topResultRelevant"
  | "results"> {
  const deduped = dedupe([...results]);
  const ranked = rankResults(deduped, rankingQuery);
  const legacy = defaultOrder(deduped);
  const relevant = (result: TorrentResult): boolean => resultRelevant(item, result);
  return {
    totalResults: deduped.length,
    relevantResults: deduped.filter(relevant).length,
    rankedTop5Relevant: ranked.slice(0, 5).filter(relevant).length,
    legacyTop5Relevant: legacy.slice(0, 5).filter(relevant).length,
    topResultRelevant: ranked[0] ? relevant(ranked[0]) : false,
    results: ranked.slice(0, STORED_RESULT_LIMIT).map((result) => {
      const resultYear = parseReleaseName(result.name).year;
      return {
        source: sanitizeDiscoveryText(result.source),
        name: sanitizeDiscoveryText(result.name),
        seeders: Number.isFinite(result.seeders) ? Math.max(0, result.seeders) : 0,
        titleMatch: matchScore(result.name, tokenize(item.title)).tier >= 2,
        yearCompatible: item.year === undefined || resultYear === null || resultYear === item.year,
      };
    }),
  };
}

async function runSource(
  source: Source,
  query: string,
  config: Config,
  runner: SearchRunner,
): Promise<{ outcome: SearchHandoffSourceOutcome; results: TorrentResult[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_SOURCE_TIMEOUT_MS);
  try {
    const results = await runner(source, query, config, controller.signal);
    return {
      outcome: {
        source: source.id,
        sourceLabel: sanitizeDiscoveryText(source.label),
        status: "success",
        resultCount: results.length,
      },
      results,
    };
  } catch (error) {
    return {
      outcome: {
        source: source.id,
        sourceLabel: sanitizeDiscoveryText(source.label),
        status: "error",
        resultCount: 0,
        errorCode: sanitizeDiscoveryText(errorToCode(error, controller.signal.aborted)),
      },
      results: [],
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function launchSearchHandoffItem(
  item: SearchHandoffReviewItem,
  sources: Source[],
  config: Config,
  runner: SearchRunner = (source, query, current, signal) =>
    cachedSearch(source, query, {
      baseUrl: activeMirror(source, current),
      limit: RESULT_LIMIT,
      signal,
    }),
  now = Date.now(),
): Promise<SearchHandoffReviewItem> {
  if (sources.length === 0) throw new Error("No enabled handoff validation sources");
  const settled = await mapPool(
    sources,
    3,
    (source) => runSource(source, item.query, config, runner),
  );
  const completed = settled.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : []);
  const evaluated = evaluateSearchHandoffResults(item, completed.flatMap((entry) => entry.results));
  item.launch = {
    launchedAt: new Date(now).toISOString(),
    query: item.query,
    sourceOutcomes: completed.map((entry) => entry.outcome)
      .sort((left, right) => left.source.localeCompare(right.source)),
    ...evaluated,
  };
  return item;
}

export function searchHandoffNoiseLabel(
  item: SearchHandoffReviewItem,
): string | undefined {
  return item.providerLabels[0] ?? item.formatLabels[0];
}

export async function launchSearchHandoffNoiseComparison(
  item: SearchHandoffReviewItem,
  sources: Source[],
  config: Config,
  runner: SearchRunner = (source, query, current, signal) =>
    cachedSearch(source, query, {
      baseUrl: activeMirror(source, current),
      limit: RESULT_LIMIT,
      signal,
    }),
  now = Date.now(),
): Promise<SearchHandoffReviewItem> {
  if (!item.launch) throw new Error("Launch the clean search before its noise comparison");
  const noiseLabel = searchHandoffNoiseLabel(item);
  if (!noiseLabel) throw new Error("Search-handoff sample has no provider or format baseline");
  if (sources.length === 0) throw new Error("No enabled handoff validation sources");
  const comparisonQuery = `${item.query} ${noiseLabel}`;
  const settled = await mapPool(
    sources,
    3,
    (source) => runSource(source, comparisonQuery, config, runner),
  );
  const completed = settled.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : []);
  const evaluated = evaluateSearchHandoffResults(
    item,
    completed.flatMap((entry) => entry.results),
    comparisonQuery,
  );
  item.noiseComparison = {
    launchedAt: new Date(now).toISOString(),
    noiseLabel,
    query: comparisonQuery,
    sourceOutcomes: completed.map((entry) => entry.outcome)
      .sort((left, right) => left.source.localeCompare(right.source)),
    totalResults: evaluated.totalResults,
    relevantResults: evaluated.relevantResults,
    topResultRelevant: evaluated.topResultRelevant,
  };
  return item;
}

export function recordSearchHandoffAssessment(
  document: SearchHandoffReviewDocument,
  id: string,
  verdict: SearchHandoffVerdict,
  note: string | undefined,
  now = Date.now(),
): SearchHandoffReviewDocument {
  const item = document.samples.find((sample) => sample.id === id);
  if (!item) throw new Error(`Unknown search-handoff sample: ${sanitizeDiscoveryText(id)}`);
  if (!item.launch) throw new Error("Launch the search-handoff sample before assessing it");
  const cleanNote = note ? sanitizeDiscoveryText(note) : "";
  if (verdict !== "pass" && !cleanNote) {
    throw new Error(`${verdict} assessments require a short evidence note`);
  }
  item.assessment = {
    assessedAt: new Date(now).toISOString(),
    verdict,
    ...(cleanNote ? { note: cleanNote } : {}),
  };
  document.updatedAt = new Date(now).toISOString();
  return document;
}

export function summarizeSearchHandoffReview(
  document: SearchHandoffReviewDocument,
): SearchHandoffReviewSummary {
  const launched = document.samples.filter((item) => item.launch);
  const assessed = launched.filter((item) => item.assessment);
  const launchedLanguages = [...new Set(launched.flatMap((item) =>
    item.languageCode ? [item.languageCode] : []))].sort();
  const comparisonEligible = launched.filter((item) => searchHandoffNoiseLabel(item));
  const comparisons = comparisonEligible.filter((item) => item.noiseComparison);
  const sourceOutcomes: SearchHandoffReviewSummary["sourceOutcomes"] = {};
  for (const item of launched) {
    for (const outcome of item.launch?.sourceOutcomes ?? []) {
      const source = sourceOutcomes[outcome.source] ?? { success: 0, error: 0, results: 0 };
      source[outcome.status] += 1;
      source.results += outcome.resultCount;
      sourceOutcomes[outcome.source] = source;
    }
  }
  const rankDelta = (item: SearchHandoffReviewItem): number =>
    (item.launch?.rankedTop5Relevant ?? 0) - (item.launch?.legacyTop5Relevant ?? 0);
  const launchedByMediaType = {
    movie: launched.filter((item) => item.mediaType === "movie").length,
    series: launched.filter((item) => item.mediaType === "series").length,
  };
  const appendedNoiseQueries = launched.filter((item) => item.appendedNoise).length;
  const productionQueryMismatches = launched.filter(
    (item) => !item.queryMatchesProductionBuilder || item.launch?.query !== item.query,
  ).length;
  const comparisonDelta = (item: SearchHandoffReviewItem): number =>
    (item.launch?.relevantResults ?? 0) - (item.noiseComparison?.relevantResults ?? 0);
  const cleanRelevantResults = comparisons.reduce(
    (total, item) => total + (item.launch?.relevantResults ?? 0),
    0,
  );
  const noisyRelevantResults = comparisons.reduce(
    (total, item) => total + (item.noiseComparison?.relevantResults ?? 0),
    0,
  );
  const cleanComparisonWins = comparisons.filter((item) => comparisonDelta(item) > 0).length;
  const noisyComparisonWins = comparisons.filter((item) => comparisonDelta(item) < 0).length;
  const cleanImprovedOverNoise = comparisons.length >= Math.min(5, comparisonEligible.length) &&
    cleanRelevantResults > noisyRelevantResults &&
    cleanComparisonWins > noisyComparisonWins;
  return {
    required: structuredClone(document.requirements),
    available: structuredClone(document.available),
    sampled: document.samples.length,
    launched: launched.length,
    assessed: assessed.length,
    passed: assessed.filter((item) => item.assessment?.verdict === "pass").length,
    errors: assessed.filter((item) => item.assessment?.verdict === "error").length,
    unverifiable: assessed.filter((item) => item.assessment?.verdict === "unverifiable").length,
    launchedByMediaType,
    launchedLanguages,
    appendedNoiseQueries,
    productionQueryMismatches,
    searchesWithResults: launched.filter((item) => (item.launch?.totalResults ?? 0) > 0).length,
    relevantTopResults: launched.filter((item) => item.launch?.topResultRelevant).length,
    rankingImproved: launched.filter((item) => rankDelta(item) > 0).length,
    rankingTied: launched.filter((item) => rankDelta(item) === 0).length,
    rankingRegressed: launched.filter((item) => rankDelta(item) < 0).length,
    noiseComparisonEligible: comparisonEligible.length,
    noiseComparisons: comparisons.length,
    cleanRelevantResults,
    noisyRelevantResults,
    cleanComparisonWins,
    comparisonTies: comparisons.filter((item) => comparisonDelta(item) === 0).length,
    noisyComparisonWins,
    cleanImprovedOverNoise,
    sourceOutcomes,
    complete: launched.length >= document.requirements.titles &&
      assessed.length >= document.requirements.titles &&
      launchedByMediaType.movie > 0 &&
      launchedByMediaType.series > 0 &&
      launchedLanguages.length >= document.requirements.languages &&
      appendedNoiseQueries === 0 &&
      productionQueryMismatches === 0 &&
      cleanImprovedOverNoise,
  };
}

function validReviewDocument(value: unknown): value is SearchHandoffReviewDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const document = value as Partial<SearchHandoffReviewDocument>;
  return document.version === SEARCH_HANDOFF_REVIEW_VERSION &&
    typeof document.createdAt === "string" &&
    Number.isFinite(Date.parse(document.createdAt)) &&
    typeof document.updatedAt === "string" &&
    Number.isFinite(Date.parse(document.updatedAt)) &&
    document.requirements?.titles === SEARCH_HANDOFF_REQUIRED &&
    document.requirements.languages === SEARCH_HANDOFF_REQUIRED_LANGUAGES &&
    Array.isArray(document.samples);
}

async function readReview(file: string): Promise<SearchHandoffReviewDocument | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    if (!validReviewDocument(value)) throw new Error("search-handoff review has an unsupported shape");
    return value;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function readSnapshots(file: string): Promise<DiscoverySnapshot[]> {
  const parsed = parseDiscoveryCache(JSON.parse(await fs.readFile(file, "utf8")) as unknown);
  if (parsed.documentError) throw new Error(`Discovery cache unavailable: ${parsed.documentError}`);
  if (parsed.rejectedEntries.length > 0) {
    throw new Error(`Discovery cache has ${parsed.rejectedEntries.length} rejected entries`);
  }
  return Object.values(parsed.document.entries).map((entry) => entry.snapshot);
}

function configuredSourceIds(): string[] {
  const configured = process.env.MINCH_HANDOFF_SOURCE_IDS?.trim();
  return [...new Set((configured ? configured.split(",") : DEFAULT_SOURCE_IDS)
    .map((id) => id.trim()).filter(Boolean))];
}

async function validationSources(config: Config): Promise<Source[]> {
  const registry = await buildRegistry(config);
  const requested = configuredSourceIds();
  const unknown = requested.filter((id) => !registry.byId.has(id));
  if (unknown.length > 0) throw new Error(`Unknown handoff source IDs: ${unknown.join(",")}`);
  const sources = requested.flatMap((id) => {
    const source = registry.byId.get(id)!;
    return isEnabled(source, config) && config.sources[id]?.health?.ok !== false ? [source] : [];
  });
  if (sources.length === 0) {
    throw new Error("None of the requested handoff sources are enabled and healthy");
  }
  return sources;
}

async function main(): Promise<void> {
  const directory = reviewDirectory();
  const cacheFile = path.join(directory, "discovery-cache.json");
  const reviewFile = path.join(directory, "search-handoff-review.json");
  const command = process.argv[2] ?? "status";
  if (command === "init") {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    const document = initializeSearchHandoffReview(
      await readSnapshots(cacheFile),
      await readReview(reviewFile),
    );
    await writeJsonAtomic(reviewFile, document, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(summarizeSearchHandoffReview(document), null, 2)}\n`);
    return;
  }
  const document = await readReview(reviewFile);
  if (!document) throw new Error("Run search-handoff review init first");
  if (command === "status") {
    process.stdout.write(`${JSON.stringify(summarizeSearchHandoffReview(document), null, 2)}\n`);
    return;
  }
  if (command === "list") {
    const state = process.argv[3] ?? "pending";
    if (!new Set(["pending", "launched", "assessed", "all"]).has(state)) {
      throw new Error("List state must be pending, launched, assessed, or all");
    }
    const items = document.samples.filter((item) =>
      state === "all" ||
      (state === "pending" && !item.launch) ||
      (state === "launched" && !!item.launch && !item.assessment) ||
      (state === "assessed" && !!item.assessment));
    process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
    return;
  }
  if (command === "run") {
    const rawCount = process.argv[3] ?? "1";
    const count = Number(rawCount);
    if (!Number.isSafeInteger(count) || count < 1 || count > SEARCH_HANDOFF_REQUIRED) {
      throw new Error(`Run count must be an integer from 1 to ${SEARCH_HANDOFF_REQUIRED}`);
    }
    const pending = document.samples.filter((item) => !item.launch).slice(0, count);
    if (pending.length === 0) throw new Error("No pending search-handoff samples");
    const config = await loadConfig();
    const sources = await validationSources(config);
    const writes = serializeWrites();
    await mapPool(pending, 2, async (item) => {
      await launchSearchHandoffItem(item, sources, config);
      document.updatedAt = new Date().toISOString();
      await writes(() => writeJsonAtomic(reviewFile, document, { mode: 0o600 }));
    });
    await writes.flush();
    process.stdout.write(`${JSON.stringify(summarizeSearchHandoffReview(document), null, 2)}\n`);
    return;
  }
  if (command === "compare-noise") {
    const rawCount = process.argv[3] ?? String(SEARCH_HANDOFF_REQUIRED);
    const count = Number(rawCount);
    if (!Number.isSafeInteger(count) || count < 1 || count > SEARCH_HANDOFF_REQUIRED) {
      throw new Error(`Comparison count must be an integer from 1 to ${SEARCH_HANDOFF_REQUIRED}`);
    }
    const pending = document.samples.filter((item) =>
      !!item.launch && !!searchHandoffNoiseLabel(item) && !item.noiseComparison).slice(0, count);
    if (pending.length === 0) throw new Error("No pending provider/format noise comparisons");
    const config = await loadConfig();
    const sources = await validationSources(config);
    const writes = serializeWrites();
    await mapPool(pending, 2, async (item) => {
      await launchSearchHandoffNoiseComparison(item, sources, config);
      document.updatedAt = new Date().toISOString();
      await writes(() => writeJsonAtomic(reviewFile, document, { mode: 0o600 }));
    });
    await writes.flush();
    process.stdout.write(`${JSON.stringify(summarizeSearchHandoffReview(document), null, 2)}\n`);
    return;
  }
  if (command === "record") {
    const id = process.argv[3];
    const verdict = process.argv[4] as SearchHandoffVerdict | undefined;
    if (!id || !verdict || !new Set(["pass", "error", "unverifiable"]).has(verdict)) {
      throw new Error("Usage: record <id> <pass|error|unverifiable> [note]");
    }
    recordSearchHandoffAssessment(document, id, verdict, process.argv.slice(5).join(" "));
    await writeJsonAtomic(reviewFile, document, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(summarizeSearchHandoffReview(document), null, 2)}\n`);
    return;
  }
  if (command === "reset") {
    const id = process.argv[3];
    const item = document.samples.find((sample) => sample.id === id);
    if (!item) throw new Error(`Unknown search-handoff sample: ${sanitizeDiscoveryText(id ?? "")}`);
    delete item.launch;
    delete item.noiseComparison;
    delete item.assessment;
    document.updatedAt = new Date().toISOString();
    await writeJsonAtomic(reviewFile, document, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(summarizeSearchHandoffReview(document), null, 2)}\n`);
    return;
  }
  if (command === "finalize") {
    const summary = summarizeSearchHandoffReview(document);
    if (!summary.complete) {
      throw new Error(
        `Search-handoff review incomplete: launched ${summary.launched}/${summary.required.titles}, assessed ${summary.assessed}/${summary.required.titles}, media movie=${summary.launchedByMediaType.movie} series=${summary.launchedByMediaType.series}, languages ${summary.launchedLanguages.length}/${summary.required.languages}`,
      );
    }
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  throw new Error(
    "Usage: search-handoff review [init|status|list|run|compare-noise|record|reset|finalize]",
  );
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  main().catch((error: unknown) => {
    const message = sanitizeDiscoveryText(
      error instanceof Error ? error.message : String(error),
      [
        process.env.TMDB_READ_TOKEN ?? "",
        process.env.STREAMING_AVAILABILITY_API_KEY ?? "",
      ],
    );
    process.stderr.write(`Discovery search-handoff review failed: ${message || "unknown error"}\n`);
    process.exitCode = 1;
  });
}
