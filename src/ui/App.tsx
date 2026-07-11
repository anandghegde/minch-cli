import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdin, useStdout } from "ink";
import {
  loadConfig,
  takeConfigWarnings,
  type Config,
} from "../config/config";
import { activeMirror, buildRegistry, type Registry } from "../sources/registry";
import { probeAll } from "../sources/health";
import { nextSort, type SortState } from "../sources/search";
import {
  emptyFilters,
  filtersFromConfig,
  cycleTime,
  cycleSize,
  cycleSeeders,
  cycleCategory,
  cycleMatch,
  activeFilterCount as countFilters,
  type FilterState,
} from "../sources/filters";
import { writeClipboard, openExternal } from "../util/clipboard";
import { disposeResponse, fetchResilient, HttpError, USER_AGENT } from "../util/net";
import { infoHashFromMagnet } from "../sources/magnet";
import { truncate, cleanText } from "../util/format";
import {
  allProviders,
  getProvider,
  defaultProvider,
} from "../debrid/registry";
import { withDebridKey } from "../debrid/keys";
import {
  isDebridError,
  PROVIDER_LABELS,
  type DebridId,
  type Transfer,
  type TransferFile,
} from "../debrid/types";
import { DownloadManager, resolveDownloadDir, type DownloadEntry } from "../download/manager";
import type { TorrentResult } from "../sources/types";
import { StoreContext, type Store, type View, type DebridAuthState } from "./store";
import { Logo } from "./components/Logo";
import { Footer, type Hint } from "./components/Footer";
import { SearchBar } from "./components/SearchBar";
import { Results } from "./components/Results";
import { Sources } from "./components/Sources";
import { Discover } from "./components/Discover";
import { Tabs } from "./components/Tabs";
import { ProviderTransfers } from "./components/ProviderTransfers";
import { Accounts } from "./components/Accounts";
import { Settings } from "./components/Settings";
import { HelpOverlay } from "./components/HelpOverlay";
import { Spinner } from "./components/Spinner";
import { Splash, type ProbeProgress } from "./views/Splash";
import { useTransfers } from "./hooks/useTransfers";
import { useSourceActions } from "./hooks/useSourceActions";
import { useConfig } from "./hooks/useConfig";
import { DownloadProvider } from "./download-store";
import { listRowsForTerminal } from "./layout";
import { COLOR } from "./theme";
import {
  withStreamingAvailabilityApiKey,
  withTmdbReadToken,
} from "../discovery/config";

export const TAB_ORDER: View[] = ["search", "trending", "realdebrid", "torbox", "sources", "settings"];

/** User-facing tab labels, used for the tab bar and footer "tab" hint. */
export const TAB_LABELS: Record<View, string> = {
  splash: "",
  search: "Torrent Search",
  trending: "Discover",
  realdebrid: "Real-Debrid",
  torbox: "TorBox",
  sources: "Sources",
  settings: "Settings",
};

/** Turn any thrown debrid failure into a short, non-crashing notice. */
function debridNotice(e: unknown, label: string): string {
  if (isDebridError(e)) {
    const prefix: Record<string, string> = {
      auth: "auth failed",
      quota: "rate limited",
      validation: "rejected",
      transient: "temporary error",
      unknown: "error",
    };
    return `${label}: ${prefix[e.kind] ?? "error"} — ${e.message}`;
  }
  return `${label}: ${e instanceof Error ? e.message : String(e)}`;
}

