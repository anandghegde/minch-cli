import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { DiscoverySnapshot } from "../src/discovery/adapter";
import { aggregateDiscoverySnapshots } from "../src/discovery/aggregate";
import { parseDiscoveryCache } from "../src/discovery/cache";
import { sanitizeDiscoveryText } from "../src/discovery/security";
import type {
  CatalogTitle,
  DiscoverySource,
  EvidenceConfidence,
  ReleaseEvent,
} from "../src/discovery/types";
import { indiaToday } from "../src/discovery/dates";
import { writeJsonAtomic } from "../src/util/atomic";

export const RELEVANCE_REVIEW_VERSION = 1 as const;
export const RELEVANCE_REQUIRED_OTT = 30;
export const RELEVANCE_REQUIRED_PHYSICAL = 20;

export type RelevanceCategory = "ott" | "physical";
export type RelevanceErrorType =
  | "title"
  | "date"
  | "provider_or_format"
  | "region"
  | "duplicate_behavior";
export type RelevanceVerdict = "pass" | "error" | "unverifiable";

export const RELEVANCE_ERROR_TYPES: readonly RelevanceErrorType[] = [
  "title",
  "date",
  "provider_or_format",
  "region",
  "duplicate_behavior",
];

export interface RelevanceReviewJudgment {
  reviewedAt: string;
  verdict: RelevanceVerdict;
  errorTypes: RelevanceErrorType[];
  note?: string;
}

export interface RelevanceReviewItem {
  id: string;
  category: RelevanceCategory;
  source: DiscoverySource;
  title: string;
  year?: number;
  mediaType: CatalogTitle["mediaType"];
  kind: ReleaseEvent["kind"];
  date?: string;
  providerOrFormat?: string;
  region: string;
  confidence: EvidenceConfidence;
  sourceUrl?: string;
  evidenceRefs: Array<{
    source: DiscoverySource;
    sourceId?: string;
    sourceUrl?: string;
    confidence: EvidenceConfidence;
    /** Raw upstream change time, retained only when encoded in the source record ID. */
    sourceTimestampUnixSeconds?: number;
    sourceTimestampIndiaDate?: string;
  }>;
  duplicateContext: {
    mergedEvidenceCount: number;
    relatedTitleEventCount: number;
  };
  judgment?: RelevanceReviewJudgment;
}

export interface RelevanceReviewDocument {
  version: typeof RELEVANCE_REVIEW_VERSION;
  createdAt: string;
  updatedAt: string;
  requirements: { ott: number; physical: number };
  available: { ott: number; physical: number };
  samples: RelevanceReviewItem[];
}

export interface RelevanceReviewSummary {
  required: { ott: number; physical: number };
  available: { ott: number; physical: number };
  sampled: { ott: number; physical: number };
  reviewed: { ott: number; physical: number };
  passed: { ott: number; physical: number };
  errors: { ott: number; physical: number };
  unverifiable: { ott: number; physical: number };
  checkedFields: number;
  correctFields: number;
  highConfidenceEvents: number;
  highConfidenceCorrectEvents: number;
  highConfidenceEventAccuracy: number | null;
  errorsBySourceAndType: Partial<
    Record<DiscoverySource, Partial<Record<RelevanceErrorType, number>>>
  >;
  complete: boolean;
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

function categoryFor(event: ReleaseEvent): RelevanceCategory | undefined {
  if (event.kind === "streaming_added" || event.kind === "streaming_upcoming") return "ott";
  if (event.kind === "physical" || event.kind === "bluray" || event.kind === "uhd_bluray") {
    return "physical";
  }
  return undefined;
}

function primarySource(event: ReleaseEvent): DiscoverySource {
  return [...event.evidence]
    .sort((left, right) => left.source.localeCompare(right.source))[0]!.source;
}

function strongestConfidence(event: ReleaseEvent): EvidenceConfidence {
  if (event.evidence.some((evidence) => evidence.confidence === "exact")) return "exact";
  if (event.evidence.some((evidence) => evidence.confidence === "source_claim")) {
    return "source_claim";
  }
  return "inferred";
}

function safeUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password) return undefined;
    return sanitizeDiscoveryText(url.href) || undefined;
  } catch {
    return undefined;
  }
}

function evidenceRefs(event: ReleaseEvent): RelevanceReviewItem["evidenceRefs"] {
  return event.evidence.map((evidence) => {
    const sourceId = evidence.sourceId
      ? sanitizeDiscoveryText(evidence.sourceId)
      : undefined;
    const sourceUrl = safeUrl(evidence.sourceUrl);
    const timestampMatch = evidence.source === "streaming-availability"
      ? /:(\d{10})$/.exec(sourceId ?? "")
      : undefined;
    const timestamp = timestampMatch ? Number(timestampMatch[1]) : undefined;
    return {
      source: evidence.source,
      ...(sourceId ? { sourceId } : {}),
      ...(sourceUrl ? { sourceUrl } : {}),
      confidence: evidence.confidence,
      ...(timestamp !== undefined
        ? {
            sourceTimestampUnixSeconds: timestamp,
            sourceTimestampIndiaDate: indiaToday(timestamp * 1_000),
          }
        : {}),
    };
  }).sort((left, right) =>
    left.source.localeCompare(right.source) ||
    (left.sourceId ?? "").localeCompare(right.sourceId ?? ""));
}

