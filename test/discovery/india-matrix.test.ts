import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { DiscoverySnapshot } from "../../src/discovery/adapter";
import {
  aggregateDiscoverySnapshots,
  filterDiscoveryEntries,
} from "../../src/discovery/aggregate";
import { mergeDiscoveryProviders } from "../../src/ui/hooks/useDiscovery";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/india-feed-matrix.json",
);

function snapshots(): DiscoverySnapshot[] {
  return (JSON.parse(readFileSync(FIXTURE, "utf8")) as {
    snapshots: DiscoverySnapshot[];
  }).snapshots;
}

describe("India feed fixture matrix", () => {
  it("keeps all IN availability while Indian-title mode uses origin only", () => {
    const aggregate = aggregateDiscoverySnapshots(snapshots());

    expect(aggregate.feeds.india).toHaveLength(6);
    expect(aggregate.feeds.india.some((entry) =>
      entry.title?.title === "Global Arrival" &&
      entry.title.originCountries.includes("US"))).toBe(true);
    expect(new Set(filterDiscoveryEntries(aggregate.feeds.india, { indianTitlesOnly: true })
      .map((entry) => entry.title?.title))).toEqual(new Set([
      "Hindi Heartland",
      "Tamil Coast",
      "English in India",
    ]));
    expect(filterDiscoveryEntries(aggregate.feeds.india, { indianTitlesOnly: true })
      .some((entry) => entry.title?.title === "Hindi Beyond India")).toBe(false);
  });

  it("covers movie/series and ordered original-language cases without guessing missing data", () => {
    const aggregate = aggregateDiscoverySnapshots(snapshots());

    expect(filterDiscoveryEntries(aggregate.feeds.india, { mediaTypes: ["series"] })
      .map((entry) => entry.title?.title)).toEqual(["Tamil Coast"]);
    expect(new Set(filterDiscoveryEntries(aggregate.feeds.india, { languageCodes: ["hi"] })
      .map((entry) => entry.title?.title))).toEqual(new Set([
      "Hindi Heartland",
      "Hindi Beyond India",
    ]));
    expect(new Set(filterDiscoveryEntries(aggregate.feeds.india, { languageCodes: ["en"] })
      .map((entry) => entry.title?.title))).toEqual(new Set([
      "English in India",
      "Global Arrival",
    ]));
    const missing = aggregate.feeds.india.find(
      (entry) => entry.title?.title === "Metadata Pending",
    );
    expect(missing?.title).toMatchObject({ originCountries: [] });
    expect(missing?.title?.originalLanguage).toBeUndefined();
    expect(filterDiscoveryEntries([missing!], { languageCodes: ["hi"] })).toEqual([]);
  });

  it("merges provider rebrands and preserves an unknown provider/filter target", () => {
    const fixture = snapshots();
    const providers = mergeDiscoveryProviders(
      fixture.flatMap((snapshot) => snapshot.providers ?? []),
    );
    const hotstar = providers.find((provider) => provider.id === "hotstar");

    expect(hotstar).toEqual({
      id: "hotstar",
      label: "JioHotstar",
      upstreamAliases: ["hotstar", "Hotstar", "JioHotstar", "Disney+ Hotstar"],
    });
    expect(providers).toContainEqual({
      id: "localflix",
      label: "LocalFlix",
      upstreamAliases: ["localflix", "LocalFlix"],
    });

    const aggregate = aggregateDiscoverySnapshots(fixture);
    expect(filterDiscoveryEntries(aggregate.feeds.india, { providerIds: ["localflix"] })
      .map((entry) => entry.title?.title)).toEqual(["Global Arrival"]);
  });
});
