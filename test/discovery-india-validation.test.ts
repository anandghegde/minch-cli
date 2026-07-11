import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { summarizeIndiaValidation } from "../scripts/discovery-india-validation";
import type { DiscoverySnapshot } from "../src/discovery/adapter";
import type { BudgetStatus } from "../src/discovery/budget";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "discovery/fixtures/india-feed-matrix.json",
);

function budget(used: number): BudgetStatus {
  return {
    source: "streaming-availability",
    endpoint: "changes",
    month: "2026-07",
    used,
    endpointUsed: used,
    allowed: true,
    warning: false,
    softWarning: 350,
    hardCap: 450,
    remaining: 450 - used,
  };
}

describe("India discovery sampled-week report", () => {
  it("emits aggregate coverage counts without titles or raw source content", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
      snapshots: DiscoverySnapshot[];
    };
    const snapshot = fixture.snapshots[0]!;
    const summary = summarizeIndiaValidation(
      snapshot,
      budget(10),
      budget(11),
      "2026-07-04",
      "2026-07-10",
    );

    expect(summary).toEqual({
      sampledAt: "2026-07-10T06:43:52.000Z",
      window: { start: "2026-07-04", end: "2026-07-10" },
      policy: {
        rawPayloadsIncluded: false,
        titlesIncluded: false,
        pageLimit: 1,
        providerScope: ["netflix", "prime", "hotstar"],
      },
      requestAttempts: 1,
      truncated: false,
      eventCount: 6,
      knownDateCount: 6,
      unknownDateCount: 0,
      providers: { netflix: 2, hotstar: 1, prime: 2, localflix: 1 },
      mediaTypes: { movie: 5, series: 1 },
      originalLanguages: { hi: 2, ta: 1, en: 2, unknown: 1 },
      warningCodes: {},
    });

    const serialized = JSON.stringify(summary);
    expect(summary).not.toHaveProperty("titles");
    expect(summary).not.toHaveProperty("rawPayload");
    for (const title of snapshot.titles) {
      expect(serialized).not.toContain(title.title);
    }
  });
});
