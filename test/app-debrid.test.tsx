import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render } from "ink-testing-library";
import { promises as fs } from "node:fs";
import { createElement } from "react";
import { App } from "../src/ui/App";
import { configFile } from "../src/config/paths";

// Integration smoke for the debrid wiring. With only a TorBox key configured,
// tab cycles Search → Trending → Real-Debrid → TorBox → Sources: the Real-Debrid
// tab shows unconfigured guidance while the TorBox tab shows its own (empty)
// transfers. fetch is stubbed so the transfers poll never touches the network.
function torboxStub(): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    const empty = { success: true, data: [] };
    if (url.includes("/torrents/mylist") || url.includes("/webdl/mylist")) {
      return new Response(JSON.stringify(empty), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ success: true, data: {} }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

async function settle(ms = 60): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("App debrid integration", () => {
  beforeEach(async () => {
    delete process.env.MINCH_TORBOX_KEY;
    delete process.env.MINCH_REALDEBRID_KEY;
    vi.stubEnv("TMDB_READ_TOKEN", "");
    vi.stubEnv("STREAMING_AVAILABILITY_API_KEY", "");
    vi.stubGlobal("fetch", torboxStub());
    await fs.mkdir(configFile.replace(/\/[^/]+$/, ""), { recursive: true });
    await fs.writeFile(
      configFile,
      JSON.stringify({
        firstRunDone: true,
        sources: {},
        torznab: [],
        debrid: { torbox: { apiKey: "tbkeyABCD1234" } },
      }),
      "utf8",
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("cycles the provider tabs, scoping guidance per provider", async () => {
    const { lastFrame, stdin, unmount } = render(createElement(App, { onQuit: () => {} }));
    await settle(800); // boot: loadConfig + buildRegistry

    // search -> trending -> realdebrid: Real-Debrid has no key, so it prompts
    // to add one. (Trending sits between Search and Real-Debrid.)
    stdin.write("\t");
    await settle();
    stdin.write("\t");
    await settle();
    const rdFrame = lastFrame() ?? "";
    expect(rdFrame).toMatch(/real ?debrid/i);
    expect(rdFrame.toLowerCase()).toContain("configured");
    // No TorBox-only messaging is bleeding into the Real-Debrid tab.
    expect(rdFrame).not.toContain("No TorBox transfers");

    // realdebrid -> torbox: TorBox is configured but empty.
    stdin.write("\t");
    await settle();
    const tbFrame = lastFrame() ?? "";
    expect(tbFrame).toContain("TorBox");
    expect(tbFrame.toLowerCase()).toMatch(/transfer/);
    expect(tbFrame).toContain("No TorBox transfers");

    // torbox -> sources.
    stdin.write("\t");
    await settle();
    expect((lastFrame() ?? "").toLowerCase()).toMatch(/source/);

    // sources -> settings, where persisted preferences and credentials are managed.
    stdin.write("\t");
    await settle(300);
    expect(lastFrame()).toContain("Settings");
    expect(lastFrame()).toContain("Download folder");
    expect(lastFrame()).toContain("Streaming Availability key");

    unmount();
  });

  it("opens the Accounts overlay with a masked TorBox key", async () => {
    const { lastFrame, stdin, unmount } = render(createElement(App, { onQuit: () => {} }));
    await settle(800); // boot: loadConfig + buildRegistry

    // Open Accounts: shows the provider and the key masked to its last 4 chars.
    stdin.write("a");
    await settle();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Accounts");
    expect(frame).toContain("TorBox");
    expect(frame).toContain("1234");
    expect(frame).not.toContain("tbkeyABCD1234");

    unmount();
  });

  it("persists the download folder from Settings", async () => {
    const { lastFrame, stdin, unmount } = render(createElement(App, { onQuit: () => {} }));
    await settle(800);

    for (let i = 0; i < 5; i++) stdin.write("\t");
    await settle();
    expect(lastFrame()).toContain("Settings");

    stdin.write("j");
    await settle();
    stdin.write("j");
    await settle();
    stdin.write("\r");
    await settle();
    stdin.write("/tmp/minch-downloads");
    await settle();
    stdin.write("\r");
    await settle();

    const saved = JSON.parse(await fs.readFile(configFile, "utf8")) as {
      debrid?: { downloadDir?: string };
    };
    expect(saved.debrid?.downloadDir).toBe("/tmp/minch-downloads");
    unmount();
  });

  it("persists an explicit Blu-ray discovery disable", async () => {
    const { lastFrame, stdin, unmount } = render(createElement(App, { onQuit: () => {} }));
    await settle(800);
    for (let index = 0; index < 5; index += 1) stdin.write("\t");
    await settle(100);
    expect(lastFrame()).toContain("Settings");

    for (let index = 0; index < 7; index += 1) stdin.write("j");
    await settle();
    expect(lastFrame()).toContain("Blu-ray RSS discovery");
    stdin.write(" ");
    await settle(100);

    const saved = JSON.parse(await fs.readFile(configFile, "utf8")) as {
      discovery?: { disabledSources?: string[] };
    };
    expect(saved.discovery?.disabledSources).toContain("bluray");
    expect(lastFrame()).toContain("Blu-ray RSS discovery disabled");
    unmount();
  });
});
