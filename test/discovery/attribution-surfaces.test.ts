import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HELP_TEXT } from "../../src/cli/args";
import {
  DISCOVERY_CREDITS_NOTICE,
  DISCOVERY_SOURCE_CLAIM_NOTICE,
  JUSTWATCH_ATTRIBUTION_NOTICE,
  TMDB_REQUIRED_NOTICE,
  IMDB_REQUIRED_NOTICE,
} from "../../src/discovery/attribution";
import { BLURAY_ATTRIBUTION } from "../../src/discovery/sources/bluray";
import { STREAMING_AVAILABILITY_ATTRIBUTION } from "../../src/discovery/sources/streaming-availability";
import { TMDB_ATTRIBUTION } from "../../src/discovery/sources/tmdb";
import { DISCOVERY_HELP_FOOTNOTES } from "../../src/ui/components/HelpOverlay";

describe("discovery attribution surfaces", () => {
  it("keeps required notices in adapter metadata and CLI help", () => {
    expect(TMDB_ATTRIBUTION).toMatchObject({
      sourceLabel: "TMDB",
      sourceUrl: "https://www.themoviedb.org",
      notice: TMDB_REQUIRED_NOTICE,
      additionalNotices: [JUSTWATCH_ATTRIBUTION_NOTICE],
    });
    expect(STREAMING_AVAILABILITY_ATTRIBUTION).toMatchObject({
      sourceLabel: "Streaming Availability API by Movie of the Night",
      sourceUrl: "https://www.movieofthenight.com/about/api",
    });
    expect(BLURAY_ATTRIBUTION).toMatchObject({
      sourceLabel: "Blu-ray.com",
      sourceUrl: "https://www.blu-ray.com",
    });
    expect(HELP_TEXT).toContain(DISCOVERY_SOURCE_CLAIM_NOTICE);
    expect(HELP_TEXT).toContain(DISCOVERY_CREDITS_NOTICE);
    expect(HELP_TEXT).toContain(TMDB_REQUIRED_NOTICE);
    expect(HELP_TEXT).toContain(JUSTWATCH_ATTRIBUTION_NOTICE);
    expect(HELP_TEXT).toContain(IMDB_REQUIRED_NOTICE);
    expect(DISCOVERY_HELP_FOOTNOTES.join("\n")).toContain(DISCOVERY_SOURCE_CLAIM_NOTICE);
    expect(DISCOVERY_HELP_FOOTNOTES.join("\n")).toContain(DISCOVERY_CREDITS_NOTICE);
    expect(DISCOVERY_HELP_FOOTNOTES).toContain(TMDB_REQUIRED_NOTICE);
    expect(DISCOVERY_HELP_FOOTNOTES).toContain(JUSTWATCH_ATTRIBUTION_NOTICE);
    expect(DISCOVERY_HELP_FOOTNOTES).toContain(IMDB_REQUIRED_NOTICE);
  });

  it("documents credits, source-claim limits, and the monetization review gate", () => {
    const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");
    const attribution = readFileSync(
      join(process.cwd(), "docs/discovery-attribution.md"),
      "utf8",
    );
    for (const content of [readme, attribution]) {
      expect(content).toContain("TMDB");
      expect(content).toContain("Streaming Availability API by Movie of the Night");
      expect(content).toContain("Blu-ray.com");
      expect(content).toContain(IMDB_REQUIRED_NOTICE);
      expect(content).toMatch(/source claims/i);
      expect(content).toMatch(/coverage may be\s+incomplete/i);
      expect(content).toMatch(/non-commercial/i);
      expect(content).toMatch(/before monetization|revenue-generating/i);
    }
    expect(readme).toContain(TMDB_REQUIRED_NOTICE);
    expect(readme).toContain("JustWatch");
  });
});
