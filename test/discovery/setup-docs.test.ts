import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("discovery setup documentation", () => {
  it("documents the ordered minimum path and every operational setup requirement", () => {
    const setup = readFileSync(join(process.cwd(), "docs/discovery-setup.md"), "utf8");
    const readme = readFileSync(join(process.cwd(), "README.md"), "utf8");

    const bluray = setup.indexOf("Start credential-free with Blu-ray RSS");
    const tmdb = setup.indexOf("Add TMDB");
    const ott = setup.indexOf("Optionally add India OTT changes");
    expect(bluray).toBeGreaterThan(-1);
    expect(tmdb).toBeGreaterThan(bluray);
    expect(ott).toBeGreaterThan(tmdb);

    for (const required of [
      "TMDB_READ_TOKEN",
      "STREAMING_AVAILABILITY_API_KEY",
      "MDBLIST_API_KEY",
      "Settings",
      "discovery-cache.json",
      "discovery-usage.json",
      "discovery-ratings-cache.json",
      "discovery-ratings-usage.json",
      "imdb-title-ratings.tsv.gz",
      "12 hours",
      "24 hours",
      "30 days",
      "45 days",
      "350",
      "450 hard cap",
      "800",
      "951",
      "minch --discovery-status",
      "Enable or disable an adapter",
      "Source limitations",
    ]) {
      expect(setup).toContain(required);
    }
    expect(setup).toContain("https://developers.movieofthenight.com/");
    expect(setup).toContain("https://www.themoviedb.org/signup");
    expect(setup).toContain("https://www.themoviedb.org/settings/api");
    expect(setup).toMatch(/TMDB account/i);
    expect(setup).toMatch(/non-commercial/i);
    expect(setup).toMatch(/RapidAPI keys\/endpoints are deliberately unsupported/i);
    expect(readme).toContain("docs/discovery-setup.md");
  });
});
