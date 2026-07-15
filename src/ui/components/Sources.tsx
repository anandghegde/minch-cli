import { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "../store";
import { isEnabled } from "../../sources/registry";
import { formatLatency, formatRelative, truncate } from "../../util/format";
import { COLOR, ICON } from "../theme";

type Row =
  | { kind: "source"; id: string }
  | { kind: "header"; label: string };

function statusGlyph(
  enabled: boolean,
  ok: boolean | undefined,
  requiresConfig: boolean,
): { icon: string; color: string; text: string } {
  if (requiresConfig && ok === undefined)
    return { icon: ICON.warn, color: COLOR.warn, text: "needs config" };
  if (!enabled) return { icon: ICON.dot, color: COLOR.dim, text: "disabled" };
  if (ok === true) return { icon: ICON.done, color: COLOR.good, text: "working" };
  if (ok === false) return { icon: ICON.error, color: COLOR.bad, text: "failed" };
  return { icon: ICON.pending, color: COLOR.alt, text: "untested" };
}

export function Sources({ active }: { active: boolean }) {
  const store = useStore();
  const { config, registry, listRows, cols } = store;

  // Build display rows: working/enabled first, then failed, then disabled.
  const rows = useMemo<Row[]>(() => {
    const working: string[] = [];
    const unavailable: string[] = [];
    const disabled: string[] = [];
    for (const s of registry.sources) {
      const enabled = isEnabled(s, config);
      const ok = config.sources[s.id]?.health?.ok;
      if (!enabled) disabled.push(s.id);
      else if (ok === false) unavailable.push(s.id);
      else working.push(s.id);
    }
    const out: Row[] = [];
    if (working.length) {
      out.push({ kind: "header", label: `Working (${working.length})` });
      for (const id of working) out.push({ kind: "source", id });
    }
    if (unavailable.length) {
      out.push({ kind: "header", label: `Unavailable (${unavailable.length})` });
      for (const id of unavailable) out.push({ kind: "source", id });
    }
    if (disabled.length) {
      out.push({ kind: "header", label: `Disabled (${disabled.length})` });
      for (const id of disabled) out.push({ kind: "source", id });
    }
    return out;
  }, [registry, config]);

  const selectable = rows
    .map((r, i) => (r.kind === "source" ? i : -1))
    .filter((i) => i >= 0);
  const [cursor, setCursor] = useState(selectable[0] ?? 0);

  const moveCursor = (dir: 1 | -1): void => {
    const pos = selectable.indexOf(cursor);
    const next = selectable[Math.max(0, Math.min(selectable.length - 1, pos + dir))];
    if (next !== undefined) setCursor(next);
  };

  const currentRow = rows[cursor];
  const currentId = currentRow?.kind === "source" ? currentRow.id : undefined;
  const currentSource = currentId ? registry.byId.get(currentId) : undefined;

  useInput(
    (input, key) => {
      if (key.downArrow || input === "j") moveCursor(1);
      else if (key.upArrow || input === "k") moveCursor(-1);
      else if (input === "e" || input === " ") {
        if (currentId) store.toggleSource(currentId);
      } else if (input === "t") {
        if (currentId) store.retestSource(currentId);
      } else if (input === "T") {
        store.retestAll();
      } else if ((input === "m" || key.return) && currentSource && currentSource.links.length > 1) {
        // Cycle to the next mirror and retest it.
        const cur = config.sources[currentSource.id]?.mirror ?? currentSource.links[0]!;
        const idx = currentSource.links.indexOf(cur);
        const next = currentSource.links[(idx + 1) % currentSource.links.length]!;
        store.setMirror(currentSource.id, next);
        store.retestSource(currentSource.id, next);
      }
    },
    { isActive: active },
  );

  const start = Math.max(
    0,
    Math.min(cursor - Math.floor(listRows / 2), Math.max(0, rows.length - listRows)),
  );
  const visible = rows.slice(start, start + listRows);
  const nameW = Math.max(16, Math.min(28, cols - 52));

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box justifyContent="space-between">
        <Text color={COLOR.alt}>{registry.sources.length} known sources</Text>
        <Text color={COLOR.dim}>
          e enable · t retest · T retest all · m switch mirror
        </Text>
      </Box>

      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        {visible.map((row, i) => {
          const idx = start + i;
          if (row.kind === "header") {
            return (
              <Box key={`h-${row.label}`} marginTop={idx === 0 ? 0 : 1}>
                <Text color={COLOR.accent} bold>
                  {row.label}
                </Text>
              </Box>
            );
          }
          const s = registry.byId.get(row.id);
          if (!s) return null;
          const enabled = isEnabled(s, config);
          const health = config.sources[s.id]?.health;
          const mirror = config.sources[s.id]?.mirror ?? s.links[0]!;
          const g = statusGlyph(enabled, health?.ok, s.requiresConfig);
          const sel = idx === cursor;
          return (
            <Box key={row.id} width={cols}>
              <Text color={sel ? COLOR.accent : COLOR.dim} backgroundColor={sel ? COLOR.selected : undefined}>
                {sel ? ICON.pointer : " "}{" "}
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
                  {truncate(s.label, nameW).padEnd(nameW)}
                </Text>
              </Box>
              <Box width={9}>
                <Text color={sel ? COLOR.text : COLOR.dim} backgroundColor={sel ? COLOR.selected : undefined}>
                  {s.kind.padEnd(9)}
                </Text>
              </Box>
              <Box width={12}>
                <Text color={sel ? COLOR.text : g.color} backgroundColor={sel ? COLOR.selected : undefined}>
                  {g.text.padEnd(12)}
                </Text>
              </Box>
              <Box width={8} justifyContent="flex-end">
                <Text color={sel ? COLOR.text : COLOR.dim} backgroundColor={sel ? COLOR.selected : undefined}>
                  {(health?.latency != null ? formatLatency(health.latency) : "").padStart(8)}
                </Text>
              </Box>
              {s.links.length > 1 ? (
                <Text color={sel ? COLOR.text : COLOR.dim} backgroundColor={sel ? COLOR.selected : undefined}>
                  {` [${s.links.indexOf(mirror) + 1}/${s.links.length}]`}
                </Text>
              ) : null}
            </Box>
          );
        })}
      </Box>

      {currentSource ? (
        <Box flexDirection="column">
          <Text color={COLOR.dim}>
            {ICON.dot} {truncate(config.sources[currentSource.id]?.mirror ?? currentSource.links[0]!, cols - 6)}
          </Text>
          {config.sources[currentSource.id]?.health?.status ? (
            <Text color={COLOR.dim}>
              {ICON.dot}{" "}
              {truncate(
                String(config.sources[currentSource.id]?.health?.status),
                cols - 14,
              )}
              {config.sources[currentSource.id]?.health?.testedAt
                ? ` · ${formatRelative(
                    Math.floor(
                      (config.sources[currentSource.id]!.health!.testedAt as number) / 1000,
                    ),
                  )}`
                : ""}
            </Text>
          ) : null}
        </Box>
      ) : null}
    </Box>
  );
}
