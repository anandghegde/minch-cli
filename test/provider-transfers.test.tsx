import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { createElement } from "react";
import { defaultConfig } from "../src/config/config";
import { DownloadManager } from "../src/download/manager";
import type { DebridId, Transfer, TransferFile } from "../src/debrid/types";
import { DownloadProvider } from "../src/ui/download-store";
import { ProviderTransfers } from "../src/ui/components/ProviderTransfers";
import { StoreContext, type Store } from "../src/ui/store";

function transfer(provider: DebridId, files: TransferFile[]): Transfer {
  return {
    id: `${provider}-transfer`,
    provider,
    name: `${provider} movie`,
    status: "done",
    progress: 1,
    sizeBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
    files,
  };
}

function renderTransfers(provider: DebridId, files: TransferFile[]) {
  const current = transfer(provider, files);
  const copyDownloadLink = vi.fn();
  const downloadLocally = vi.fn();
  const store = {
    config: defaultConfig,
    transfersLoading: false,
    transfersUpdatedAt: null,
    transfersError: {},
    listRows: 20,
    cols: 120,
    providerConfigured: () => true,
    transfersFor: () => [current],
    setNotice: vi.fn(),
    refreshTransfers: vi.fn(),
    openAccounts: vi.fn(),
    removeTransfer: vi.fn(),
  } as unknown as Store;
  const manager = new DownloadManager();
  const tree = createElement(
    StoreContext.Provider,
    { value: store },
    createElement(
      DownloadProvider,
      {
        manager,
         downloadLocally,
        copyDownloadLink,
        cancelDownload: vi.fn(),
        openDownload: vi.fn(),
        dismissDownload: vi.fn(),
        children: createElement(ProviderTransfers, { provider, active: true }),
      },
    ),
  );
  return {
    ...render(tree),
    copyDownloadLink,
    downloadLocally,
    current,
  };
}

describe("ProviderTransfers copy download link", () => {
  it.each(["torbox", "realdebrid"] as const)(
    "copies a single-file %s transfer with y",
    async (provider) => {
      const file = { id: "1", name: "movie.mkv", sizeBytes: 42, selected: true };
      const { stdin, copyDownloadLink, current, unmount } = renderTransfers(provider, [file]);

      await new Promise((resolve) => setTimeout(resolve, 0));
      stdin.write("y");
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(copyDownloadLink).toHaveBeenCalledWith(current, file);
      unmount();
    },
  );

  it("uses a file-only picker for a multi-file transfer", async () => {
    const files = [
      { id: "1", name: "first.mkv", sizeBytes: 42, selected: true },
      { id: "2", name: "second.srt", sizeBytes: 4, selected: true },
    ];
    const { stdin, lastFrame, copyDownloadLink, current, unmount } = renderTransfers("torbox", files);

    await new Promise((resolve) => setTimeout(resolve, 0));
    stdin.write("y");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lastFrame()).toContain("Copy link from");
    expect(lastFrame()).not.toContain("Download all");
    stdin.write("j");
    await new Promise((resolve) => setTimeout(resolve, 0));
    stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(copyDownloadLink).toHaveBeenCalledWith(current, files[1]);
    unmount();
  });

  it("expands a transfer and acts on the selected file", async () => {
    const files = [
      { id: "1", name: "first.mkv", sizeBytes: 42, selected: true },
      { id: "2", name: "second.srt", sizeBytes: 4, selected: true },
    ];
    const { stdin, lastFrame, copyDownloadLink, downloadLocally, current, unmount } = renderTransfers(
      "realdebrid",
      files,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    stdin.write("e");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(lastFrame()).toContain("first.mkv");
    expect(lastFrame()).toContain("second.srt");

    stdin.write("j");
    await new Promise((resolve) => setTimeout(resolve, 0));
    stdin.write("y");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(copyDownloadLink).toHaveBeenCalledWith(current, files[1]);

    stdin.write("l");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(downloadLocally).toHaveBeenCalledWith(current, files[1]);
    unmount();
  });
});
