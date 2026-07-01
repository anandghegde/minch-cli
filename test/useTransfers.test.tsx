import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { useTransfers } from "../src/ui/hooks/useTransfers";
import type { DebridId, DebridProvider, Transfer } from "../src/debrid/types";

function tx(
  provider: DebridId,
  id: string,
  addedAt: number,
  status: Transfer["status"] = "downloading",
): Transfer {
  return {
    provider,
    id,
    name: `name-${id}`,
    sizeBytes: 0,
    progress: 0,
    status,
    files: [],
    addedAt,
  };
}

function mockProvider(
  id: DebridId,
  listTransfers: () => Promise<Transfer[]>,
): DebridProvider {
  return {
    id,
    label: id,
    isConfigured: () => true,
    checkAuth: async () => ({}),
    addMagnet: async () => ({}),
    listTransfers,
    getTransfer: async () => {
      throw new Error("not used");
    },
    remove: async () => {},
    resolveFileUrl: async () => ({ url: "", filename: "" }),
  };
}

function Harness({ providers }: { providers: DebridProvider[] }) {
  const { transfers } = useTransfers(providers);
  return createElement(Text, null, transfers.map((t) => `${t.provider}:${t.id}`).join("|"));
}

async function until(fn: () => boolean, ms = 1500): Promise<void> {
  const start = Date.now();
  while (!fn() && Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("useTransfers", () => {
  it("merges every provider's transfers, newest first", async () => {
    const p1 = mockProvider("torbox", async () => [tx("torbox", "1", 100), tx("torbox", "2", 300)]);
    const p2 = mockProvider("realdebrid", async () => [tx("realdebrid", "3", 200)]);

    const { lastFrame, unmount } = render(
      createElement(Harness, { providers: [p1, p2] }),
    );
    await until(() => (lastFrame() ?? "").includes("torbox:2"));
    // Sorted by addedAt desc: 2 (300), 3 (200), 1 (100).
    expect(lastFrame()).toBe("torbox:2|realdebrid:3|torbox:1");
    unmount();
  });

  it("keeps healthy providers visible when another fails", async () => {
    const good = mockProvider("torbox", async () => [tx("torbox", "1", 100)]);
    const bad = mockProvider("realdebrid", async () => {
      throw new Error("provider down");
    });

    const { lastFrame, unmount } = render(
      createElement(Harness, { providers: [good, bad] }),
    );
    await until(() => (lastFrame() ?? "").includes("torbox:1"));
    expect(lastFrame()).toBe("torbox:1");
    unmount();
  });

  it("renders nothing and does not poll without providers", async () => {
    const { lastFrame, unmount } = render(createElement(Harness, { providers: [] }));
    await new Promise((r) => setTimeout(r, 50));
    expect(lastFrame()).toBe("");
    unmount();
  });
});
