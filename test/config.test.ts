import { describe, expect, it, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import { loadConfig, saveConfig, defaultConfig } from "../src/config/config";
import { configFile } from "../src/config/paths";

describe("config persistence", () => {
  beforeEach(async () => {
    await fs.rm(configFile, { force: true });
  });

  it("returns defaults when no file exists", async () => {
    const cfg = await loadConfig();
    expect(cfg).toEqual(defaultConfig);
  });

  it("round-trips source state, mirrors, and torznab sources", async () => {
    await saveConfig({
      firstRunDone: true,
      sources: {
        "1337x": {
          enabled: true,
          mirror: "https://1337x.st/",
          health: { ok: true, status: "20 results", latency: 412, testedAt: 1 },
        },
        eztv: { enabled: false },
      },
      torznab: [
        { id: "tz-1", name: "My Torznab", baseUrl: "https://t.test/api", apiKey: "k" },
      ],
    });
    const cfg = await loadConfig();
    expect(cfg.firstRunDone).toBe(true);
    expect(cfg.sources["1337x"]?.mirror).toBe("https://1337x.st/");
    expect(cfg.sources["1337x"]?.health?.ok).toBe(true);
    expect(cfg.sources.eztv?.enabled).toBe(false);
    expect(cfg.torznab[0]?.name).toBe("My Torznab");
  });

  it("recovers gracefully from corrupt json", async () => {
    await fs.mkdir(configFile.replace(/\/[^/]+$/, ""), { recursive: true });
    await fs.writeFile(configFile, "{ not valid json", "utf8");
    const cfg = await loadConfig();
    expect(cfg).toEqual(defaultConfig);
  });

  it("round-trips the debrid block and writes config owner-only (0600)", async () => {
    await saveConfig({
      ...defaultConfig,
      firstRunDone: true,
      debrid: { preferred: "torbox", torbox: { apiKey: "secret" } },
    });
    const cfg = await loadConfig();
    expect(cfg.debrid?.preferred).toBe("torbox");
    expect(cfg.debrid?.torbox?.apiKey).toBe("secret");
    const st = await fs.stat(configFile);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("drops an unknown preferred provider but keeps valid keys", async () => {
    await fs.mkdir(configFile.replace(/\/[^/]+$/, ""), { recursive: true });
    await fs.writeFile(
      configFile,
      JSON.stringify({
        firstRunDone: true,
        sources: {},
        torznab: [],
        debrid: { preferred: "bogus", torbox: { apiKey: "k" }, downloadDir: "/tmp/x" },
      }),
      "utf8",
    );
    const cfg = await loadConfig();
    expect(cfg.debrid?.preferred).toBeUndefined();
    expect(cfg.debrid?.torbox?.apiKey).toBe("k");
    expect(cfg.debrid?.downloadDir).toBe("/tmp/x");
  });

  it("round-trips relevance flags and coerces only true booleans", async () => {
    await saveConfig({
      ...defaultConfig,
      firstRunDone: true,
      relevance: {
        preferQuality: true,
        hideTrash: true,
        strictAnd: true,
      },
    });
    const cfg = await loadConfig();
    expect(cfg.relevance).toEqual({
      preferQuality: true,
      hideTrash: true,
      strictAnd: true,
    });
  });

  it("omits relevance block when all flags are false/missing/noise", async () => {
    await fs.mkdir(configFile.replace(/\/[^/]+$/, ""), { recursive: true });
    await fs.writeFile(
      configFile,
      JSON.stringify({
        firstRunDone: true,
        sources: {},
        torznab: [],
        relevance: {
          preferQuality: false,
          hideTrash: "yes",
          strictAnd: 1,
          unknown: true,
        },
      }),
      "utf8",
    );
    const cfg = await loadConfig();
    expect(cfg.relevance).toBeUndefined();
  });

  it("keeps only the true relevance flags when mixed", async () => {
    await fs.mkdir(configFile.replace(/\/[^/]+$/, ""), { recursive: true });
    await fs.writeFile(
      configFile,
      JSON.stringify({
        firstRunDone: true,
        sources: {},
        torznab: [],
        relevance: { preferQuality: true, hideTrash: false, strictAnd: true },
      }),
      "utf8",
    );
    const cfg = await loadConfig();
    expect(cfg.relevance).toEqual({ preferQuality: true, strictAnd: true });
  });
});
