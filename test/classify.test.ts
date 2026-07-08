import { describe, expect, it } from "vitest";
import { detectMediaType, detectQuality, normalizeTitle } from "../src/sources/classify";

describe("detectQuality", () => {
  it("detects common tiers", () => {
    expect(detectQuality("Movie 2024 1080p x265")).toBe("1080p");
    expect(detectQuality("Show 2160p WEB-DL")).toBe("2160p");
    expect(detectQuality("Thing 720p")).toBe("720p");
    expect(detectQuality("Thing 480p")).toBe("480p");
  });

  it("normalizes 4k/uhd to 2160p", () => {
    expect(detectQuality("Movie 4K HDR")).toBe("2160p");
    expect(detectQuality("Movie UHD")).toBe("2160p");
  });

  it("returns undefined when no quality tag is present", () => {
    expect(detectQuality("Just A Name")).toBeUndefined();
  });
});

describe("detectMediaType", () => {
  it("detects tv from episode/season patterns", () => {
    expect(detectMediaType("Show S01E02 1080p")).toBe("tv");
    expect(detectMediaType("Show Season 3")).toBe("tv");
  });

  it("detects anime and game markers", () => {
    expect(detectMediaType("SubsPlease Anime Title")).toBe("anime");
    expect(detectMediaType("FitGirl Repack Game Title")).toBe("game");
  });

  it("returns undefined for a plain name", () => {
    expect(detectMediaType("Some Movie 2024")).toBeUndefined();
  });
});

describe("normalizeTitle", () => {
  it("strips quality/codec/source tags and separators", () => {
    expect(normalizeTitle("Movie.2024.1080p.WEB-DL.x265-YTS")).toBe("movie 2024");
  });
});
