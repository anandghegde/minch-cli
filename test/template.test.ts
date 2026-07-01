import { describe, expect, it } from "vitest";
import { applyTemplate } from "../src/cardigann/template";

describe("applyTemplate", () => {
  it("passes through strings without templates", () => {
    expect(applyTemplate("hello", {})).toBe("hello");
    expect(applyTemplate("", {})).toBe("");
    expect(applyTemplate(undefined, {})).toBe("");
  });

  it("substitutes simple variables", () => {
    expect(applyTemplate("{{ .Keywords }}", { ".Keywords": "ubuntu" })).toBe(
      "ubuntu",
    );
    expect(
      applyTemplate("q={{ .Query.Q }}&p=1", { ".Query.Q": "linux iso" }),
    ).toBe("q=linux iso&p=1");
  });

  it("treats null variables as empty", () => {
    expect(applyTemplate("[{{ .Missing }}]", { ".Missing": null })).toBe("[]");
  });

  it("handles if/else on a variable", () => {
    const t = "{{ if .Keywords }}{{ .Keywords }}{{ else }}{{ .Today.Year }}{{ end }}";
    expect(applyTemplate(t, { ".Keywords": "dune", ".Today.Year": "2024" })).toBe(
      "dune",
    );
    expect(applyTemplate(t, { ".Keywords": null, ".Today.Year": "2024" })).toBe(
      "2024",
    );
  });

  it("applies re_replace", () => {
    expect(
      applyTemplate('{{ re_replace .Keywords "[^a-z0-9]+" "+" }}', {
        ".Keywords": "the matrix 1999",
      }),
    ).toBe("the+matrix+1999");
  });

  it("applies join over an array", () => {
    expect(
      applyTemplate('{{ join .Categories "," }}', {
        ".Categories": ["2000", "2010"],
      }),
    ).toBe("2000,2010");
  });

  it("evaluates and/or logic", () => {
    // or: first non-empty
    expect(
      applyTemplate("{{ if or (.A) (.B) }}yes{{ else }}no{{ end }}", {
        ".A": null,
        ".B": "x",
      }),
    ).toBe("yes");
    // and: first empty wins → falsy
    expect(
      applyTemplate("{{ if and (.A) (.B) }}yes{{ else }}no{{ end }}", {
        ".A": null,
        ".B": "x",
      }),
    ).toBe("no");
  });

  it("evaluates eq/ne against literals", () => {
    expect(
      applyTemplate('{{ if eq (.Mode) "rss" }}feed{{ else }}search{{ end }}', {
        ".Mode": "rss",
      }),
    ).toBe("feed");
    expect(
      applyTemplate('{{ if eq (.Mode) "rss" }}feed{{ else }}search{{ end }}', {
        ".Mode": "q",
      }),
    ).toBe("search");
  });

  it("applies a text modifier (e.g. url encoding)", () => {
    expect(
      applyTemplate("{{ .Q }}", { ".Q": "a b&c" }, encodeURIComponent),
    ).toBe("a%20b%26c");
  });
});
