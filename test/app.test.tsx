import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { promises as fs } from "node:fs";
import { createElement } from "react";
import { App } from "../src/ui/App";
import { configFile } from "../src/config/paths";

// Render smoke test: mounts the App with first-run already done so it lands on
// the search view without doing any real network probing.
describe("App (render smoke)", () => {
  beforeEach(async () => {
    vi.stubEnv("TMDB_READ_TOKEN", "");
    vi.stubEnv("STREAMING_AVAILABILITY_API_KEY", "");
    await fs.mkdir(configFile.replace(/\/[^/]+$/, ""), { recursive: true });
    await fs.writeFile(
      configFile,
      JSON.stringify({ firstRunDone: true, sources: {}, torznab: [] }),
      "utf8",
    );
  });

  afterEach(() => vi.unstubAllEnvs());

  it("mounts and reaches the search UI", async () => {
    const { lastFrame, unmount } = render(createElement(App, { onQuit: () => {} }));
    // Allow boot effect (loadConfig + buildRegistry) to settle.
    await new Promise((r) => setTimeout(r, 800));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("minch");
    expect(frame).toContain("Discover");
    expect(frame.toLowerCase()).toMatch(/search|source/);
    unmount();
  });

  it("preserves Discover filter state while cycling through other tabs", async () => {
    const { lastFrame, stdin, unmount } = render(createElement(App, { onQuit: () => {} }));
    await new Promise((resolve) => setTimeout(resolve, 800));

    stdin.write("\t");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(lastFrame()).toContain("[ Discover ]");
    stdin.write("m");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(lastFrame()).toContain("Movies");

    for (let index = 0; index < 6; index += 1) {
      stdin.write("\t");
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    expect(lastFrame()).toContain("[ Discover ]");
    expect(lastFrame()).toContain("Movies");
    unmount();
  });

});