function itemFor(
  event: ReleaseEvent,
  title: CatalogTitle,
  relatedTitleEventCount: number,
): RelevanceReviewItem {
  const category = categoryFor(event)!;
  const source = primarySource(event);
  const providerOrFormat = event.providerLabel ?? event.formatLabel;
  const id = `${category}-${stableHash([
    source,
    event.id,
    title.id,
    event.date ?? "",
    event.providerId ?? event.formatLabel ?? "",
    event.region,
  ].join("\u0000")).slice(0, 16)}`;
  const refs = evidenceRefs(event);
  const sourceUrl = refs.find((evidence) => evidence.sourceUrl)?.sourceUrl;
  return {
    id,
    category,
    source,
    title: sanitizeDiscoveryText(title.title),
    ...(title.year !== undefined ? { year: title.year } : {}),
    mediaType: title.mediaType,
    kind: event.kind,
    ...(event.date ? { date: event.date } : {}),
    ...(providerOrFormat
      ? { providerOrFormat: sanitizeDiscoveryText(providerOrFormat) }
      : {}),
    region: event.region,
    confidence: strongestConfidence(event),
    ...(sourceUrl ? { sourceUrl } : {}),
    evidenceRefs: refs,
    duplicateContext: {
      mergedEvidenceCount: event.evidence.length,
      relatedTitleEventCount,
    },
  };
}

/**
 * Select canonical events, not raw cache rows, so repeated retained snapshots do
 * not silently consume the human-review quota. Buckets are interleaved to keep
 * providers/formats and media types represented before any one bucket dominates.
 */
export function relevanceCandidates(
  snapshots: readonly DiscoverySnapshot[],
): Record<RelevanceCategory, RelevanceReviewItem[]> {
  const aggregation = aggregateDiscoverySnapshots(snapshots, {
    includeGenericPhysical: true,
    includeStreamingUpcoming: true,
  });
  const titleById = new Map(aggregation.titles.map((title) => [title.id, title]));
  const eventsByTitle = new Map<string, number>();
  for (const event of aggregation.events) {
    eventsByTitle.set(event.titleId, (eventsByTitle.get(event.titleId) ?? 0) + 1);
  }
  const candidates: Record<RelevanceCategory, RelevanceReviewItem[]> = {
    ott: [],
    physical: [],
  };
  for (const event of aggregation.events) {
    const category = categoryFor(event);
    const title = titleById.get(event.titleId);
    if (!category || !title || event.evidence.length === 0) continue;
    candidates[category].push(itemFor(
      event,
      title,
      Math.max(0, (eventsByTitle.get(event.titleId) ?? 1) - 1),
    ));
  }
  for (const category of ["ott", "physical"] as const) {
    const buckets = new Map<string, RelevanceReviewItem[]>();
    for (const item of candidates[category]) {
      const key = [item.source, item.providerOrFormat ?? item.kind, item.mediaType].join(":");
      const bucket = buckets.get(key) ?? [];
      bucket.push(item);
      buckets.set(key, bucket);
    }
    const orderedBuckets = [...buckets.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, bucket]) => bucket.sort((left, right) => left.id.localeCompare(right.id)));
    const interleaved: RelevanceReviewItem[] = [];
    for (let index = 0; orderedBuckets.some((bucket) => index < bucket.length); index += 1) {
      for (const bucket of orderedBuckets) {
        const item = bucket[index];
        if (item) interleaved.push(item);
      }
    }
    candidates[category] = interleaved;
  }
  return candidates;
}

