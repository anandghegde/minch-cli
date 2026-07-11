import { describe, expect, it } from "vitest";
import { defaultConfig, type Config } from "../src/config/config";
import type { ProbeOutcome } from "../src/sources/health";
import type { Source } from "../src/sources/types";
import { mergeSourceProbe } from "../src/ui/source-state";

const source: Source = {
  id: "source",
  label: "Source",
  kind: "api",
  links: ["https://old.test/", "https://fallback.test/"],
  requiresConfig: false,
  defaultEnabled: true,
  test: async () => ({ ok: true, status: "ok" }),
  search: async () => [],
};

function outcome(ok: boolean, mirror?: string): ProbeOutcome {
  return { id: source.id, mirror, health: { ok, status: ok ? "ok" : "failed" } };
}

describe("mergeSourceProbe", () => {
  it("keeps a user disable and mirror change made while the probe was running", () => {
    const started: Config = {
      ...defaultConfig,
      sources: { source: { enabled: true, mirror: "https://old.test/" } },
    };
    const current: Config = {
      ...started,
      sources: { source: { enabled: false, mirror: "https://manual.test/" } },
    };

    const merged = mergeSourceProbe(current, started, source, outcome(true, "https://fallback.test/"));
    expect(merged.sources.source).toEqual({
      enabled: false,
      mirror: "https://manual.test/",
      health: { ok: true, status: "ok" },
    });
  });

  it("adopts a successful fallback but never replaces a mirror after a failed probe", () => {
    const started: Config = {
      ...defaultConfig,
      sources: { source: { enabled: true, mirror: "https://old.test/" } },
    };

    const fallback = mergeSourceProbe(started, started, source, outcome(true, "https://fallback.test/"));
    expect(fallback.sources.source?.mirror).toBe("https://fallback.test/");

    const failed = mergeSourceProbe(started, started, source, outcome(false, "https://fallback.test/"));
    expect(failed.sources.source?.mirror).toBe("https://old.test/");
  });
});
