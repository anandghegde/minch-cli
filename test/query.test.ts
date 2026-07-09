import { describe, expect, it } from "vitest";
import { parseQuery, tokenize, tokenizePhrase } from "../src/sources/query";

describe("tokenize", () => {
  it("lowercases and splits on non-word chars", () => {
    expect(tokenize("Spider-Man Far From Home")).toEqual([
      "spider",
      "man",
      "far",
      "from",
      "home",
    ]);
  });

  it("drops stop words outside phrases", () => {
    expect(tokenize("The Matrix Reloaded")).toEqual(["matrix", "reloaded"]);
  });

  it("keeps dotted version numbers whole", () => {
    expect(tokenize("ubuntu 24.04")).toEqual(["ubuntu", "24.04"]);
  });
});

describe("tokenizePhrase", () => {
  it("keeps stop words inside phrases", () => {
    expect(tokenizePhrase("the matrix")).toEqual(["the", "matrix"]);
  });
});

describe("parseQuery", () => {
  it("parses plain queries like Phase A (must tokens + year/S-E hints)", () => {
    const q = parseQuery("dune 2021");
    expect(q.must).toEqual(["dune"]);
    expect(q.year).toBe(2021);
    expect(q.phrases).toEqual([]);
    expect(q.exclude).toEqual([]);
  });

  it("parses S/E markers into season/episode and out of must", () => {
    const q = parseQuery("breaking bad s05e14");
    expect(q.must).toEqual(["breaking", "bad"]);
    expect(q.season).toBe(5);
    expect(q.episode).toBe(14);
  });

  it("parses quoted phrases as ordered token lists", () => {
    const q = parseQuery('"spider man" home');
    expect(q.phrases).toEqual([["spider", "man"]]);
    expect(q.must).toEqual(["home"]);
  });

  it("keeps stop words inside quoted phrases", () => {
    const q = parseQuery('"the matrix" reloaded');
    expect(q.phrases).toEqual([["the", "matrix"]]);
    expect(q.must).toEqual(["reloaded"]);
  });

  it("treats unclosed quote as best-effort phrase (rest of string)", () => {
    const q = parseQuery('"no way home 1080p');
    expect(q.phrases).toEqual([["no", "way", "home", "1080p"]]);
    expect(q.must).toEqual([]);
  });

  it("parses -word and !word excludes at token boundaries", () => {
    expect(parseQuery("inception -cam").exclude).toEqual(["cam"]);
    expect(parseQuery("inception !sample").exclude).toEqual(["sample"]);
    expect(parseQuery("-cam inception !proof").exclude).toEqual(["cam", "proof"]);
  });

  it("does not treat mid-word hyphens as excludes", () => {
    // free-text spider-man still tokenizes to spider + man via dash split
    const q = parseQuery("spider-man home");
    expect(q.exclude).toEqual([]);
    expect(q.must).toEqual(["spider", "man", "home"]);
  });

  it("combines phrase + exclude + free tokens", () => {
    const q = parseQuery('"spider man" -cam 1080p');
    expect(q.phrases).toEqual([["spider", "man"]]);
    expect(q.exclude).toEqual(["cam"]);
    expect(q.must).toEqual(["1080p"]);
  });

  it("handles empty / stop-only input", () => {
    expect(parseQuery("")).toEqual({
      must: [],
      phrases: [],
      exclude: [],
      year: null,
      season: null,
      episode: null,
    });
    expect(parseQuery("the a an").must).toEqual([]);
  });

  it("supports multiple phrases", () => {
    const q = parseQuery('"lord of" "the rings"');
    expect(q.phrases).toEqual([
      ["lord", "of"],
      ["the", "rings"],
    ]);
  });
});
