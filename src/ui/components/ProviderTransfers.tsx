import { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "../store";
import { useDownloadStore } from "../download-store";
import { formatBytes, formatRelative, truncate, cleanText } from "../../util/format";
import type { DebridId, Transfer, TransferFile, TransferStatus } from "../../debrid/types";
import { PROVIDER_LABELS } from "../../debrid/types";
import type { DownloadEntry, DownloadStatus } from "../../download/manager";
import { COLOR, ICON } from "../theme";
import { Spinner } from "./Spinner";

function statusGlyph(status: TransferStatus): { icon: string; color: string; label: string } {
  switch (status) {
    case "downloading":
      return { icon: ICON.down, color: COLOR.accent, label: "downloading" };
    case "seeding":
      return { icon: ICON.up, color: COLOR.good, label: "seeding" };
    case "done":
      return { icon: ICON.done, color: COLOR.good, label: "done" };
    case "error":
      return { icon: ICON.error, color: COLOR.bad, label: "error" };
    case "needs_selection":
      return { icon: ICON.warn, color: COLOR.warn, label: "select files" };
    default:
      return { icon: ICON.pending, color: COLOR.warn, label: "queued" };
  }
}

function progressBar(progress: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round(progress * width)));
  return "\u2588".repeat(filled) + "\u00b7".repeat(width - filled);
}

function formatSpeed(bps?: number): string {
  if (!bps || bps <= 0) return "";
  return `${formatBytes(bps)}/s`;
}