export function App({
  initialQuery,
  onQuit,
}: {
  initialQuery?: string;
  onQuit?: () => void;
}) {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const { stdout } = useStdout();

  const [size, setSize] = useState({
    rows: stdout?.rows ?? 24,
    cols: stdout?.columns ?? 80,
  });
  useEffect(() => {
    if (!stdout) return;
    const onResize = (): void =>
      setSize({ rows: stdout.rows ?? 24, cols: stdout.columns ?? 80 });
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  const [registry, setRegistry] = useState<Registry | null>(null);
  const [view, setView] = useState<View>("splash");
  const [query, setQuery] = useState(initialQuery ?? "");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [sort, setSort] = useState<SortState | "default">("default");
  const [filters, setFilters] = useState<FilterState>(emptyFilters);
  const [notice, setNotice] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [editing, setEditing] = useState(false);
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [settingsEditing, setSettingsEditing] = useState(false);
  const [debridAuth, setDebridAuth] = useState<Record<string, DebridAuthState>>({});
  const [progress, setProgress] = useState<ProbeProgress>({ total: 0, done: 0, ok: 0 });
  const booting = useRef(false);
  const { config, configRef, hydrateConfig, commitConfig, updateConfig } = useConfig(setNotice);

  // Boot: load config, build registry, run first-run probe if needed.
  useEffect(() => {
    if (booting.current) return;
    booting.current = true;
    let alive = true;
    void (async () => {
      const cfg = await loadConfig();
      const configWarnings = takeConfigWarnings();
      const configWarning = configWarnings.length > 0
        ? `${configWarnings[0]}${configWarnings.length > 1 ? ` (+${configWarnings.length - 1} more)` : ""}`
        : null;
      const reg = await buildRegistry(cfg);
      if (!alive) return;
      setRegistry(reg);

      if (cfg.firstRunDone) {
        hydrateConfig(cfg);
        setFilters(filtersFromConfig(cfg.relevance));
        if (configWarning) setNotice(configWarning);
        setView("search");
        if (initialQuery?.trim()) setSubmittedQuery(initialQuery.trim());
        return;
      }

      // First run: probe every source, enabling those that pass.
      const probeTargets = reg.sources.filter((s) => !s.requiresConfig);
      setProgress({ total: probeTargets.length, done: 0, ok: 0 });
      const working: Record<string, Config["sources"][string]> = {};
      let done = 0;
      let ok = 0;
      await probeAll(
        probeTargets,
        (s) => activeMirror(s, cfg),
        (outcome) => {
          if (!alive) return;
          done++;
          if (outcome.health.ok) ok++;
          working[outcome.id] = {
            enabled: outcome.health.ok,
            mirror: outcome.mirror,
            health: outcome.health,
          };
          const src = reg.byId.get(outcome.id);
          setProgress({ total: probeTargets.length, done, ok, current: src?.label });
        },
      );
      if (!alive) return;
      const next: Config = { ...cfg, sources: { ...cfg.sources, ...working }, firstRunDone: true };
      commitConfig(next);
      setFilters(filtersFromConfig(next.relevance));
      // Brief pause so the user sees the "Ready" state, then enter.
      setTimeout(() => {
        if (!alive) return;
        setView("search");
        if (configWarning) setNotice(configWarning);
        if (initialQuery?.trim()) setSubmittedQuery(initialQuery.trim());
      }, 700);
    })();
    return () => {
      alive = false;
    };
  }, [initialQuery, commitConfig, hydrateConfig]);

  const quitAll = useCallback(() => {
    if (onQuit) onQuit();
    else exit();
  }, [onQuit, exit]);

  const submitQuery = useCallback((raw: string) => {
    const q = raw.trim();
    setQuery(q);
    setSubmittedQuery(q);
    setEditing(false);
    setView("search");
  }, []);

  const focusSearch = useCallback(() => {
    setView("search");
    setEditing(true);
  }, []);

  const cycleSort = useCallback(() => setSort((s) => nextSort(s)), []);

  const cycleTimeFilter = useCallback(() => setFilters((f) => cycleTime(f)), []);
  const cycleSizeFilter = useCallback(() => setFilters((f) => cycleSize(f)), []);
  const cycleSeederFilter = useCallback(() => setFilters((f) => cycleSeeders(f)), []);
  const cycleCategoryFilter = useCallback(() => setFilters((f) => cycleCategory(f)), []);
  const cycleMatchFilter = useCallback(() => setFilters((f) => cycleMatch(f)), []);
  // Reset returns to config-seeded defaults (not a hard empty), so
  // relevance.strictAnd / hideTrash in config.json stay effective after `r`.
  const resetFilters = useCallback(() => {
    setFilters(filtersFromConfig(configRef.current?.relevance));
  }, []);
  const activeFilterCount = useMemo(() => countFilters(filters), [filters]);

  // Settings can change the persistent relevance defaults while the app is
  // running. Keep the current search view aligned with those two defaults.
  useEffect(() => {
    if (!config) return;
    const match = config.relevance?.strictAnd === true ? 1 : 0;
    const hideTrash = config.relevance?.hideTrash === true;
    setFilters((current) =>
      current.match === match && current.hideTrash === hideTrash
        ? current
        : { ...current, match, hideTrash },
    );
  }, [config?.relevance?.strictAnd, config?.relevance?.hideTrash]);

  // Debrid providers, rebuilt whenever config changes (key edits, env). The
  // polling hook only restarts when the configured id set changes.
  const debridProviders = useMemo(
    () => (config ? allProviders(config) : []),
    [config],
  );
  const configuredDebrid = useMemo(
    () => debridProviders.filter((p) => p.isConfigured()),
    [debridProviders],
  );
  const anyDebridConfigured = configuredDebrid.length > 0;

  const {
    transfers,
    perProvider,
    loading: transfersLoading,
    lastUpdated: transfersUpdatedAt,
    refresh: refreshTransfers,
  } = useTransfers(configuredDebrid);

  const transfersError = useMemo(() => {
    const out: Record<string, string | null> = {};
    for (const [id, st] of Object.entries(perProvider)) out[id] = st.error;
    return out;
  }, [perProvider]);

  const transfersFor = useCallback(
    (provider: DebridId) => transfers.filter((t) => t.provider === provider),
    [transfers],
  );
  const providerConfigured = useCallback(
    (provider: DebridId) => configuredDebrid.some((p) => p.id === provider),
    [configuredDebrid],
  );

  const sendToDebrid = useCallback(
    (result: TorrentResult, providerId?: DebridId) => {
      const cfg = configRef.current;
      if (!cfg) return;
      const provider = providerId
        ? getProvider(providerId, cfg)
        : defaultProvider(cfg);
      if (!provider || !provider.isConfigured()) {
        const label = PROVIDER_LABELS[providerId ?? "torbox"];
        setNotice(`Add a ${label} key in Accounts (press a).`);
        return;
      }
      setNotice(`Sending to ${provider.label}…`);
      void (async () => {
        try {
          // Best-effort pre-flight: label instant (cached) vs will queue. Never
          // let a cache-check failure block the actual hand-off.
          if (provider.checkCached && result.magnet) {
            try {
              const cached = await provider.checkCached([result.magnet]);
              const hash = infoHashFromMagnet(result.magnet);
              if (hash && hash in cached) {
                setNotice(
                  `Sending to ${provider.label} — ${cached[hash] ? "instant (cached)" : "will queue"}…`,
                );
              }
            } catch {
              /* ignore pre-flight errors */
            }
          }
          let res;
          if (result.magnet) {
            res = await provider.addMagnet(result.magnet, { name: result.name });
          } else if (result.downloadUrl && provider.addTorrentFile) {
            const resp = await fetchResilient(result.downloadUrl, {
              headers: { "User-Agent": USER_AGENT },
            });
            if (!resp.ok) {
              await disposeResponse(resp);
              throw new HttpError(resp.status, `torrent download returned ${resp.status}`);
            }
            const data = new Uint8Array(await resp.arrayBuffer());
            res = await provider.addTorrentFile(data, result.name, {
              name: result.name,
            });
          } else {
            setNotice("No magnet or .torrent for this result.");
            return;
          }
          setNotice(
            res.detail ??
              (res.alreadyPresent
                ? `Already on ${provider.label}.`
                : `Added to ${provider.label}.`),
          );
          setView(provider.id);
          refreshTransfers();
        } catch (e) {
          setNotice(debridNotice(e, provider.label));
        }
      })();
    },
    [refreshTransfers],
  );

  const removeTransfer = useCallback(
    (t: Transfer) => {
      const cfg = configRef.current;
      if (!cfg) return;
      const provider = getProvider(t.provider, cfg);
      if (!provider) return;
      setNotice(`Removing ${truncate(cleanText(t.name), 40)}…`);
      void (async () => {
        try {
          await provider.remove(t.id);
          setNotice(`Removed from ${provider.label}.`);
          refreshTransfers();
        } catch (e) {
          setNotice(debridNotice(e, provider.label));
        }
      })();
    },
    [refreshTransfers],
  );

  // Local download accelerator. The manager owns download state across renders;
  // useDownloads mirrors its snapshots into React for the progress bars.
  const managerRef = useRef<DownloadManager | null>(null);
  if (!managerRef.current) managerRef.current = new DownloadManager();
  const manager = managerRef.current;

  const downloadLocally = useCallback(
    (transfer: Transfer, file?: TransferFile) => {
      const cfg = configRef.current;
      if (!cfg) return;
      const provider = getProvider(transfer.provider, cfg);
      if (!provider || !provider.isConfigured()) {
        setNotice(`Add a ${PROVIDER_LABELS[transfer.provider]} key in Accounts (press a).`);
        return;
      }
      const target = file ?? (transfer.files.length === 1 ? transfer.files[0] : undefined);
      if (!target) {
        setNotice("Pick a file to download (multi-file transfer).");
        return;
      }
      const dir = resolveDownloadDir(cfg);
      manager.start({ provider, transfer, file: target, dir });
      setNotice(`Downloading ${truncate(cleanText(target.name), 32)} → ${dir}`);
      setView(transfer.provider);
    },
    [manager],
  );

  const cancelDownload = useCallback(
    (id: string) => {
      manager.cancel(id);
      setNotice("Download canceled — resume later with l.");
    },
    [manager],
  );

  const openDownload = useCallback((entry: DownloadEntry) => {
    if (!entry.path) return;
    void (async () => {
      const ok = await openExternal(entry.path!);
      setNotice(
        ok ? `Opening ${truncate(cleanText(entry.name), 40)}` : "Couldn't open the file.",
      );
    })();
  }, []);

  const dismissDownload = useCallback(
    (id: string) => {
      manager.dismiss(id);
    },
    [manager],
  );

  const openAccounts = useCallback(() => setAccountsOpen(true), []);
  const closeAccounts = useCallback(() => setAccountsOpen(false), []);

  const checkDebridAuth = useCallback((id: DebridId) => {
    const cfg = configRef.current;
    if (!cfg) return;
    const provider = getProvider(id, cfg);
    if (!provider || !provider.isConfigured()) {
      setDebridAuth((s) => ({ ...s, [id]: { checking: false, error: "No key set." } }));
      return;
    }
    setDebridAuth((s) => ({ ...s, [id]: { checking: true } }));
    void (async () => {
      try {
        const info = await provider.checkAuth();
        setDebridAuth((s) => ({
          ...s,
          [id]: { checking: false, info, checkedAt: Date.now() },
        }));
      } catch (e) {
        setDebridAuth((s) => ({
          ...s,
          [id]: { checking: false, error: debridNotice(e, provider.label), checkedAt: Date.now() },
        }));
      }
    })();
  }, []);

  const saveDebridKey = useCallback(
    (id: DebridId, key: string | undefined) => {
      const cfg = configRef.current;
      if (!cfg) return;
      updateConfig((current) => withDebridKey(current, id, key));
      // Reset any stale auth result so the user re-verifies the new key.
      setDebridAuth((s) => ({ ...s, [id]: { checking: false } }));
      setNotice(key ? `Saved ${PROVIDER_LABELS[id]} key.` : `Cleared ${PROVIDER_LABELS[id]} key.`);
      refreshTransfers();
    },
    [updateConfig, refreshTransfers],
  );

  const saveTmdbToken = useCallback((token: string | undefined) => {
    updateConfig((current) => withTmdbReadToken(current, token));
    setNotice(token ? "Saved TMDB read token." : "Cleared TMDB read token.");
  }, [updateConfig]);

  const saveStreamingAvailabilityKey = useCallback((key: string | undefined) => {
    updateConfig((current) => withStreamingAvailabilityApiKey(current, key));
    setNotice(key
      ? "Saved Streaming Availability API key."
      : "Cleared Streaming Availability API key.");
  }, [updateConfig]);

  const copyMagnet = useCallback(
    (input: { name: string; magnet: string }) => {
      void (async () => {
        if (!input.magnet) {
          setNotice("No magnet for this result.");
          return;
        }
        const okCopy = await writeClipboard(input.magnet);
        setNotice(
          okCopy
            ? `Copied magnet: ${truncate(cleanText(input.name), 48)}`
            : "Couldn't copy to clipboard.",
        );
      })();
    },
    [],
  );

  const openMagnet = useCallback((input: { name: string; magnet: string }) => {
    void (async () => {
      if (!input.magnet) {
        setNotice("No magnet for this result.");
        return;
      }
      const ok = await openExternal(input.magnet);
      setNotice(
        ok
          ? `Opening: ${truncate(cleanText(input.name), 48)}`
          : "Couldn't open the magnet handler.",
      );
    })();
  }, []);

  const { retestSource, retestAll, toggleSource, setMirror } = useSourceActions({
    registry,
    configRef,
    updateConfig,
    setNotice,
  });

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const rows = size.rows;
  const cols = size.cols;
  const listRows = listRowsForTerminal(rows, cols);

  const store = useMemo<Store | null>(() => {
    if (!config || !registry) return null;
    return {
      config,
      registry,
      updateConfig,
      view,
      setView,
      query,
      submittedQuery,
      setQuery,
      submitQuery,
      focusSearch,
      sort,
      cycleSort,
      filters,
      cycleTimeFilter,
      cycleSizeFilter,
      cycleSeederFilter,
      cycleCategoryFilter,
      cycleMatchFilter,
      resetFilters,
      activeFilterCount,
      notice,
      setNotice,
      copyMagnet,
      openMagnet,
      retestSource,
      retestAll,
      toggleSource,
      setMirror,
      debridProviders,
      anyDebridConfigured,
      transfers,
      transfersLoading,
      transfersError,
      transfersUpdatedAt,
      sendToDebrid,
      refreshTransfers,
      removeTransfer,
      transfersFor,
      providerConfigured,
      downloadLocally,
      cancelDownload,
      openDownload,
      dismissDownload,
      accountsOpen,
      openAccounts,
      closeAccounts,
      debridAuth,
      checkDebridAuth,
      saveDebridKey,
      saveTmdbToken,
      saveStreamingAvailabilityKey,
      quitAll,
      cols,
      rows,
      listRows,
    };
  }, [
    config, registry, updateConfig, view, query, submittedQuery, submitQuery, focusSearch, sort,
    cycleSort, notice, copyMagnet, openMagnet, retestSource, retestAll,
    toggleSource, setMirror, quitAll, cols, rows, listRows,
    filters, cycleTimeFilter, cycleSizeFilter, cycleSeederFilter, cycleCategoryFilter,
    cycleMatchFilter,
    resetFilters, activeFilterCount,
    debridProviders, anyDebridConfigured, transfers, transfersLoading,
    transfersError, transfersUpdatedAt, sendToDebrid, refreshTransfers,
    removeTransfer, transfersFor, providerConfigured,
    accountsOpen, openAccounts, closeAccounts, debridAuth,
    checkDebridAuth, saveDebridKey, saveTmdbToken, saveStreamingAvailabilityKey,
    downloadLocally, cancelDownload, openDownload, dismissDownload,
  ]);

  // Global input (only when not editing the search field and a store exists).
  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") {
        quitAll();
        return;
      }
      // The Accounts overlay captures every other key (including typed text).
      if (accountsOpen || settingsEditing) return;
      if (showHelp) {
        setShowHelp(false);
        return;
      }
      if (input === "?") {
        setShowHelp(true);
        return;
      }
      if (editing) return;
      if (key.tab) {
        setView((v) => {
          const i = TAB_ORDER.indexOf(v);
          return TAB_ORDER[(i + 1) % TAB_ORDER.length] ?? "search";
        });
        return;
      }
      if (input === "/" || input === "i") {
        focusSearch();
        return;
      }
      if (input === "a") {
        setAccountsOpen(true);
        return;
      }
      if (input === "q") {
        quitAll();
        return;
      }
    },
    { isActive: isRawModeSupported && view !== "splash" && !!store },
  );

  if (!store) {
    // A2: during the first-run probe, config stays null until persist() runs
    // after the probe finishes, so the gated store would never exist while
    // probing — rendering only the bare "Starting minch" spinner and hiding the
    // incremental Splash progress. Render Splash directly (no store needed) so
    // the per-source probe progress is visible.
    if (progress.total > 0) {
      return <Splash progress={progress} rows={rows} cols={cols} />;
    }
    return (
      <Box height={rows} justifyContent="center" alignItems="center">
        <Spinner label="Starting minch" />
      </Box>
    );
  }

  if (view === "splash") {
    return (
      <StoreContext.Provider value={store}>
        <Splash progress={progress} />
      </StoreContext.Provider>
    );
  }

  const nextView =
    TAB_ORDER[(TAB_ORDER.indexOf(view) + 1) % TAB_ORDER.length] ?? "search";
  const tabHint: Hint = { keys: "tab", label: TAB_LABELS[nextView] };

  const footerHints: Hint[] =
    view === "sources"
      ? [
          { keys: "\u2191\u2193", label: "Move" },
          { keys: "e", label: "Enable" },
          { keys: "t/T", label: "Retest" },
          { keys: "m", label: "Mirror" },
          tabHint,
          { keys: "?", label: "Keys" },
        ]
      : view === "trending"
        ? [
            { keys: "\u2191\u2193", label: "Move" },
            { keys: "\u2190\u2192", label: "Feed" },
            { keys: "m", label: "Type" },
            { keys: "p", label: "Provider" },
            { keys: "l", label: "Language" },
            { keys: "i", label: "Indian titles" },
            { keys: "t", label: "Window" },
            { keys: "enter", label: "Details" },
            { keys: "s", label: "Search torrents" },
            { keys: "r", label: "Refresh" },
            tabHint,
            { keys: "?", label: "Keys" },
          ]
      : view === "realdebrid" || view === "torbox"
        ? [
            { keys: "\u2191\u2193", label: "Move" },
            { keys: "l", label: "Download" },
            { keys: "c", label: "Cancel" },
            { keys: "o", label: "Open" },
            { keys: "x", label: "Remove" },
            tabHint,
            { keys: "?", label: "Keys" },
          ]
        : editing && view === "search"
          ? [
              { keys: "enter", label: "Search" },
              { keys: "\u2190\u2192", label: "Caret" },
              { keys: "esc", label: "Cancel" },
              { keys: "?", label: "Keys" },
            ]
          : [
              { keys: "/", label: "Search" },
              { keys: "\u2191\u2193", label: "Move" },
              { keys: "y", label: "Copy" },
              { keys: "b", label: "Debrid" },
              { keys: "s", label: "Sort" },
              { keys: "t/z/x/c/f", label: "Filter" },
              tabHint,
              { keys: "?", label: "Keys" },
            ];

  return (
    <StoreContext.Provider value={store}>
      <DownloadProvider
        manager={manager}
        downloadLocally={downloadLocally}
        cancelDownload={cancelDownload}
        openDownload={openDownload}
        dismissDownload={dismissDownload}
      >
      <Box flexDirection="column" paddingX={1} height={rows}>
        <Box justifyContent="space-between">
          <Logo />
          {notice ? <Text color={COLOR.good}>{notice}</Text> : null}
        </Box>

        {accountsOpen ? (
          <Box marginTop={1}>
            <Accounts active />
          </Box>
        ) : showHelp ? (
          <Box marginTop={1}>
            <HelpOverlay />
          </Box>
        ) : (
          <>
            <Box marginTop={1}>
              <SearchBar
                value={query}
                active={editing && view === "search"}
                onChange={setQuery}
                onSubmit={submitQuery}
                onCancel={() => setEditing(false)}
                width={Math.max(24, Math.min(cols - 2, 80))}
              />
            </Box>

            <Box marginTop={1}>
              <Tabs />
            </Box>

            <Box marginTop={1} flexGrow={1}>
              <Discover
                active={view === "trending" && !editing}
                visible={view === "trending"}
              />
              {view === "trending" ? null : view === "sources" ? (
                <Sources active={!editing} />
              ) : view === "realdebrid" ? (
                <ProviderTransfers provider="realdebrid" active={!editing} />
              ) : view === "torbox" ? (
                <ProviderTransfers provider="torbox" active={!editing} />
              ) : view === "settings" ? (
                <Settings active={!editing} onEditingChange={setSettingsEditing} />
              ) : (
                <Results active={!editing} />
              )}
            </Box>

            <Footer hints={footerHints} />
          </>
        )}
      </Box>
      </DownloadProvider>
    </StoreContext.Provider>
  );
}
