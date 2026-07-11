import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BETA_LOCK_STALE_MS,
  BETA_RELEASE_REQUIRED_SAMPLES,
  BETA_REQUIRED_SAMPLES,
  summarizeBeta,
  withBetaSampleLock,
  type BetaSample,
  type DiscoveryBetaDocument,
} from "../scripts/discovery-beta";

describe("discovery beta report", () => {
  it("separates the two-sample release gate from the seven-day soak", () => {
    const startedAt = Date.parse("2026-07-10T00:00:00.000Z");
    const document: DiscoveryBetaDocument = {
      version: 1,
      startedAt: new Date(startedAt).toISOString(),
      minimumEndsAt: new Date(startedAt + 7 * 86_400_000).toISOString(),
      scheduleHours: 12,
      requiredSamples: BETA_REQUIRED_SAMPLES,
      samples: Array.from({ length: BETA_REQUIRED_SAMPLES }, (_, index): BetaSample => ({
        sampledAt: new Date(startedAt + index * 12 * 60 * 60 * 1_000).toISOString(),
        requestAttempts: { tmdb: 1, "streaming-availability": 2 },
        successfulRefreshes: 2,
        cacheHits: 0,
        stalePeriods: index === 4 ? 1 : 0,
        sourceErrors: index === 5 ? { "tmdb:http-503": 1 } : {},
        uniqueTitles: 10,
        uniqueEvents: 8,
        unknownDateEvents: 1,
        ambiguousMerges: index === 6 ? 1 : 0,
        targetStatuses: [],
      })),
      seenTitleHashes: ["title-a", "title-b"],
      seenEventHashes: ["event-a"],
      unknownDateEventHashes: ["event-a"],
    };

    const firstTwo = { ...document, samples: document.samples.slice(0, 2) };
    expect(summarizeBeta(firstTwo, startedAt + 86_400_000)).toMatchObject({
      sampleCount: BETA_RELEASE_REQUIRED_SAMPLES,
      releaseReady: true,
      windowComplete: false,
    });
    expect(summarizeBeta(document, startedAt + 6 * 86_400_000)).toMatchObject({
      sampleCount: 15,
      sampledIndiaDays: 8,
      releaseReady: true,
      windowComplete: false,
    });
    expect(summarizeBeta(document, startedAt + 7 * 86_400_000)).toMatchObject({
      sampleCount: 15,
      sampledIndiaDays: 8,
      releaseReady: true,
      windowComplete: true,
      requestAttempts: { tmdb: 15, "streaming-availability": 30 },
      successfulRefreshes: 30,
      stalePeriods: 1,
      sourceErrors: { "tmdb:http-503": 1 },
      uniqueTitles: 2,
      uniqueEvents: 1,
      unknownDateEvents: 1,
      ambiguousMerges: 1,
    });
  });

  it("serializes sample processes and cleans up its owner-only lock", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "minch-beta-lock-"));
    let release!: () => void;
    let signalAcquired!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      signalAcquired = resolve;
    });
    try {
      const first = withBetaSampleLock(directory, async () => {
        expect((await fs.stat(path.join(directory, ".sample.lock"))).mode & 0o777)
          .toBe(0o600);
        signalAcquired();
        await blocked;
        return "first";
      });
      await acquired;
      await expect(withBetaSampleLock(directory, async () => "second"))
        .rejects.toThrow("already running");
      release();
      await expect(first).resolves.toBe("first");
      await expect(fs.access(path.join(directory, ".sample.lock"))).rejects.toThrow();
    } finally {
      release();
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("recovers a stale lock before taking the next sample", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "minch-beta-stale-lock-"));
    const lock = path.join(directory, ".sample.lock");
    const now = Date.parse("2026-07-10T12:00:00.000Z");
    try {
      await fs.writeFile(lock, "", { mode: 0o600 });
      const stale = new Date(now - BETA_LOCK_STALE_MS - 1);
      await fs.utimes(lock, stale, stale);

      await expect(withBetaSampleLock(directory, async () => "recovered", now))
        .resolves.toBe("recovered");
      await expect(fs.access(lock)).rejects.toThrow();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
