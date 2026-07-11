import { normalizeBlurayIdentityTitle } from "./sources/bluray";
import type {
  CatalogTitle,
  EvidenceConfidence,
  ReleaseEvent,
  SourceEvidence,
} from "./types";
import { isWithinDateRange } from "./dates";

export interface PhysicalEventResolution {
  identityKey: string;
  formatGroup: "disc" | "uhd";
  displayEvent: ReleaseEvent;
  /** Original, unmodified claims retained for details/diagnostics. */
  claims: ReleaseEvent[];
  sourcesDisagree: boolean;
}

const CONFIDENCE: Record<EvidenceConfidence, number> = {
  exact: 3,
  source_claim: 2,
  inferred: 1,
};

function evidenceKey(evidence: SourceEvidence): string {
  return [
    evidence.source,
    evidence.sourceId ?? "",
    evidence.sourceUrl ?? "",
    evidence.observedAt,
    evidence.confidence,
  ].join("\u0000");
}

function mergeEvidence(events: ReleaseEvent[]): SourceEvidence[] {
  const byKey = new Map<string, SourceEvidence>();
  for (const event of events) {
    for (const evidence of event.evidence) byKey.set(evidenceKey(evidence), evidence);
  }
  return [...byKey.values()];
}

function confidence(event: ReleaseEvent): number {
  return Math.max(0, ...event.evidence.map((item) => CONFIDENCE[item.confidence]));
}

function specificity(event: ReleaseEvent): number {
  if (event.kind === "uhd_bluray") return 3;
  if (event.kind === "bluray") return 2;
  return 1;
}

function titleIdentity(title: CatalogTitle | undefined, titleId: string): string {
  if (!title) return `local:${titleId}`;
  if (title.tmdbId !== undefined) return `${title.mediaType}:tmdb:${title.tmdbId}`;
  if (title.imdbId) return `${title.mediaType}:imdb:${title.imdbId}`;
  if (title.year !== undefined) {
    return `${title.mediaType}:title:${normalizeBlurayIdentityTitle(title.title)}:${title.year}`;
  }
  return `local:${title.id}`;
}

function duplicateKey(event: ReleaseEvent): string {
  return [
    event.region,
    event.kind,
    event.date ?? "",
    event.datePrecision,
    event.formatLabel ?? "",
  ].join("\u0000");
}

function mergeDuplicates(events: ReleaseEvent[]): ReleaseEvent[] {
  const grouped = new Map<string, ReleaseEvent[]>();
  for (const event of events) {
    const key = duplicateKey(event);
    const bucket = grouped.get(key) ?? [];
    bucket.push(event);
    grouped.set(key, bucket);
  }
  return [...grouped.values()].map((bucket) => {
    const first = bucket.slice().sort((a, b) => a.id.localeCompare(b.id))[0]!;
    return {
      ...first,
      firstObservedAt: Math.min(...bucket.map((event) => event.firstObservedAt)),
      lastObservedAt: Math.max(...bucket.map((event) => event.lastObservedAt)),
      evidence: mergeEvidence(bucket),
    };
  });
}

function chooseDisplay(events: ReleaseEvent[], sourcesDisagree: boolean): ReleaseEvent {
  return events.slice().sort((a, b) => {
    const sameDate = (a.date ?? "") === (b.date ?? "");
    if (sameDate && specificity(a) !== specificity(b)) return specificity(b) - specificity(a);
    if (confidence(a) !== confidence(b)) return confidence(b) - confidence(a);
    if (!!a.date !== !!b.date) return a.date ? -1 : 1;
    // Specificity is deliberately not allowed to decide conflicting dates.
    if (!sourcesDisagree && specificity(a) !== specificity(b)) return specificity(b) - specificity(a);
    return a.id.localeCompare(b.id);
  })[0]!;
}

/**
 * Reconcile physical claims without losing their original evidence. UHD remains
 * distinct; generic physical and Blu-ray claims share a disc group.
 */
export function reconcilePhysicalEvents(
  titles: CatalogTitle[],
  events: ReleaseEvent[],
): PhysicalEventResolution[] {
  const titleById = new Map(titles.map((title) => [title.id, title]));
  const groups = new Map<string, { identityKey: string; formatGroup: "disc" | "uhd"; claims: ReleaseEvent[] }>();
  for (const event of events) {
    if (event.kind !== "physical" && event.kind !== "bluray" && event.kind !== "uhd_bluray") {
      continue;
    }
    const identityKey = titleIdentity(titleById.get(event.titleId), event.titleId);
    const formatGroup = event.kind === "uhd_bluray" ? "uhd" : "disc";
    const key = `${identityKey}\u0000${formatGroup}`;
    const group = groups.get(key) ?? { identityKey, formatGroup, claims: [] };
    group.claims.push(event);
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => {
      const merged = mergeDuplicates(group.claims);
      const knownDates = new Set(merged.flatMap((event) => event.date ? [event.date] : []));
      const sourcesDisagree = knownDates.size > 1;
      return {
        identityKey: group.identityKey,
        formatGroup: group.formatGroup,
        displayEvent: chooseDisplay(merged, sourcesDisagree),
        claims: group.claims,
        sourcesDisagree,
      };
    })
    .sort((a, b) =>
      a.identityKey.localeCompare(b.identityKey) || a.formatGroup.localeCompare(b.formatGroup));
}

/** All-view passthrough or an exact known-date inclusive physical window. */
export function filterPhysicalEventsByDate(
  events: ReleaseEvent[],
  range?: { start: string; end: string },
): ReleaseEvent[] {
  if (!range) return events;
  return events.filter((event) => isWithinDateRange(event.date, range.start, range.end));
}
