import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import { createElement } from "react";
import { render } from "ink-testing-library";
import { App } from "../src/ui/App";
import { configFile } from "../src/config/paths";

async function settle(ms = 60) { await new Promise((resolve) => setTimeout(resolve, ms)); }

describe("rating settings", () => {
  beforeEach(async () => {
    vi.stubEnv("TMDB_READ_TOKEN", "");
    vi.stubEnv("STREAMING_AVAILABILITY_API_KEY", "");
    vi.stubEnv("MDBLIST_API_KEY", "");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    await fs.mkdir(configFile.replace(/\/[^/]+$/, ""), { recursive: true });
    await fs.writeFile(configFile, JSON.stringify({
      firstRunDone: true, sources: {}, torznab: [],
    }), "utf8");
  });

  afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

  it("cycles the exact provider and saves a masked user-owned MDBList key", async () => {
    const view = render(createElement(App, { onQuit: () => {} }));
    await settle(800);
    for (let index = 0; index < 5; index += 1) view.stdin.write("\t");
    await settle();
    for (let index = 0; index < 8; index += 1) view.stdin.write("j");
    await settle();
    expect(view.lastFrame()).toContain("IMDb ratings source");
    view.stdin.write("\u001b[C");
    await settle();
    view.stdin.write("\u001b[C");
    await settle();
    expect(view.lastFrame()).toContain("MDBList selected; configure MDBLIST_API_KEY");
    view.stdin.write("j");
    await settle();
    view.stdin.write("\r");
    await settle();
    view.stdin.write("user-owned-key");
    await settle();
    view.stdin.write("\r");
    await settle(100);
    const saved = JSON.parse(await fs.readFile(configFile, "utf8")) as {
      discovery?: { ratingProvider?: string; mdblist?: { apiKey?: string } };
    };
    expect(saved.discovery?.ratingProvider).toBe("mdblist");
    expect(saved.discovery?.mdblist?.apiKey).toBe("user-owned-key");
    expect(view.lastFrame()).not.toContain("user-owned-key");
    view.unmount();
  });
});
