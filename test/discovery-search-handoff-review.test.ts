import { describe, expect, it } from "vitest";
import {
  evaluateSearchHandoffResults,
  initializeSearchHandoffReview,
  launchSearchHandoffItem,
  launchSearchHandoffNoiseComparison,
  recordSearchHandoffAssessment,
  searchHandoffCandidates,
  summarizeSearchHandoffReview,
} from "../scripts/discovery-search-handoff-review";
import type { DiscoverySnapshot } from "../src/discovery/adapter";
import { buildDiscoverySearchQuery } from "../src/discovery/search-handoff";
import type { CatalogTitle, ReleaseEvent } from "../src/discovery/types";
import { defaultConfig } from "../src/config/config";
import type { Source, TorrentResult } from "../src/sources/types";

const LANGUAGES = ["hi", "ta", "te", "en"] as const;

function title(index: number): CatalogTitle {
  return {
    id: `title-${index}`,
    title: `Example ${index}`,
    year: 2026,
    mediaType: index % 2 === 0 ? "movie" : "series",
    originalLanguage: LANGUAGES[index % LANGUAGES.length],
    originCountries: index % 3 === 0 ? ["IN"] : [],
    genreIds: [],
  };
}

function event(index: number): ReleaseEvent {
  return {
    id: `event-${index}`,
    titleId: `title-${index}`,
    kind: index % 2 === 0 ? "streaming_added" : "bluray",
    region: index % 2 === 0 ? "IN" : "ZZ",
    date: "2026-07-10",
    datePrecision: "day",
    ...(index % 2 === 0
      ? { providerId: "netflix", providerLabel: "Netflix" }
      : { formatLabel: "Blu-ray" }),
    status: "past",
    firstObservedAt: 1,
    lastObservedAt: 1,
    evidence: [{
      source: index % 2 === 0 ? "streaming-availability" : "bluray",
      observedAt: 1,
      confidence: "source_claim",
    }],
  };
}

function snapshots(): DiscoverySnapshot[] {
  return [{
    source: "streaming-availability",
    feedKind: "streaming_added",
    titles: Array.from({ length: 24 }, (_, index) => title(index)),
    events: Array.from({ length: 24 }, (_, index) => event(index)),
    fetchedAt: 1,
    warnings: [],
  }];
}

