import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  allProviders,
  anyConfigured,
  configuredProviders,
  defaultProvider,
  getProvider,
} from "../src/debrid/registry";
import {
  envKey,
  maskKey,
  resolveKey,
  withDebridKey,
} from "../src/debrid/keys";
import { defaultConfig, type Config } from "../src/config/config";

function withTorbox(apiKey = "k"): Config {
  return { ...defaultConfig, debrid: { torbox: { apiKey } } };
}

function withBoth(preferred?: "torbox" | "realdebrid"): Config {
  return {
    ...defaultConfig,
    debrid: {
      torbox: { apiKey: "tb" },
      realdebrid: { token: "rd" },
      ...(preferred ? { preferred } : {}),
    },
  };
}

beforeEach(() => {
  delete process.env.MINCH_TORBOX_KEY;
  delete process.env.MINCH_RD_TOKEN;
});
afterEach(() => {
  delete process.env.MINCH_TORBOX_KEY;
  delete process.env.MINCH_RD_TOKEN;
});

describe("debrid registry", () => {
  it("registers both TorBox and Real Debrid", () => {
    const ids = allProviders({ ...defaultConfig }).map((p) => p.id);
    expect(ids).toContain("torbox");
    expect(ids).toContain("realdebrid");
    expect(getProvider("realdebrid", { ...defaultConfig })?.id).toBe("realdebrid");
    expect(getProvider("torbox", { ...defaultConfig })?.id).toBe("torbox");
  });

  it("configuredProviders only returns providers with a usable key", () => {
    expect(configuredProviders({ ...defaultConfig })).toHaveLength(0);
    expect(anyConfigured({ ...defaultConfig })).toBe(false);

    const cfg = withTorbox();
    expect(configuredProviders(cfg).map((p) => p.id)).toEqual(["torbox"]);
    expect(anyConfigured(cfg)).toBe(true);
  });

  it("treats an env var as configuration even without a config key", () => {
    process.env.MINCH_TORBOX_KEY = "env-key";
    expect(anyConfigured({ ...defaultConfig })).toBe(true);
    expect(configuredProviders({ ...defaultConfig }).map((p) => p.id)).toEqual([
      "torbox",
    ]);
  });

  it("treats a Real Debrid env token as configuration", () => {
    process.env.MINCH_RD_TOKEN = "rd-env";
    expect(configuredProviders({ ...defaultConfig }).map((p) => p.id)).toEqual([
      "realdebrid",
    ]);
  });

  // The provider picker in Results keys off this configured-count: 0 → notice,
  // 1 → send straight to it, 2 → open the picker.
  it("reports the configured provider set for none / one / both", () => {
    expect(configuredProviders({ ...defaultConfig })).toHaveLength(0);
    expect(configuredProviders(withTorbox())).toHaveLength(1);
    expect(configuredProviders(withBoth()).map((p) => p.id)).toEqual([
      "torbox",
      "realdebrid",
    ]);
  });

  it("defaultProvider returns the configured provider, else undefined", () => {
    expect(defaultProvider({ ...defaultConfig })).toBeUndefined();
    expect(defaultProvider(withTorbox())?.id).toBe("torbox");
  });

  it("defaultProvider honors the preferred id when both are configured", () => {
    // No preference → first in display order (TorBox).
    expect(defaultProvider(withBoth())?.id).toBe("torbox");
    expect(defaultProvider(withBoth("realdebrid"))?.id).toBe("realdebrid");
    expect(defaultProvider(withBoth("torbox"))?.id).toBe("torbox");
  });
});

describe("debrid keys", () => {
  it("masks a secret to its last 4 characters", () => {
    expect(maskKey("abcdef123456")).toBe("********3456");
    expect(maskKey("ab")).toBe("**");
    expect(maskKey("")).toBe("");
  });

  it("never reveals more than the last 4 characters", () => {
    const masked = maskKey("supersecretkey9999");
    expect(masked.endsWith("9999")).toBe(true);
    expect(masked).not.toContain("supersecret");
  });

  it("prefers the env var over the config file", () => {
    const cfg = withTorbox("cfgkey");
    expect(resolveKey("torbox", cfg)).toEqual({ key: "cfgkey", source: "config" });
    process.env.MINCH_TORBOX_KEY = "envkey";
    expect(envKey("torbox")).toBe("envkey");
    expect(resolveKey("torbox", cfg)).toEqual({ key: "envkey", source: "env" });
  });

  it("sets and clears a provider key immutably", () => {
    const set = withDebridKey({ ...defaultConfig }, "torbox", "k");
    expect(set.debrid?.torbox?.apiKey).toBe("k");
    const cleared = withDebridKey(set, "torbox", undefined);
    expect(cleared.debrid?.torbox).toBeUndefined();
  });

  it("sets and clears the Real Debrid token immutably", () => {
    const set = withDebridKey({ ...defaultConfig }, "realdebrid", "rd-token");
    expect(set.debrid?.realdebrid?.token).toBe("rd-token");
    const cleared = withDebridKey(set, "realdebrid", undefined);
    expect(cleared.debrid?.realdebrid).toBeUndefined();
  });

  it("prefers the Real Debrid env token over config", () => {
    const cfg = { ...defaultConfig, debrid: { realdebrid: { token: "cfg" } } };
    expect(resolveKey("realdebrid", cfg)).toEqual({ key: "cfg", source: "config" });
    process.env.MINCH_RD_TOKEN = "env";
    expect(resolveKey("realdebrid", cfg)).toEqual({ key: "env", source: "env" });
  });
});
