import { describe, expect, it } from "vitest";
import { loadBundledDefinitions } from "../src/cardigann/definitions";
import { activeMirror, buildRegistry, isEnabled } from "../src/sources/registry";
import { defaultConfig, type Config } from "../src/config/config";

describe("bundled definitions", () => {
  it("loads the vendored public definitions without rejections", async () => {
    const { definitions, rejected } = await loadBundledDefinitions();
    expect(definitions.length).toBeGreaterThan(20);
    expect(rejected).toHaveLength(0);
    // every loaded def is public and has at least one link
    for (const d of definitions) {
      expect(d.type).toBe("public");
      expect(d.links.length).toBeGreaterThan(0);
    }
  });
});

describe("registry", () => {
  it("includes native sources and de-dupes them over definitions", async () => {
    const reg = await buildRegistry({ ...defaultConfig });
    expect(reg.byId.get("yts")?.kind).toBe("api");
    expect(reg.byId.get("nyaa")?.kind).toBe("rss");
    expect(reg.byId.get("thepiratebay")?.kind).toBe("api");
    // many cardigann sources present
    const cardigann = reg.sources.filter((s) => s.kind === "cardigann");
    expect(cardigann.length).toBeGreaterThan(20);
  });

  it("resolves the active mirror from config, falling back to first link", async () => {
    const reg = await buildRegistry({ ...defaultConfig });
    const multi = reg.sources.find((s) => s.links.length > 1)!;
    expect(multi).toBeTruthy();
    const cfg: Config = {
      ...defaultConfig,
      sources: { [multi.id]: { enabled: true, mirror: multi.links[1] } },
    };
    expect(activeMirror(multi, cfg)).toBe(multi.links[1]);
    // unknown mirror falls back to first link
    const bad: Config = {
      ...defaultConfig,
      sources: { [multi.id]: { enabled: true, mirror: "https://nope.test/" } },
    };
    expect(activeMirror(multi, bad)).toBe(multi.links[0]);
  });

  it("honors enabled override, else defaultEnabled", async () => {
    const reg = await buildRegistry({ ...defaultConfig });
    const s = reg.byId.get("yts")!;
    expect(isEnabled(s, { ...defaultConfig })).toBe(true);
    expect(
      isEnabled(s, { ...defaultConfig, sources: { yts: { enabled: false } } }),
    ).toBe(false);
  });

  it("adds user torznab sources", async () => {
    const cfg: Config = {
      ...defaultConfig,
      torznab: [{ id: "tz-x", name: "Custom", baseUrl: "https://tz.test/api" }],
    };
    const reg = await buildRegistry(cfg);
    expect(reg.byId.get("tz-x")?.kind).toBe("torznab");
    expect(reg.byId.get("tz-x")?.requiresConfig).toBe(true);
  });
});
