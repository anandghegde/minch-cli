import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdin, useStdout } from "ink";
import { loadConfig, saveConfig, type Config } from "../config/config";
import { buildRegistry, isEnabled, activeMirror, type Registry } from "../sources/registry";
import { probeAll, probeSource } from "../sources/health";
import { nextSort, type SortState } from "../sources/search";
import {
  emptyFilters,
  cycleTime,
  cycleSize,
  cycleSeeders,
  activeFilterCount as countFilters,
  type FilterState,
} from "../sources/filters";
import { clearCache } from "../sources/cache";
import { writeClipboard, openExternal } from "../util/clipboard";
import { fetchResilient, USER_AGENT } from "../util/net";
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
import { Transfers } from "./components/Transfers";
import { Accounts } from "./components/Accounts";
import { HelpOverlay } from "./components/HelpOverlay";
import { Spinner } from "./components/Spinner";
import { Splash, type ProbeProgress } from "./views/Splash";
import { useTransfers } from "./hooks/useTransfers";
import { useDownloads } from "./hooks/useDownloads";
import { COLOR } from "./theme";

const TAB_ORDER: View[] = ["search", "sources", "transfers"];

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

  const [config, setConfigState] = useState<Config | null>(null);
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
  const [debridAuth, setDebridAuth] = useState<Record<string, DebridAuthState>>({});
  const [progress, setProgress] = useState<ProbeProgress>({ total: 0, done: 0, ok: 0 });
  const booting = useRef(false);

  const configRef = useRef<Config | null>(null);
  configRef.current = config;

  const persist = useCallback((c: Config) => {
    setConfigState(c);
    configRef.current = c;
    void saveConfig(c);
  }, []);

  // Boot: load config, build registry, run first-run probe if needed.
  useEffect(() => {
    if (booting.current) return;
    booting.current = true;
    let alive = true;
    void (async () => {
      const cfg = await loadConfig();
      const reg = await buildRegistry(cfg);
      if (!alive) return;
      setRegistry(reg);

      if (cfg.firstRunDone) {
        setConfigState(cfg);
        configRef.current = cfg;
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
      persist(next);
      // Brief pause so the user sees the "Ready" state, then enter.
      setTimeout(() => {
        if (!alive) return;
        setView("search");
        if (initialQuery?.trim()) setSubmittedQuery(initialQuery.trim());
      }, 700);
    })();
    return () => {
      alive = false;
    };
  }, [initialQuery, persist]);

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

  const cycleSort = useCallback(() => setSort((s) => nextSort(s)), []);

  const cycleTimeFilter = useCallback(() => setFilters((f) => cycleTime(f)), []);
  const cycleSizeFilter = useCallback(() => setFilters((f) => cycleSize(f)), []);
  const cycleSeederFilter = useCallback(() => setFilters((f) => cycleSeeders(f)), []);
  const resetFilters = useCallback(() => setFilters(emptyFilters), []);
  const activeFilterCount = useMemo(() => countFilters(filters), [filters]);

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
          setView("transfers");
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
  const downloads = useDownloads(manager);

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
      setView("transfers");
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
      persist(withDebridKey(cfg, id, key));
      // Reset any stale auth result so the user re-verifies the new key.
      setDebridAuth((s) => ({ ...s, [id]: { checking: false } }));
      setNotice(key ? `Saved ${PROVIDER_LABELS[id]} key.` : `Cleared ${PROVIDER_LABELS[id]} key.`);
      refreshTransfers();
    },
    [persist, refreshTransfers],
  );

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

  const retestSource = useCallback(
    (id: string, mirror?: string) => {
      const reg = registry;
      const cfg = configRef.current;
      if (!reg || !cfg) return;
      const source = reg.byId.get(id);
      if (!source) return;
      clearCache();
      setNotice(`Testing ${source.label}…`);
      void (async () => {
        // Explicit mirror: test only that one. Otherwise let probeSource try
        // the configured mirror first, then fall back through the others.
        const base = mirror ?? activeMirror(source, cfg);
        const outcome = await probeSource(
          mirror ? { ...source, links: [mirror] } : source,
          base,
        );
        const latest = configRef.current ?? cfg;
        persist({
          ...latest,
          sources: {
            ...latest.sources,
            [id]: {
              enabled: outcome.health.ok,
              mirror: mirror ?? outcome.mirror ?? latest.sources[id]?.mirror,
              health: outcome.health,
            },
          },
        });
        setNotice(
          `${source.label}: ${outcome.health.ok ? "working" : outcome.health.code ?? "failed"}`,
        );
      })();
    },
    [registry, persist],
  );

  const retestAll = useCallback(() => {
    const reg = registry;
    const cfg = configRef.current;
    if (!reg || !cfg) return;
    clearCache();
    setNotice("Retesting all sources…");
    void (async () => {
      const targets = reg.sources.filter((s) => !s.requiresConfig);
      const updates: Config["sources"] = { ...cfg.sources };
      await probeAll(
        targets,
        (s) => activeMirror(s, cfg),
        (o) => {
          updates[o.id] = {
            enabled: o.health.ok,
            mirror: o.mirror ?? cfg.sources[o.id]?.mirror,
            health: o.health,
          };
        },
      );
      persist({ ...(configRef.current ?? cfg), sources: updates });
      setNotice("Retest complete.");
    })();
  }, [registry, persist]);

  const toggleSource = useCallback(
    (id: string) => {
      const reg = registry;
      const cfg = configRef.current;
      if (!reg || !cfg) return;
      const source = reg.byId.get(id);
      if (!source) return;
      const current = isEnabled(source, cfg);
      persist({
        ...cfg,
        sources: { ...cfg.sources, [id]: { ...cfg.sources[id], enabled: !current } },
      });
    },
    [registry, persist],
  );

  const setMirror = useCallback(
    (id: string, mirror: string) => {
      const cfg = configRef.current;
      if (!cfg) return;
      persist({
        ...cfg,
        sources: { ...cfg.sources, [id]: { ...cfg.sources[id], enabled: cfg.sources[id]?.enabled ?? true, mirror } },
      });
    },
    [persist],
  );

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const rows = size.rows;
  const cols = size.cols;
  const chrome = 6; // logo + rule + search bar + footer + margins
  const listRows = Math.max(4, rows - chrome - 2);

  const store = useMemo<Store | null>(() => {
    if (!config || !registry) return null;
    return {
      config,
      registry,
      setConfig: persist,
      view,
      setView,
      query,
      submittedQuery,
      setQuery,
      submitQuery,
      sort,
      cycleSort,
      filters,
      cycleTimeFilter,
      cycleSizeFilter,
      cycleSeederFilter,
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
      downloads,
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
      quitAll,
      cols,
      rows,
      listRows,
    };
  }, [
    config, registry, persist, view, query, submittedQuery, submitQuery, sort,
    cycleSort, notice, copyMagnet, openMagnet, retestSource, retestAll,
    toggleSource, setMirror, quitAll, cols, rows, listRows,
    filters, cycleTimeFilter, cycleSizeFilter, cycleSeederFilter, resetFilters,
    activeFilterCount,
    debridProviders, anyDebridConfigured, transfers, transfersLoading,
    transfersError, transfersUpdatedAt, sendToDebrid, refreshTransfers,
    removeTransfer, accountsOpen, openAccounts, closeAccounts, debridAuth,
    checkDebridAuth, saveDebridKey,
    downloads, downloadLocally, cancelDownload, openDownload, dismissDownload,
  ]);

  // Global input (only when not editing the search field and a store exists).
  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") {
        quitAll();
        return;
      }
      // The Accounts overlay captures every other key (including typed text).
      if (accountsOpen) return;
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
      if (input === "/") {
        setView("search");
        setEditing(true);
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

  const footerHints: Hint[] =
    view === "sources"
      ? [
          { keys: "\u2191\u2193", label: "Move" },
          { keys: "e", label: "Enable" },
          { keys: "t/T", label: "Retest" },
          { keys: "m", label: "Mirror" },
          { keys: "tab", label: "Transfers" },
          { keys: "?", label: "Keys" },
        ]
      : view === "transfers"
        ? [
            { keys: "\u2191\u2193", label: "Move" },
            { keys: "l", label: "Download" },
            { keys: "c", label: "Cancel" },
            { keys: "o", label: "Open" },
            { keys: "x", label: "Remove" },
            { keys: "?", label: "Keys" },
          ]
        : [
            { keys: "\u2191\u2193", label: "Move" },
            { keys: "y", label: "Copy" },
            { keys: "b", label: "Debrid" },
            { keys: "s", label: "Sort" },
            { keys: "t/z/x", label: "Filter" },
            { keys: "tab", label: "Sources" },
            { keys: "?", label: "Keys" },
          ];

  return (
    <StoreContext.Provider value={store}>
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
                width={Math.max(24, Math.min(cols - 2, 80))}
              />
            </Box>

            <Box marginTop={1} flexGrow={1}>
              {view === "sources" ? (
                <Sources active={!editing} />
              ) : view === "transfers" ? (
                <Transfers active={!editing} />
              ) : (
                <Results active={!editing} />
              )}
            </Box>

            <Footer hints={footerHints} />
          </>
        )}
      </Box>
    </StoreContext.Provider>
  );
}