function formatEta(seconds?: number): string {
  if (!seconds || seconds <= 0 || !Number.isFinite(seconds)) return "";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60 ? ` ${m % 60}m` : ""}`;
  return `${Math.floor(h / 24)}d`;
}

/** A transfer is downloadable once the provider holds the finished files. */
function isFinished(t: Transfer): boolean {
  return t.status === "done" || t.status === "seeding" || t.progress >= 0.999;
}

function downloadGlyph(status: DownloadStatus): { icon: string; color: string } {
  switch (status) {
    case "active":
      return { icon: ICON.down, color: COLOR.accent };
    case "done":
      return { icon: ICON.done, color: COLOR.good };
    case "error":
      return { icon: ICON.error, color: COLOR.bad };
    case "canceled":
      return { icon: ICON.warn, color: COLOR.dim };
    default:
      return { icon: ICON.pending, color: COLOR.warn };
  }
}

function DownloadRow({ d, width }: { d: DownloadEntry; width: number }) {
  const g = downloadGlyph(d.status);
  const nameW = Math.max(12, width - 52);
  const p = d.progress;
  const hasTotal = p.totalBytes !== undefined && p.totalBytes > 0;
  const pct = hasTotal ? Math.min(1, p.receivedBytes / (p.totalBytes ?? 1)) : 0;
  const pair = hasTotal
    ? `${formatBytes(p.receivedBytes)}/${formatBytes(p.totalBytes)}`
    : formatBytes(p.receivedBytes);

  return (
    <Box>
      <Text color={g.color}>{g.icon} </Text>
      <Box width={nameW}>
        <Text color={COLOR.alt} wrap="truncate-end">
          {truncate(cleanText(d.name), nameW)}
        </Text>
      </Box>
      {d.status === "active" || d.status === "queued" ? (
        <>
          <Box width={13}>
            <Text color={COLOR.accent}>
              {hasTotal ? `${progressBar(pct, 7)} ${Math.round(pct * 100)}%` : "\u2026 working"}
            </Text>
          </Box>
          <Box width={16} justifyContent="flex-end">
            <Text color={COLOR.alt}>{pair}</Text>
          </Box>
          <Box width={11} justifyContent="flex-end">
            <Text color={COLOR.alt}>{formatSpeed(p.speedBps)}</Text>
          </Box>
          <Box width={6} justifyContent="flex-end">
            <Text color={COLOR.dim}>{formatEta(p.etaSeconds)}</Text>
          </Box>
          <Box width={5} justifyContent="flex-end">
            <Text color={COLOR.dim}>{p.connections > 0 ? `${p.connections}c` : ""}</Text>
          </Box>
        </>
      ) : d.status === "done" ? (
        <Text color={COLOR.good}>saved {ICON.dot} o to open</Text>
      ) : d.status === "error" ? (
        <Text color={COLOR.bad} wrap="truncate-end">
          {truncate(d.error ?? "error", Math.max(10, width - nameW - 6))}
        </Text>
      ) : (
        <Text color={COLOR.dim}>canceled {ICON.dot} l to resume</Text>
      )}
    </Box>
  );
}

interface FilePicker {
  transfer: Transfer;
  cursor: number;
  action: "download" | "copy";
}

/**
 * Transfers for a single debrid provider. Mounted per-view (one instance for
 * Real-Debrid, one for TorBox), so its cursor/picker state is naturally scoped.
 * Reads the shared, merged poll from the store and filters to `provider`.
 */
export function ProviderTransfers({
  provider,
  active,
}: {
  provider: DebridId;
  active: boolean;
}) {
  const store = useStore();
  const downloadStore = useDownloadStore();
  const { transfersLoading, transfersUpdatedAt, listRows, cols } = store;
  const { downloads } = downloadStore;

  const label = PROVIDER_LABELS[provider];
  const configured = store.providerConfigured(provider);
  const error = store.transfersError[provider] ?? null;
  const transfers = useMemo(() => store.transfersFor(provider), [store, provider]);

  // Only this provider's downloads (matched by the transfer ids we hold).
  const providerDownloads = useMemo(() => {
    const ids = new Set(transfers.map((t) => t.id));
    return downloads.filter((d) => ids.has(d.transferId));
  }, [downloads, transfers]);

  const [cursor, setCursor] = useState(0);
  const [picker, setPicker] = useState<FilePicker | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [fileCursor, setFileCursor] = useState(0);
  useEffect(() => {
    if (cursor >= transfers.length) setCursor(Math.max(0, transfers.length - 1));
  }, [transfers.length, cursor]);

  const current: Transfer | undefined = transfers[cursor];
  const expanded = current?.id === expandedId ? current : undefined;
  const expandedFile = expanded?.files[fileCursor];

  useEffect(() => {
    if (expanded && fileCursor >= expanded.files.length) {
      setFileCursor(Math.max(0, expanded.files.length - 1));
    }
  }, [expanded, fileCursor]);

  // Pick the file(s) for a download: auto for single-file, picker for multi.
  const startDownload = (t: Transfer): void => {
    if (!isFinished(t)) {
      store.setNotice("Transfer isn't finished yet.");
      return;
    }
    if (t.files.length > 1) {
      setPicker({ transfer: t, cursor: 0, action: "download" });
      return;
    }
    downloadStore.downloadLocally(t, t.files[0]);
  };

  useInput(
    (input, key) => {
      // The multi-file picker captures keys while open. Entry 0 = "download all".
      if (picker) {
        const hasAll = picker.action === "download";
        const options = picker.transfer.files.length + (hasAll ? 1 : 0);
        if (key.escape || input === "l") {
          setPicker(null);
        } else if (key.downArrow || input === "j") {
          setPicker((p) => (p ? { ...p, cursor: Math.min(options - 1, p.cursor + 1) } : p));
        } else if (key.upArrow || input === "k") {
          setPicker((p) => (p ? { ...p, cursor: Math.max(0, p.cursor - 1) } : p));
        } else if (key.return) {
          if (hasAll && picker.cursor === 0) {
            for (const f of picker.transfer.files) downloadStore.downloadLocally(picker.transfer, f);
          } else {
            const f = picker.transfer.files[picker.cursor - (hasAll ? 1 : 0)];
            if (f) {
              if (picker.action === "copy") downloadStore.copyDownloadLink(picker.transfer, f);
              else downloadStore.downloadLocally(picker.transfer, f);
            }
          }
          setPicker(null);
        }
        return;
      }

      if (input === "r") return void store.refreshTransfers();
      if (input === "a") return void store.openAccounts();

      if (input === "c") {
        const forCurrent = providerDownloads.find(
          (d) =>
            (d.status === "active" || d.status === "queued") &&
            (!current || d.transferId === current.id),
        );
        const fallback = providerDownloads.find(
          (d) => d.status === "active" || d.status === "queued",
        );
        const target = forCurrent ?? fallback;
        if (target) downloadStore.cancelDownload(target.id);
        else store.setNotice("No active download to cancel.");
        return;
      }
      if (input === "o") {
        const doneForCurrent = current
          ? providerDownloads.find((d) => d.status === "done" && d.transferId === current.id)
          : undefined;
        const target = doneForCurrent ?? providerDownloads.find((d) => d.status === "done");
        if (target) downloadStore.openDownload(target);
        else store.setNotice("No finished download to open.");
        return;
      }

      if (expanded) {
        if (key.escape || input === "h" || key.leftArrow || input === "e" || key.rightArrow) {
          setExpandedId(null);
          return;
        }
        if (key.downArrow || input === "j") {
          setFileCursor((c) => Math.min(expanded.files.length - 1, c + 1));
          return;
        }
        if (key.upArrow || input === "k") {
          setFileCursor((c) => Math.max(0, c - 1));
          return;
        }
        if (input === "l" || key.return) {
          if (expandedFile) downloadStore.downloadLocally(expanded, expandedFile);
          else store.setNotice("No file is available for this transfer.");
          return;
        }
        if (input === "y") {
          if (expandedFile) downloadStore.copyDownloadLink(expanded, expandedFile);
          else store.setNotice("No file is available for this transfer.");
          return;
        }
      }

      if (transfers.length === 0) return;
      if (key.downArrow || input === "j") setCursor((c) => Math.min(transfers.length - 1, c + 1));
      else if (key.upArrow || input === "k") setCursor((c) => Math.max(0, c - 1));
      else if (input === "g") setCursor(0);
      else if (input === "G") setCursor(transfers.length - 1);
      else if (input === "e" || key.rightArrow) {
        if (current?.files.length) {
          setExpandedId(current.id);
          setFileCursor(0);
        } else {
          store.setNotice("No files are available for this transfer.");
        }
      }
      else if (input === "l" || key.return) {
        if (current) startDownload(current);
      } else if (input === "y") {
        if (!current || !isFinished(current)) {
          store.setNotice("Transfer isn't finished yet.");
        } else if (current.files.length > 1) {
          setPicker({ transfer: current, cursor: 0, action: "copy" });
        } else if (current.files[0]) {
          downloadStore.copyDownloadLink(current, current.files[0]);
        } else {
          store.setNotice("No file is available for this transfer.");
        }
      } else if (input === "x") {
        if (current) store.removeTransfer(current);
      }
    },
    { isActive: active },
  );

  // Reserve rows for the downloads panel + picker so nothing overflows.
  const shownDownloads = useMemo(() => providerDownloads.slice(0, 5), [providerDownloads]);
  const dlRows = shownDownloads.length ? shownDownloads.length + 1 : 0;
  const pickerRows = picker ? Math.min(picker.transfer.files.length + 1, 8) + 2 : 0;
  const expandedRows = expanded ? expanded.files.length + 1 : 0;
  const effRows = Math.max(3, listRows - dlRows - pickerRows - expandedRows);

  const start = Math.max(
    0,
    Math.min(cursor - Math.floor(effRows / 2), Math.max(0, transfers.length - effRows)),
  );
  const visible = transfers.slice(start, start + effRows);
  // No per-row provider badge in a single-provider view: reclaim the width.
  const nameW = Math.max(14, cols - 46);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box justifyContent="space-between">
        <Box>
          {transfersLoading && transfers.length === 0 && configured ? (
            <Spinner label={`loading ${label} transfers`} />
          ) : !configured ? (
            <Text color={COLOR.alt}>{label}</Text>
          ) : (
            <Text color={COLOR.alt}>
              {label} {ICON.dot} {transfers.length} transfer{transfers.length === 1 ? "" : "s"}
              {transfersUpdatedAt
                ? ` · updated ${formatRelative(Math.floor(transfersUpdatedAt / 1000))}`
                : ""}
            </Text>
          )}
        </Box>
      <Text color={COLOR.dim}>e expand · l download · y copy link · c cancel · o open · x remove</Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        {!configured ? (
          <Text color={COLOR.dim}>
            {label} isn't configured. Press <Text color={COLOR.accent}>a</Text> to add a key in
            Accounts.
          </Text>
        ) : transfers.length === 0 && !transfersLoading ? (
          <Text color={COLOR.dim}>
            No {label} transfers yet. Press <Text color={COLOR.accent}>b</Text> on a search result
            to send one here.
          </Text>
        ) : (
          visible.map((t, i) => {
            const idx = start + i;
            const sel = idx === cursor;
            const g = statusGlyph(t.status);
            const busy = providerDownloads.some(
              (d) => d.transferId === t.id && (d.status === "active" || d.status === "queued"),
            );
             return (
               <Box key={`${t.provider}-${t.id}`} flexDirection="column">
                  <Box width={cols}>
                    <Text color={sel ? COLOR.accent : COLOR.dim} backgroundColor={sel ? COLOR.selected : undefined}>
                      {sel ? ICON.pointer : " "} 
                    </Text>
                    <Text color={sel ? COLOR.text : g.color} backgroundColor={sel ? COLOR.selected : undefined}>
                      {g.icon} 
                    </Text>
                   <Box width={nameW}>
                     <Text
                       color={sel ? COLOR.text : COLOR.alt}
                       backgroundColor={sel ? COLOR.selected : undefined}
                       wrap="truncate-end"
                     >
                       {truncate(
                         `${expandedId === t.id ? `${ICON.down} ` : busy ? `${ICON.down} ` : ""}${cleanText(t.name)}`,
                         nameW,
                       ).padEnd(nameW)}
                     </Text>
                   </Box>
                   <Box width={13}>
                      {t.status === "done" ? (
                        <Text color={sel ? COLOR.text : COLOR.good} backgroundColor={sel ? COLOR.selected : undefined}>
                          {g.label.padEnd(13)}
                        </Text>
                      ) : t.status === "error" ? (
                        <Text color={sel ? COLOR.text : COLOR.bad} backgroundColor={sel ? COLOR.selected : undefined}>
                          {g.label.padEnd(13)}
                        </Text>
                      ) : (
                        <Text color={sel ? COLOR.text : g.color} backgroundColor={sel ? COLOR.selected : undefined}>
                          {`${progressBar(t.progress, 7)} ${Math.round(t.progress * 100)}%`.padEnd(13)}
                        </Text>
                     )}
                    </Box>
                    <Box width={11} justifyContent="flex-end">
                      <Text color={sel ? COLOR.text : COLOR.alt} backgroundColor={sel ? COLOR.selected : undefined}>
                        {formatSpeed(t.downloadSpeedBps).padStart(11)}
                      </Text>
                    </Box>
                    <Box width={6} justifyContent="flex-end">
                      <Text color={sel ? COLOR.text : COLOR.dim} backgroundColor={sel ? COLOR.selected : undefined}>
                        {formatEta(t.etaSeconds).padStart(6)}
                      </Text>
                    </Box>
                    <Box width={11} justifyContent="flex-end">
                      <Text color={sel ? COLOR.text : COLOR.alt} backgroundColor={sel ? COLOR.selected : undefined}>
                        {formatBytes(t.sizeBytes).padStart(11)}
                      </Text>
                    </Box>
                 </Box>
                 {expandedId === t.id ? (
                   t.files.map((file, fileIndex) => (
                     <Box key={`${t.id}-${file.id}`} marginLeft={4}>
                       <Text color={fileIndex === fileCursor ? COLOR.accent : COLOR.dim}>
                         {fileIndex === fileCursor ? ICON.pointer : " "} 
                       </Text>
                       <Box width={Math.max(20, nameW - 5)}>
                         <Text color={fileIndex === fileCursor ? COLOR.text : COLOR.alt} wrap="truncate-end">
                           {truncate(cleanText(file.name), Math.max(20, nameW - 5))}
                         </Text>
                       </Box>
                       <Text color={COLOR.dim}> {formatBytes(file.sizeBytes)}</Text>
                     </Box>
                   ))
                 ) : null}
               </Box>
             );
          })
        )}
      </Box>

      {picker ? (
        <Box
          marginTop={1}
          borderStyle="round"
          borderColor={COLOR.accent}
          paddingX={1}
          flexDirection="column"
        >
          <Text color={COLOR.accent}>
            {picker.action === "copy" ? "Copy link from" : "Download from"} {truncate(cleanText(picker.transfer.name), Math.max(20, cols - 28))}
          </Text>
          {(picker.action === "download"
            ? [{ id: "*", name: `Download all (${picker.transfer.files.length} files)`, sizeBytes: 0, selected: true } as TransferFile, ...picker.transfer.files]
            : picker.transfer.files)
            .slice(0, 8)
            .map((f, i) => {
              const sel = i === picker.cursor;
              return (
                <Box key={f.id === "*" ? "*" : `${f.id}-${i}`}>
                  <Text color={sel ? COLOR.accent : COLOR.dim}>{sel ? ICON.pointer : " "} </Text>
                  <Box width={Math.max(20, cols - 24)}>
                    <Text color={sel ? COLOR.text : COLOR.alt} wrap="truncate-end">
                      {truncate(cleanText(f.name), Math.max(20, cols - 24))}
                    </Text>
                  </Box>
                  {f.id !== "*" ? (
                    <Text color={COLOR.dim}> {formatBytes(f.sizeBytes)}</Text>
                  ) : null}
                </Box>
              );
            })}
          <Text color={COLOR.dim}>{"\u2191\u2193"} select · enter {picker.action === "copy" ? "copy link" : "download"} · esc cancel</Text>
        </Box>
      ) : null}

      {shownDownloads.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={COLOR.dim}>
            Downloads → {truncate(store.config.debrid?.downloadDir ?? "OS Downloads folder", cols - 14)}
          </Text>
          {shownDownloads.map((d) => (
            <DownloadRow key={d.id} d={d} width={cols} />
          ))}
        </Box>
      ) : current ? (
        <Box>
          <Text color={COLOR.dim}>
            {ICON.dot} {statusGlyph(current.status).label}
            {current.hash ? ` · ${current.hash.slice(0, 12)}` : ""}
            {current.files.length ? ` · ${current.files.length} file${current.files.length === 1 ? "" : "s"}` : ""}
            {expanded ? " · ↑↓ select file · l download · y copy · e close" : ""}
          </Text>
        </Box>
      ) : null}

      {error ? (
        <Box>
          <Text color={COLOR.dim}>
            {ICON.warn} {truncate(`${label}: ${error}`, cols - 4)}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
