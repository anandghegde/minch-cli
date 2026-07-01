import { useEffect, useState } from "react";
import type { DownloadEntry, DownloadManager } from "../../download/manager";

/**
 * Subscribe to a DownloadManager and re-render on every snapshot change. The
 * manager owns the state (it outlives renders via a ref); this hook just mirrors
 * its newest-first list into React state.
 */
export function useDownloads(manager: DownloadManager): DownloadEntry[] {
  const [downloads, setDownloads] = useState<DownloadEntry[]>(() => manager.list());
  useEffect(() => {
    setDownloads(manager.list());
    return manager.subscribe(() => setDownloads(manager.list()));
  }, [manager]);
  return downloads;
}
