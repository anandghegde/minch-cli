import { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "../store";
import { formatBytes, formatRelative, truncate, cleanText } from "../../util/format";
import type { Transfer, TransferFile, TransferStatus } from "../../debrid/types";
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
}

export function Transfers({ active }: { active: boolean }) {
  const store = useStore();
  const {
    transfers,
    transfersLoading,
    transfersError,
    transfersUpdatedAt,
    downloads,
    listRows,
    cols,
  } = store;

  const [cursor, setCursor] = useState(0);
  const [picker, setPicker] = useState<FilePicker | null>(null);
  useEffect(() => {
    if (cursor >= transfers.length) setCursor(Math.max(0, transfers.length - 1));
  }, [transfers.length, cursor]);

  const current: Transfer | undefined = transfers[cursor];

  // Pick the file(s) for a download: auto for single-file, picker for multi.
  const startDownload = (t: Transfer): void => {
    if (!isFinished(t)) {
      store.setNotice("Transfer isn't finished yet.");
      return;
    }
    if (t.files.length > 1) {
      setPicker({ transfer: t, cursor: 0 });
      return;
    }
    store.downloadLocally(t, t.files[0]);
  };

  useInput(
    (input, key) => {
      // The multi-file picker captures keys while open. Entry 0 = "download all".
      if (picker) {
        const options = picker.transfer.files.length + 1;
        if (key.escape || input === "l") {
          setPicker(null);
        } else if (key.downArrow || input === "j") {
          setPicker((p) => (p ? { ...p, cursor: Math.min(options - 1, p.cursor + 1) } : p));
        } else if (key.upArrow || input === "k") {
          setPicker((p) => (p ? { ...p, cursor: Math.max(0, p.cursor - 1) } : p));
        } else if (key.return) {
          if (picker.cursor === 0) {
            for (const f of picker.transfer.files) store.downloadLocally(picker.transfer, f);
          } else {
            const f = picker.transfer.files[picker.cursor - 1];
            if (f) store.downloadLocally(picker.transfer, f);
          }
          setPicker(null);
        }
        return;
      }

      if (input === "r") return void store.refreshTransfers();
      if (input === "a") return void store.openAccounts();

      if (input === "c") {
        const forCurrent = downloads.find(
          (d) =>
            (d.status === "active" || d.status === "queued") &&
            (!current || d.transferId === current.id),
        );
        const fallback = downloads.find((d) => d.status === "active" || d.status === "queued");
        const target = forCurrent ?? fallback;
        if (target) store.cancelDownload(target.id);
        else store.setNotice("No active download to cancel.");
        return;
      }
      if (input === "o") {
        const doneForCurrent = current
          ? downloads.find((d) => d.status === "done" && d.transferId === current.id)
          : undefined;
        const target = doneForCurrent ?? downloads.find((d) => d.status === "done");
        if (target) store.openDownload(target);
        else store.setNotice("No finished download to open.");
        return;
      }

      if (transfers.length === 0) return;
      if (key.downArrow || input === "j") setCursor((c) => Math.min(transfers.length - 1, c + 1));
      else if (key.upArrow || input === "k") setCursor((c) => Math.max(0, c - 1));
      else if (input === "g") setCursor(0);
      else if (input === "G") setCursor(transfers.length - 1);
      else if (input === "l" || key.return) {
        if (current) startDownload(current);
      } else if (input === "x") {
        if (current) store.removeTransfer(current);
      }
    },
    { isActive: active },
  );

  const errors = Object.entries(transfersError).filter(([, e]) => e);

  // Reserve rows for the downloads panel + picker so nothing overflows.
  const shownDownloads = useMemo(() => downloads.slice(0, 5), [downloads]);
  const dlRows = shownDownloads.length ? shownDownloads.length + 1 : 0;
  const pickerRows = picker ? Math.min(picker.transfer.files.length + 1, 8) + 2 : 0;
  const effRows = Math.max(3, listRows - dlRows - pickerRows);

  const start = Math.max(
    0,
    Math.min(cursor - Math.floor(effRows / 2), Math.max(0, transfers.length - effRows)),
  );
  const visible = transfers.slice(start, start + effRows);
  const nameW = Math.max(14, cols - 54);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box justifyContent="space-between">
        <Box>
          {transfersLoading && transfers.length === 0 ? (
            <Spinner label="loading transfers" />
          ) : (
            <Text color={COLOR.alt}>
              {transfers.length} transfer{transfers.length === 1 ? "" : "s"}
              {transfersUpdatedAt
                ? ` · updated ${formatRelative(Math.floor(transfersUpdatedAt / 1000))}`
                : ""}
            </Text>
          )}
        </Box>
        <Text color={COLOR.dim}>l download · c cancel · o open · x remove</Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        {!store.anyDebridConfigured ? (
          <Text color={COLOR.dim}>
            No debrid provider configured. Press <Text color={COLOR.accent}>a</Text> to add a
            TorBox or Real Debrid key in Accounts.
          </Text>
        ) : transfers.length === 0 && !transfersLoading ? (
          <Text color={COLOR.dim}>
            No transfers yet. Press <Text color={COLOR.accent}>b</Text> on a search result to send
            one to debrid.
          </Text>
        ) : (
          visible.map((t, i) => {
            const idx = start + i;
            const sel = idx === cursor;
            const g = statusGlyph(t.status);
            const badge = PROVIDER_LABELS[t.provider] ?? t.provider;
            const busy = downloads.some(
              (d) => d.transferId === t.id && (d.status === "active" || d.status === "queued"),
            );
            return (
              <Box key={`${t.provider}-${t.id}`}>
                <Text color={sel ? COLOR.accent : COLOR.dim}>{sel ? ICON.pointer : " "} </Text>
                <Text color={g.color}>{g.icon} </Text>
                <Box width={nameW}>
                  <Text color={sel ? COLOR.text : COLOR.alt} wrap="truncate-end">
                    {busy ? `${ICON.down} ` : ""}
                    {truncate(cleanText(t.name), nameW)}
                  </Text>
                </Box>
                <Box width={8}>
                  <Text color={COLOR.dim}> {truncate(badge, 7)}</Text>
                </Box>
                <Box width={13}>
                  {t.status === "done" ? (
                    <Text color={COLOR.good}>{g.label}</Text>
                  ) : t.status === "error" ? (
                    <Text color={COLOR.bad}>{g.label}</Text>
                  ) : (
                    <Text color={g.color}>
                      {progressBar(t.progress, 7)} {Math.round(t.progress * 100)}%
                    </Text>
                  )}
                </Box>
                <Box width={11} justifyContent="flex-end">
                  <Text color={COLOR.alt}>{formatSpeed(t.downloadSpeedBps)}</Text>
                </Box>
                <Box width={6} justifyContent="flex-end">
                  <Text color={COLOR.dim}>{formatEta(t.etaSeconds)}</Text>
                </Box>
                <Box width={11} justifyContent="flex-end">
                  <Text color={COLOR.alt}> {formatBytes(t.sizeBytes)}</Text>
                </Box>
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
            Download from {truncate(cleanText(picker.transfer.name), Math.max(20, cols - 28))}
          </Text>
          {[{ id: "*", name: `Download all (${picker.transfer.files.length} files)`, sizeBytes: 0, selected: true } as TransferFile, ...picker.transfer.files]
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
          <Text color={COLOR.dim}>{"\u2191\u2193"} select · enter download · esc cancel</Text>
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
          </Text>
        </Box>
      ) : null}

      {errors.length > 0 ? (
        <Box>
          <Text color={COLOR.dim}>
            {ICON.warn}{" "}
            {truncate(
              errors.map(([id, e]) => `${PROVIDER_LABELS[id as keyof typeof PROVIDER_LABELS] ?? id}: ${e}`).join("  ·  "),
              cols - 4,
            )}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