function result(name: string, seeders: number, source = "fake"): TorrentResult {
  return {
    infoHash: `${name}-${seeders}`,
    name,
    sizeBytes: 1_000,
    seeders,
    leechers: 0,
    source,
    sourceLabel: source,
    magnet: "magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  };
}

function source(id: string): Source {
  return {
    id,
    label: id,
    kind: "api",
    links: ["https://example.test"],
    requiresConfig: false,
    defaultEnabled: true,
    test: async () => ({ ok: true, status: "ok" }),
    search: async () => [],
  };
}

describe("P11.3 discovery search-handoff review", () => {
  it("selects a deterministic 20-title movie/series/language sample with clean queries", () => {
    const candidates = searchHandoffCandidates(snapshots());
    expect(candidates).toHaveLength(24);
    expect(new Set(candidates.map((item) => item.mediaType))).toEqual(new Set(["movie", "series"]));
    expect(new Set(candidates.flatMap((item) => item.languageCode ? [item.languageCode] : [])).size)
      .toBe(4);
    expect(candidates.every((item) => item.query === `${item.title} ${item.year}`)).toBe(true);
    expect(candidates.every((item) => !item.query.includes("Netflix") &&
      !item.query.includes("Blu-ray") && !item.appendedNoise)).toBe(true);

    const first = initializeSearchHandoffReview(snapshots(), undefined, 1_000);
    const second = initializeSearchHandoffReview(snapshots(), undefined, 1_000);
    expect(second).toEqual(first);
    expect(first.samples).toHaveLength(20);
    expect(first.available).toMatchObject({ titles: 24, movies: 12, series: 12 });
    expect(new Set(first.samples.map((item) => item.mediaType))).toEqual(
      new Set(["movie", "series"]),
    );
    expect(new Set(first.samples.flatMap((item) => item.languageCode ? [item.languageCode] : []))
      .size).toBeGreaterThanOrEqual(3);
    expect(buildDiscoverySearchQuery({ title: "  Clean\u0000 Title  ", year: 2026 }))
      .toBe("Clean Title 2026");
  });

  it("measures relevance lift and requires launched, assessed, diverse, noise-free rows", async () => {
    const document = initializeSearchHandoffReview(snapshots(), undefined, 1_000);
    const first = document.samples[0]!;
    const noisy = Array.from({ length: 5 }, (_, index) => result(`Unrelated ${index}`, 500 - index));
    const matching = [
      result(`${first.title} ${first.year} 1080p WEB-DL`, 2),
      result(`${first.title} ${first.year} 720p`, 1),
    ];
    const evaluated = evaluateSearchHandoffResults(first, [...noisy, ...matching]);
    expect(evaluated).toMatchObject({
      totalResults: 7,
      relevantResults: 2,
      rankedTop5Relevant: 2,
      legacyTop5Relevant: 0,
      topResultRelevant: true,
    });

    await launchSearchHandoffItem(
      first,
      [source("ok"), source("failed")],
      defaultConfig,
      async (current) => {
        if (current.id === "failed") throw new Error("secret upstream detail");
        return [...noisy, ...matching];
      },
      2_000,
    );
    expect(first.launch?.sourceOutcomes).toEqual([
      { source: "failed", sourceLabel: "failed", status: "error", resultCount: 0,
        errorCode: "no response" },
      { source: "ok", sourceLabel: "ok", status: "success", resultCount: 7 },
    ]);
    expect(JSON.stringify(first.launch)).not.toContain("secret upstream detail");
    recordSearchHandoffAssessment(document, first.id, "pass", undefined, 3_000);
    first.providerLabels = ["Netflix"];
    await launchSearchHandoffNoiseComparison(
      first,
      [source("ok")],
      defaultConfig,
      async (_source, query) => query.endsWith("Netflix") ? [] : matching,
      2_500,
    );
    expect(first.noiseComparison).toMatchObject({
      noiseLabel: "Netflix",
      totalResults: 0,
      relevantResults: 0,
      topResultRelevant: false,
    });
    expect(() => recordSearchHandoffAssessment(
      document,
      document.samples[1]!.id,
      "pass",
      undefined,
    )).toThrow("Launch");

    for (const item of document.samples.slice(1)) {
      item.providerLabels = ["Netflix"];
      item.launch = {
        launchedAt: new Date(2_000).toISOString(),
        query: item.query,
        sourceOutcomes: [{
          source: "ok",
          sourceLabel: "ok",
          status: "success",
          resultCount: 1,
        }],
        totalResults: 1,
        relevantResults: 1,
        rankedTop5Relevant: 1,
        legacyTop5Relevant: 1,
        topResultRelevant: true,
        results: [],
      };
      item.noiseComparison = {
        launchedAt: new Date(2_500).toISOString(),
        noiseLabel: "Netflix",
        query: `${item.query} Netflix`,
        sourceOutcomes: [],
        totalResults: 0,
        relevantResults: 0,
        topResultRelevant: false,
      };
      recordSearchHandoffAssessment(document, item.id, "pass", undefined, 3_000);
    }
    const summary = summarizeSearchHandoffReview(document);
    expect(summary).toMatchObject({
      launched: 20,
      assessed: 20,
      passed: 20,
      appendedNoiseQueries: 0,
      productionQueryMismatches: 0,
      searchesWithResults: 20,
      relevantTopResults: 20,
      rankingImproved: 1,
      rankingRegressed: 0,
      noiseComparisonEligible: 20,
      noiseComparisons: 20,
      cleanRelevantResults: 21,
      noisyRelevantResults: 0,
      cleanComparisonWins: 20,
      noisyComparisonWins: 0,
      cleanImprovedOverNoise: true,
      complete: true,
    });
    expect(summary.launchedByMediaType.movie).toBeGreaterThan(0);
    expect(summary.launchedByMediaType.series).toBeGreaterThan(0);
    expect(summary.launchedLanguages).toHaveLength(4);
  });
});
