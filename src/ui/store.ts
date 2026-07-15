import { createContext, useContext } from "react";
import type { Config } from "../config/config";
import type { Registry } from "../sources/registry";
import type { SortState } from "../sources/search";
import type { FilterState } from "../sources/filters";
import type { TorrentResult } from "../sources/types";
import type {
  AccountInfo,
  DebridId,
  DebridProvider,
  Transfer,
  TransferFile,
} from "../debrid/types";

export type View = "splash" | "search" | "trending" | "sources" | "realdebrid" | "torbox" | "settings";

/** Per-provider result of the most recent `checkAuth`, shown in Accounts. */
export interface DebridAuthState {
  checking: boolean;
  info?: AccountInfo;
  error?: string;
  checkedAt?: number;
}

export interface Store {
  config: Config;
  registry: Registry;
  /** Apply an intent-level update against the latest config snapshot. */
  updateConfig: (updater: (current: Config) => Config) => void;

  view: View;
  setView: (v: View) => void;

  query: string;
  submittedQuery: string;
  setQuery: (q: string) => void;
  submitQuery: (q: string) => void;
  /** Focus the search box (switch to the Search view and start editing the query). */
  focusSearch: () => void;

  sort: SortState | "default";
  cycleSort: () => void;

  filters: FilterState;
  cycleTimeFilter: () => void;
  cycleSizeFilter: () => void;
  cycleSeederFilter: () => void;
  cycleCategoryFilter: () => void;
  /** Cycle text-match mode: soft ↔ strict (hide tier &lt; 2). */
  cycleMatchFilter: () => void;
  resetFilters: () => void;
  /** Number of active filter dimensions; 0 when nothing is filtered. */
  activeFilterCount: number;

  notice: string | null;
  setNotice: (s: string | null) => void;

  copyMagnet: (input: { name: string; magnet: string }) => void;
  openMagnet: (input: { name: string; magnet: string }) => void;

  retestSource: (id: string, mirror?: string) => void;
  retestAll: () => void;
  toggleSource: (id: string) => void;
  setMirror: (id: string, mirror: string) => void;

  // Debrid / Transfers --------------------------------------------------------
  /** Every registered provider (configured or not), for the Accounts screen. */
  debridProviders: DebridProvider[];
  /** True when at least one provider has a usable key right now. */
  anyDebridConfigured: boolean;
  /** Merged, newest-first transfers across configured providers. */
  transfers: Transfer[];
  transfersLoading: boolean;
  /** Per-provider poll error, keyed by provider id (null when healthy). */
  transfersError: Record<string, string | null>;
  /** Unix ms of the last poll cycle. */
  transfersUpdatedAt: number | null;
  /** Hand a found result off to a debrid provider (defaults to the preferred one). */
  sendToDebrid: (result: TorrentResult, providerId?: DebridId) => void;
  refreshTransfers: () => void;
  removeTransfer: (t: Transfer) => void;
  /** The merged transfer list, filtered to a single provider (newest-first). */
  transfersFor: (provider: DebridId) => Transfer[];
  /** True when the given provider has a usable key right now. */
  providerConfigured: (provider: DebridId) => boolean;

  // Accounts ------------------------------------------------------------------
  accountsOpen: boolean;
  openAccounts: () => void;
  closeAccounts: () => void;
  debridAuth: Record<string, DebridAuthState>;
  checkDebridAuth: (id: DebridId) => void;
  saveDebridKey: (id: DebridId, key: string | undefined) => void;
  saveTmdbToken: (token: string | undefined) => void;
  saveStreamingAvailabilityKey: (key: string | undefined) => void;
  saveApifyToken: (token: string | undefined) => void;
  saveFirecrawlKey: (key: string | undefined) => void;
  saveMdblistKey: (key: string | undefined) => void;

  quitAll: () => void;

  cols: number;
  rows: number;
  listRows: number;
}

export const StoreContext = createContext<Store | null>(null);

export function useStore(): Store {
  const s = useContext(StoreContext);
  if (!s) throw new Error("Store not available");
  return s;
}
