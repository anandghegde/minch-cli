import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LANGUAGE_LABELS,
  languageLabel,
  normalizeLanguage,
  normalizeProvider,
} from "../../src/discovery/normalize";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("normalizeProvider", () => {
  it("normalizes every provider retained in the live India dictionary fixture", () => {
    const fixture = JSON.parse(
      readFileSync(join(FIXTURES, "streaming-availability-countries-in.json"), "utf8"),
    ) as { services: { id: string; name: string }[] };

    expect(
      fixture.services.map((service) => normalizeProvider(service.id, service.name)),
    ).toEqual([
      { id: "netflix", label: "Netflix", upstreamAliases: ["netflix", "Netflix"] },
      { id: "prime", label: "Prime Video", upstreamAliases: ["prime", "Prime Video"] },
      { id: "hotstar", label: "JioHotstar", upstreamAliases: ["hotstar", "JioHotstar"] },
      { id: "zee5", label: "Zee5", upstreamAliases: ["zee5", "Zee5"] },
      { id: "sonyliv", label: "SonyLiv", upstreamAliases: ["sonyliv", "SonyLiv"] },
    ]);
  });

  it("uses a known label to bridge numeric IDs and preserves unknown providers", () => {
    expect(normalizeProvider(119, "Amazon Prime Video")).toEqual({
      id: "prime",
      label: "Amazon Prime Video",
      upstreamAliases: ["119", "Amazon Prime Video"],
    });
    expect(normalizeProvider("new-service", "New Service")).toEqual({
      id: "new-service",
      label: "New Service",
      upstreamAliases: ["new-service", "New Service"],
    });
    expect(normalizeProvider(undefined, undefined)).toBeUndefined();
  });
});

describe("language normalization", () => {
  it("contains every required India language plus English", () => {
    expect(LANGUAGE_LABELS).toEqual({
      hi: "Hindi",
      kn: "Kannada",
      ta: "Tamil",
      te: "Telugu",
      ml: "Malayalam",
      bn: "Bengali",
      mr: "Marathi",
      pa: "Punjabi",
      gu: "Gujarati",
      en: "English",
    });
  });

  it("normalizes codes, regional tags, and supported display names", () => {
    expect(normalizeLanguage("HI")).toEqual({ code: "hi", label: "Hindi" });
    expect(normalizeLanguage("ta-IN")).toEqual({ code: "ta", label: "Tamil" });
    expect(normalizeLanguage("Malayalam")).toEqual({ code: "ml", label: "Malayalam" });
    expect(normalizeLanguage("fr")).toEqual({ code: "fr", label: "fr" });
    expect(normalizeLanguage("not-a-language")).toBeUndefined();
    expect(languageLabel("te")).toBe("Telugu");
  });
});
