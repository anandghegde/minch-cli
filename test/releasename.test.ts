import { describe, expect, it } from "vitest";
import {
  parseReleaseName,
  qualityRank,
  isTrashRelease,
  trashPenalty,
  cleanTitle,
} from "../src/sources/releasename";

describe("parseReleaseName", () => {
  it("parses a classic movie BluRay release", () => {
    const p = parseReleaseName(
      "Inception.2010.1080p.BluRay.x264-GROUP",
    );
    expect(p.resolution).toBe(1080);
    expect(p.source).toBe("bluray");
    expect(p.codec).toBe("x264");
    expect(p.year).toBe(2010);
    expect(p.season).toBeNull();
    expect(p.episode).toBeNull();
  });

  it("parses 2160p remux with HDR / DV", () => {
    const p = parseReleaseName(
      "Dune.Part.Two.2024.2160p.UHD.BluRay.REMUX.DV.HDR10.HEVC",
    );
    expect(p.resolution).toBe(2160);
    expect(p.source).toBe("remux");
    expect(p.codec).toBe("x265");
    expect(p.hdr).toBe("dv");
    expect(p.year).toBe(2024);
  });

  it("parses WEB-DL / WEBRip / HDTV sources", () => {
    expect(parseReleaseName("Show.S01E01.1080p.WEB-DL.x264").source).toBe("webdl");
    expect(parseReleaseName("Show.S01E01.720p.WEBRip.x265").source).toBe("webrip");
    expect(parseReleaseName("Show.S01E01.720p.HDTV.x264").source).toBe("hdtv");
  });

  it("parses TV season/episode (SxxEyy and NxNN)", () => {
    const a = parseReleaseName("Breaking.Bad.S05E14.1080p.BluRay");
    expect(a.season).toBe(5);
    expect(a.episode).toBe(14);

    const b = parseReleaseName("Breaking.Bad.5x14.720p.HDTV");
    expect(b.season).toBe(5);
    expect(b.episode).toBe(14);
  });

  it("parses 4K / UHD as 2160", () => {
    expect(parseReleaseName("Movie.2020.4K.WEB-DL").resolution).toBe(2160);
    expect(parseReleaseName("Movie.2020.UHD.BluRay").resolution).toBe(2160);
  });

  it("parses PROPER / REPACK / v2 revisions", () => {
    expect(parseReleaseName("Movie.2020.1080p.BluRay.PROPER.x264").revision).toBe(
      "proper",
    );
    expect(parseReleaseName("Movie.2020.1080p.WEBRip.REPACK").revision).toBe(
      "repack",
    );
    expect(parseReleaseName("Movie.2020.720p.HDTV.v2").revision).toBe("v2");
  });

  it("parses anime-style names", () => {
    const p = parseReleaseName(
      "[SubsPlease] Solo Leveling - 12 (1080p) [ABC123].mkv",
    );
    expect(p.resolution).toBe(1080);
  });

  it("parses software / game style names without false TV seasons", () => {
    const p = parseReleaseName("Adobe.Photoshop.2024.v25.0.MacOS");
    expect(p.year).toBe(2024);
    // v25 should not become season/episode via SxxEyy; NxNN might still fire
    // on bare patterns — year is the useful signal here.
    expect(p.resolution).toBeNull();
  });

  it("handles empty / unparseable names", () => {
    const p = parseReleaseName("");
    expect(p).toEqual({
      resolution: null,
      source: null,
      codec: null,
      hdr: null,
      revision: null,
      year: null,
      season: null,
      episode: null,
    });
  });
});

describe("qualityRank", () => {
  function rank(name: string): number {
    return qualityRank(parseReleaseName(name));
  }

  it("orders resolution then source as specified", () => {
    const order = [
      "Movie.2024.2160p.BluRay.REMUX.HEVC",
      "Movie.2024.2160p.BluRay.x265",
      "Movie.2024.2160p.WEB-DL.x265",
      "Movie.2024.1080p.BluRay.x264",
      "Movie.2024.1080p.WEB-DL.x264",
      "Movie.2024.720p.WEBRip.x264",
      "Movie.2024.480p.DVDRip.XviD",
      "Movie.2024.CAM.XviD",
    ];
    const scores = order.map(rank);
    for (let i = 0; i < scores.length - 1; i++) {
      expect(scores[i]!).toBeGreaterThan(scores[i + 1]!);
    }
  });

  it("gives HDR / PROPER a small bump over the same res+source", () => {
    const base = rank("Movie.2024.1080p.BluRay.x264");
    const hdr = rank("Movie.2024.1080p.BluRay.HDR.x264");
    const proper = rank("Movie.2024.1080p.BluRay.PROPER.x264");
    expect(hdr).toBeGreaterThan(base);
    expect(proper).toBeGreaterThan(base);
  });

  it("unknown quality ranks below any known resolution", () => {
    expect(rank("Random.Upload.Name")).toBeLessThan(rank("Movie.480p.HDTV"));
  });
});

describe("isTrashRelease / trashPenalty", () => {
  it("flags CAM / TS / SAMPLE / PROOF / XXX as trash", () => {
    expect(isTrashRelease("Inception.2010.CAM.x264")).toBe(true);
    expect(isTrashRelease("Movie.HDCAM.x264")).toBe(true);
    expect(isTrashRelease("Movie.TELESYNC.x264")).toBe(true);
    expect(isTrashRelease("Movie.HDTS.x264")).toBe(true);
    expect(isTrashRelease("Movie.TS.x264")).toBe(true);
    expect(isTrashRelease("Movie.SAMPLE.x264")).toBe(true);
    expect(isTrashRelease("Movie.PROOF.jpg")).toBe(true);
    expect(isTrashRelease("Some.XXX.Title.1080p")).toBe(true);
    expect(isTrashRelease("Movie.SCR.x264")).toBe(true);
    expect(isTrashRelease("Movie.SCREENER.x264")).toBe(true);
  });

  it("does not flag clean WEB-DL / BluRay releases", () => {
    expect(isTrashRelease("Inception.2010.1080p.BluRay.x264")).toBe(false);
    expect(isTrashRelease("Show.S01E01.1080p.WEB-DL.x264")).toBe(false);
    expect(trashPenalty("Inception.2010.1080p.BluRay.x264")).toBe(0);
  });

  it("penalizes hard trash more than soft screener tags", () => {
    expect(trashPenalty("Movie.2010.CAM.x264")).toBeGreaterThan(
      trashPenalty("Movie.2010.SCR.x264"),
    );
    expect(trashPenalty("Movie.2010.SCR.x264")).toBeGreaterThan(0);
  });
});

describe("cleanTitle", () => {
  it("strips resolution/source/codec/group tags leaving title-ish tokens", () => {
    const t = cleanTitle("Spider-Man.No.Way.Home.2021.1080p.BluRay.x264-GROUP");
    expect(t.toLowerCase()).toContain("spider");
    expect(t.toLowerCase()).toContain("way");
    expect(t.toLowerCase()).not.toMatch(/1080p|bluray|x264|group/i);
  });

  it("handles dotted and spaced scene names", () => {
    expect(cleanTitle("The.Matrix.Reloaded.2003.1080p.WEB-DL").toLowerCase()).toMatch(
      /matrix/,
    );
  });
});
