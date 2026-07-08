import { describe, expect, it } from "vitest";
import { inferSearchIntent } from "../src/sources/intent";

describe("inferSearchIntent", () => {
  it("prioritizes anime sources and strips the keyword", () => {
    const intent = inferSearchIntent("anime attack on titan");
    expect(intent.query).toBe("attack on titan");
    expect(intent.mediaType).toBe("anime");
    expect(intent.region).toBe("japan");
    expect(intent.preferredSources).toContain("nyaa");
  });

  it("recognizes Indian language + region and maps to thepiratebay", () => {
    const intent = inferSearchIntent("bollywood kgf hindi");
    expect(intent.query).toBe("kgf");
    expect(intent.mediaType).toBe("movie");
    expect(intent.region).toBe("india");
    expect(intent.language).toBe("hindi");
    expect(intent.preferredSources).toContain("thepiratebay");
  });

  it("recognizes kdrama as tv + korea", () => {
    const intent = inferSearchIntent("kdrama squid game");
    expect(intent.query).toBe("squid game");
    expect(intent.mediaType).toBe("tv");
    expect(intent.region).toBe("korea");
    expect(intent.preferredSources).toContain("eztv");
  });

  it("falls back to the raw query when every term is an intent keyword", () => {
    const intent = inferSearchIntent("anime");
    expect(intent.query).toBe("anime");
    expect(intent.mediaType).toBe("anime");
  });

  it("leaves a plain query untouched with no preferred sources", () => {
    const intent = inferSearchIntent("ubuntu 24.04");
    expect(intent.query).toBe("ubuntu 24.04");
    expect(intent.preferredSources).toEqual([]);
    expect(intent.mediaType).toBeUndefined();
  });

  it("boosts yts for movies and fitgirl for games", () => {
    expect(inferSearchIntent("movie dune").preferredSources).toContain("yts");
    expect(inferSearchIntent("game elden ring").preferredSources).toContain("fitgirl");
  });
});
