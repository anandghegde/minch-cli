import { describe, expect, it } from "vitest";
import type { DiscoverySnapshot } from "../../src/discovery/adapter";
import {
  buildDiscoveryDiagnostics,
  canonicalizeSnapshotEvents,
  canonicalizeSnapshotTitles,
} from "../../src/discovery/aggregate";
import type { CatalogTitle, ReleaseEvent } from "../../src/discovery/types";

function title(id: string): CatalogTitle {
  return {
    id,
    title: "Diagnostic Film",
    year: 2026,
    mediaType: "movie",
    originCountries: [],
    genreIds: [],
  };
}

function event(
  id: string,
  titleId: string,
  date: string | undefined,
  source: "tmdb" | "streaming-availability",
): ReleaseEvent {
  return {
    id,
    titleId,
    kind: "streaming_added",
    region: "IN",
    ...(date ? { date } : {}),
    datePrecision: date ? "day" : "unknown",
    providerId: "netflix",
    providerLabel: "Netflix",
    status: date ? "past" : "unknown",
    firstObservedAt: 1,
    lastObservedAt: 1,
    evidence: [{ source, sourceId: id, observedAt: 1, confidence: "exact" }],
  };
}

describe("discovery aggregate diagnostics", () => {
  it("counts conflicts, duplicates, unknowns, missing metadata, and source contribution", () => {
    const shared = title("streaming:title");
    const streaming: DiscoverySnapshot = {
      source: "streaming-availability",
      feedKind: "streaming_added",
      titles: [shared],
      events: [
        event("same-a", shared.id, "2026-07-10", "streaming-availability"),
        event("same-b", shared.id, "2026-07-10", "streaming-availability"),
        event("conflict", shared.id, "2026-07-09", "streaming-availability"),
        event("unknown", shared.id, undefined, "streaming-availability"),
        event("orphan", "missing:title", "2026-07-08", "streaming-availability"),
      ],
      fetchedAt: 1,
      warnings: [],
    };
    const tmdb: DiscoverySnapshot = {
      source: "tmdb",
      feedKind: "trending",
      titles: [{ ...shared, id: "tmdb:title" }],
      events: [],
      fetchedAt: 1,
      warnings: [],
    };
    const snapshots = [streaming, tmdb];
    const identities = canonicalizeSnapshotTitles(snapshots);
    const events = canonicalizeSnapshotEvents(
      snapshots,
      identities.canonicalIdBySourceTitleId,
    );

    const diagnostics = buildDiscoveryDiagnostics(snapshots, identities, events);

    expect(diagnostics).toMatchObject({
      ambiguousIdentity: 0,
      unresolvedIdentity: 1,
      unknownDate: 1,
      conflictingDate: 1,
      duplicateEvents: 1,
      missingMetadata: 1,
      sourceContribution: {
        tmdb: { snapshots: 1, titles: 1, events: 0, evidence: 0 },
        "streaming-availability": {
          snapshots: 1,
          titles: 1,
          events: 5,
          evidence: 5,
        },
      },
    });
    expect(diagnostics.sourceContribution.bluray).toEqual({
      snapshots: 0,
      titles: 0,
      events: 0,
      evidence: 0,
    });
  });
});
