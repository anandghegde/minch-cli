import { afterEach, describe, expect, it, beforeEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import {
  flushConfigWrites,
  getLastConfigSaveError,
  loadConfig,
  saveConfig,
  takeConfigWarnings,
  defaultConfig,
} from "../src/config/config";
import { configFile } from "../src/config/paths";
import { buildRegistry } from "../src/sources/registry";

describe("config persistence", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    takeConfigWarnings();
    await fs.rm(configFile, { force: true });
  });

  afterEach(() => vi.restoreAllMocks());

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
    expect(takeConfigWarnings()).toEqual(["Config file is invalid; using defaults."]);
  });

  it("drops malformed persisted source entries without breaking registry inputs", async () => {
    await fs.mkdir(configFile.replace(/\/[^/]+$/, ""), { recursive: true });
    await fs.writeFile(
      configFile,
      JSON.stringify({
        firstRunDone: true,
        sources: {
          valid: { enabled: true, mirror: "https://mirror.test/", health: { ok: true } },
          broken: null,
          badHealth: { enabled: false, health: { ok: "yes" } },
        },
        torznab: [
          null,
          { id: "", name: "Missing id", baseUrl: "https://tz.test/api" },
          { id: "bad-url", name: "Bad URL", baseUrl: "http://tz.test/api" },
          { id: "ok", name: "Valid", baseUrl: "https://tz.test/api", apiKey: "k" },
        ],
      }),
      "utf8",
    );

    const cfg = await loadConfig();
    expect(cfg.sources).toEqual({
      valid: { enabled: true, mirror: "https://mirror.test/", health: { ok: true } },
      badHealth: { enabled: false },
    });
    expect(cfg.torznab).toEqual([
      { id: "ok", name: "Valid", baseUrl: "https://tz.test/api", apiKey: "k" },
    ]);
    expect(takeConfigWarnings()).toHaveLength(5);
    await expect(buildRegistry(cfg)).resolves.toBeDefined();
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

  it("round-trips the optional TMDB read token in owner-only config", async () => {
    await saveConfig({
      ...defaultConfig,
      firstRunDone: true,
      discovery: { tmdb: { readToken: " tmdb-token " } },
    });
    const cfg = await loadConfig();
    expect(cfg.discovery).toEqual({ tmdb: { readToken: "tmdb-token" } });
    const st = await fs.stat(configFile);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("round-trips the optional direct Streaming Availability key", async () => {
    await saveConfig({
      ...defaultConfig,
      discovery: { streamingAvailability: { apiKey: " direct-key " } },
    });
    await expect(loadConfig()).resolves.toMatchObject({
      discovery: { streamingAvailability: { apiKey: "direct-key" } },
    });
  });

  it("round-trips only recognized disabled discovery adapters", async () => {
    await fs.mkdir(configFile.replace(/\/[^/]+$/, ""), { recursive: true });
    await fs.writeFile(configFile, JSON.stringify({
      ...defaultConfig,
      discovery: {
        disabledSources: ["bluray", "tmdb", "bluray", "unknown"],
      },
    }), "utf8");

    await expect(loadConfig()).resolves.toMatchObject({
      discovery: { disabledSources: ["bluray", "tmdb"] },
    });
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

  it("rejects a failed save, records it, and allows the next save to succeed", async () => {
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("disk full"));
    await expect(saveConfig({ ...defaultConfig, firstRunDone: true }))
      .rejects.toThrow("disk full");
    expect(getLastConfigSaveError()?.message).toBe("disk full");

    await saveConfig({ ...defaultConfig, firstRunDone: true });
    await flushConfigWrites();
    expect(getLastConfigSaveError()).toBeNull();
    expect((await loadConfig()).firstRunDone).toBe(true);
  });

  it("flushes a save that was started immediately before shutdown", async () => {
    const originalRename = fs.rename;
    let releaseRename: (() => void) | undefined;
    const renameGate = new Promise<void>((resolve) => {
      releaseRename = resolve;
    });
    vi.spyOn(fs, "rename").mockImplementationOnce(async (from, to) => {
      await renameGate;
      await originalRename(from, to);
    });

    const saving = saveConfig({ ...defaultConfig, firstRunDone: true });
    const flushed = flushConfigWrites();
    let didFlush = false;
    void flushed.then(() => {
      didFlush = true;
    });
    await Promise.resolve();
    expect(didFlush).toBe(false);

    releaseRename?.();
    await expect(Promise.all([saving, flushed])).resolves.toEqual([undefined, undefined]);
    expect((await loadConfig()).firstRunDone).toBe(true);
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