export function initializeRelevanceReview(
  snapshots: readonly DiscoverySnapshot[],
  existing: RelevanceReviewDocument | undefined,
  now = Date.now(),
): RelevanceReviewDocument {
  const candidates = relevanceCandidates(snapshots);
  const nowIso = new Date(now).toISOString();
  const candidateById = new Map(
    [...candidates.ott, ...candidates.physical].map((item) => [item.id, item]),
  );
  const retained = existing?.samples.map((item) => {
    const refreshed = candidateById.get(item.id);
    return refreshed
      ? { ...structuredClone(refreshed), ...(item.judgment ? { judgment: item.judgment } : {}) }
      : structuredClone(item);
  }) ?? [];
  const retainedIds = new Set(retained.map((item) => item.id));
  for (const category of ["ott", "physical"] as const) {
    const required = category === "ott" ? RELEVANCE_REQUIRED_OTT : RELEVANCE_REQUIRED_PHYSICAL;
    let count = retained.filter((item) => item.category === category).length;
    for (const item of candidates[category]) {
      if (count >= required) break;
      if (retainedIds.has(item.id)) continue;
      retained.push(item);
      retainedIds.add(item.id);
      count += 1;
    }
  }
  return {
    version: RELEVANCE_REVIEW_VERSION,
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
    requirements: { ott: RELEVANCE_REQUIRED_OTT, physical: RELEVANCE_REQUIRED_PHYSICAL },
    available: { ott: candidates.ott.length, physical: candidates.physical.length },
    samples: retained.sort((left, right) =>
      left.category.localeCompare(right.category) || left.id.localeCompare(right.id)),
  };
}

export function recordRelevanceJudgment(
  document: RelevanceReviewDocument,
  id: string,
  verdict: RelevanceVerdict,
  errorTypes: readonly RelevanceErrorType[],
  note: string | undefined,
  now = Date.now(),
): RelevanceReviewDocument {
  const item = document.samples.find((sample) => sample.id === id);
  if (!item) throw new Error(`Unknown relevance sample: ${sanitizeDiscoveryText(id)}`);
  const errors = [...new Set(errorTypes)];
  if (errors.some((type) => !RELEVANCE_ERROR_TYPES.includes(type))) {
    throw new Error("Unknown relevance error type");
  }
  if (verdict === "pass" && errors.length > 0) {
    throw new Error("A passing review cannot contain errors");
  }
  if (verdict === "error" && errors.length === 0) {
    throw new Error("An error review must name at least one error type");
  }
  if (verdict === "unverifiable" && errors.length > 0) {
    throw new Error("An unverifiable review cannot claim field errors");
  }
  const cleanedNote = note ? sanitizeDiscoveryText(note) : "";
  if (verdict === "unverifiable" && !cleanedNote) {
    throw new Error("An unverifiable review must explain what evidence is missing");
  }
  item.judgment = {
    reviewedAt: new Date(now).toISOString(),
    verdict,
    errorTypes: errors.sort(),
    ...(cleanedNote ? { note: cleanedNote } : {}),
  };
  document.updatedAt = new Date(now).toISOString();
  return document;
}

function countByCategory(
  items: readonly RelevanceReviewItem[],
  predicate: (item: RelevanceReviewItem) => boolean,
): { ott: number; physical: number } {
  return {
    ott: items.filter((item) => item.category === "ott" && predicate(item)).length,
    physical: items.filter((item) => item.category === "physical" && predicate(item)).length,
  };
}

export function summarizeRelevanceReview(
  document: RelevanceReviewDocument,
): RelevanceReviewSummary {
  const sampled = countByCategory(document.samples, () => true);
  const reviewed = countByCategory(
    document.samples,
    (item) => item.judgment?.verdict === "pass" || item.judgment?.verdict === "error",
  );
  const passed = countByCategory(document.samples, (item) => item.judgment?.verdict === "pass");
  const errors = countByCategory(document.samples, (item) => item.judgment?.verdict === "error");
  const unverifiable = countByCategory(
    document.samples,
    (item) => item.judgment?.verdict === "unverifiable",
  );
  const reviewedItems = document.samples.filter(
    (item) => item.judgment?.verdict === "pass" || item.judgment?.verdict === "error",
  );
  const checkedFields = reviewedItems.length * RELEVANCE_ERROR_TYPES.length;
  const incorrectFields = reviewedItems.reduce(
    (total, item) => total + (item.judgment?.errorTypes.length ?? 0),
    0,
  );
  const metricErrorTypes = new Set<RelevanceErrorType>([
    "title",
    "date",
    "provider_or_format",
  ]);
  const highConfidenceItems = reviewedItems.filter((item) => item.confidence !== "inferred");
  const highConfidenceCorrectEvents = highConfidenceItems.filter((item) =>
    !item.judgment?.errorTypes.some((type) => metricErrorTypes.has(type))).length;
  const errorsBySourceAndType: RelevanceReviewSummary["errorsBySourceAndType"] = {};
  for (const item of reviewedItems) {
    for (const type of item.judgment?.errorTypes ?? []) {
      const source = errorsBySourceAndType[item.source] ?? {};
      source[type] = (source[type] ?? 0) + 1;
      errorsBySourceAndType[item.source] = source;
    }
  }
  return {
    required: { ...document.requirements },
    available: { ...document.available },
    sampled,
    reviewed,
    passed,
    errors,
    unverifiable,
    checkedFields,
    correctFields: checkedFields - incorrectFields,
    highConfidenceEvents: highConfidenceItems.length,
    highConfidenceCorrectEvents,
    highConfidenceEventAccuracy: highConfidenceItems.length > 0
      ? highConfidenceCorrectEvents / highConfidenceItems.length
      : null,
    errorsBySourceAndType,
    complete: reviewed.ott >= document.requirements.ott &&
      reviewed.physical >= document.requirements.physical,
  };
}

