import { describe, expect, it, vi, beforeEach } from "vitest";
import { render } from "ink-testing-library";
import { promises as fs } from "node:fs";
import { createElement } from "react";
import { App } from "../src/ui/App";
import { configFile } from "../src/config/paths";

// Render smoke test: mounts the App with first-run already done so it lands on
// the search view without doing any real network probing.
describe("App (render smoke)", () => {
  beforeEach(async () => {
    await fs.mkdir(configFile.replace(/\/[^/]+$/, ""), { recursive: true });
    await fs.writeFile(
      configFile,
      JSON.stringify({ firstRunDone: true, sources: {}, torznab: [] }),
      "utf8",
    );
  });

  it("mounts and reaches the search UI", async () => {
    const { lastFrame, unmount } = render(createElement(App, { onQuit: () => {} }));
    // Allow boot effect (loadConfig + buildRegistry) to settle.
    await new Promise((r) => setTimeout(r, 800));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("minch");
    expect(frame.toLowerCase()).toMatch(/search|source/);
    unmount();
  });
});
