import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { Transfer, TransferFile } from "../debrid/types";
import type { DownloadEntry, DownloadManager } from "../download/manager";
import { useDownloads } from "./hooks/useDownloads";

interface DownloadStore {
  downloads: DownloadEntry[];
  downloadLocally: (transfer: Transfer, file?: TransferFile) => void;
  copyDownloadLink: (transfer: Transfer, file: TransferFile) => void;
  cancelDownload: (id: string) => void;
  openDownload: (entry: DownloadEntry) => void;
  dismissDownload: (id: string) => void;
}

const DownloadContext = createContext<DownloadStore | null>(null);

export function DownloadProvider({
  manager,
  downloadLocally,
  copyDownloadLink,
  cancelDownload,
  openDownload,
  dismissDownload,
  children,
}: Omit<DownloadStore, "downloads"> & { manager: DownloadManager; children: ReactNode }) {
  const downloads = useDownloads(manager);
  const value = useMemo(
    () => ({ downloads, downloadLocally, copyDownloadLink, cancelDownload, openDownload, dismissDownload }),
    [downloads, downloadLocally, copyDownloadLink, cancelDownload, openDownload, dismissDownload],
  );
  return <DownloadContext.Provider value={value}>{children}</DownloadContext.Provider>;
}

export function useDownloadStore(): DownloadStore {
  const store = useContext(DownloadContext);
  if (!store) throw new Error("Download store not available");
  return store;
}