function validReviewDocument(value: unknown): value is RelevanceReviewDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const document = value as Partial<RelevanceReviewDocument>;
  return document.version === RELEVANCE_REVIEW_VERSION &&
    typeof document.createdAt === "string" &&
    Number.isFinite(Date.parse(document.createdAt)) &&
    typeof document.updatedAt === "string" &&
    Number.isFinite(Date.parse(document.updatedAt)) &&
    !!document.requirements &&
    document.requirements.ott === RELEVANCE_REQUIRED_OTT &&
    document.requirements.physical === RELEVANCE_REQUIRED_PHYSICAL &&
    !!document.available &&
    Array.isArray(document.samples);
}

async function readReview(file: string): Promise<RelevanceReviewDocument | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    if (!validReviewDocument(value)) throw new Error("relevance review has an unsupported shape");
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

function parseErrorTypes(value: string | undefined): RelevanceErrorType[] {
  if (!value) return [];
  const types = value.split(",").filter(Boolean) as RelevanceErrorType[];
  if (types.some((type) => !RELEVANCE_ERROR_TYPES.includes(type))) {
    throw new Error(`Error types must be: ${RELEVANCE_ERROR_TYPES.join(",")}`);
  }
  return types;
}

async function main(): Promise<void> {
  const directory = reviewDirectory();
  const cacheFile = path.join(directory, "discovery-cache.json");
  const reviewFile = path.join(directory, "relevance-review.json");
  const command = process.argv[2] ?? "status";
  if (command === "init") {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    const document = initializeRelevanceReview(
      await readSnapshots(cacheFile),
      await readReview(reviewFile),
    );
    await writeJsonAtomic(reviewFile, document, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(summarizeRelevanceReview(document), null, 2)}\n`);
    return;
  }
  const document = await readReview(reviewFile);
  if (!document) throw new Error("Run relevance review init first");
  if (command === "status") {
    process.stdout.write(`${JSON.stringify(summarizeRelevanceReview(document), null, 2)}\n`);
    return;
  }
  if (command === "list") {
    const category = process.argv[3];
    const state = process.argv[4] ?? "pending";
    if (category && category !== "ott" && category !== "physical") {
      throw new Error("List category must be ott or physical");
    }
    if (!new Set(["pending", "reviewed", "all"]).has(state)) {
      throw new Error("List state must be pending, reviewed, or all");
    }
    const items = document.samples.filter((item) =>
      (!category || item.category === category) &&
      (state === "all" || (state === "pending" ? !item.judgment : !!item.judgment)));
    process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
    return;
  }
  if (command === "record") {
    const id = process.argv[3];
    const verdict = process.argv[4] as RelevanceVerdict | undefined;
    if (!id || !verdict || !new Set(["pass", "error", "unverifiable"]).has(verdict)) {
      throw new Error("Usage: record <id> <pass|error|unverifiable> [error-types] [note]");
    }
    const errors = verdict === "error" ? parseErrorTypes(process.argv[5]) : [];
    const noteIndex = verdict === "error" ? 6 : 5;
    recordRelevanceJudgment(document, id, verdict, errors, process.argv.slice(noteIndex).join(" "));
    await writeJsonAtomic(reviewFile, document, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(summarizeRelevanceReview(document), null, 2)}\n`);
    return;
  }
  if (command === "reset") {
    const id = process.argv[3];
    const item = document.samples.find((sample) => sample.id === id);
    if (!item) throw new Error(`Unknown relevance sample: ${sanitizeDiscoveryText(id ?? "")}`);
    delete item.judgment;
    document.updatedAt = new Date().toISOString();
    await writeJsonAtomic(reviewFile, document, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(summarizeRelevanceReview(document), null, 2)}\n`);
    return;
  }
  if (command === "finalize") {
    const summary = summarizeRelevanceReview(document);
    if (!summary.complete) {
      throw new Error(
        `Relevance review incomplete: OTT ${summary.reviewed.ott}/${summary.required.ott}, physical ${summary.reviewed.physical}/${summary.required.physical}`,
      );
    }
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  throw new Error("Usage: relevance review [init|status|list|record|reset|finalize]");
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  void main().catch((error: unknown) => {
    const message = sanitizeDiscoveryText(
      error instanceof Error ? error.message : String(error),
      [
        process.env.TMDB_READ_TOKEN ?? "",
        process.env.STREAMING_AVAILABILITY_API_KEY ?? "",
      ],
    );
    process.stderr.write(`Discovery relevance review failed: ${message || "unknown error"}\n`);
    process.exitCode = 1;
  });
}
