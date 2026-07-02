import { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "../store";
import { useTrending } from "../hooks/useTrending";
import { activeMirror, isEnabled } from "../../sources/registry";
import {
  TRENDING_CATEGORIES,
  filterByCategory,
} from "../../sources/trending";
import { formatBytes, formatRelative, truncate, cleanText } from "../../util/format";
import type { TorrentResult } from "../../sources/types";
import { COLOR, ICON } from "../theme";
import { Spinner } from "./Spinner";

export function Trending({ active }: { active: boolean }) {
  const store = useStore();
  const { config, registry, listRows, cols } = store;

  const enabledSources = useMemo(
    () =>
      registry.sources.filter(
        (s) => isEnabled(s, config) && config.sources[s.id]?.health?.ok !== false,
      ),
    [registry, config],
  );

  const trending = useTrending(enabledSources, (s) => activeMirror(s, config));

  const [category, setCategory] = useState(0);
  const categoryKey = TRENDING_CATEGORIES[category]!.category;
  const results = useMemo(
    () => filterByCategory(trending.results, categoryKey),
    [trending.results, categoryKey],
  );
  const totalCount = trending.results.length;

  const [cursor, setCursor] = useState(0);
  useEffect(() => setCursor(0), [category]);
  useEffect(() => {
    if (cursor >= results.length) setCursor(Math.max(0, results.length - 1));
  }, [results.length, cursor]);

  // When more than one provider is configured, `b` opens a tiny picker instead
  // of sending straight to the default provider.
  const configured = useMemo(
    () => store.debridProviders.filter((p) => p.isConfigured()),
    [store.debridProviders],
  );
  const [picker, setPicker] = useState<{ result: TorrentResult; cursor: number } | null>(
    null,
  );
  useEffect(() => {
    if (picker && configured.length < 2) setPicker(null);
  }, [picker, configured.length]);

  useInput(
    (input, key) => {
      // While the provider picker is open it captures every key.
      if (picker) {
        if (key.escape || input === "b") {
          setPicker(null);
        } else if (key.downArrow || input === "j") {
          setPicker((p) => (p ? { ...p, cursor: Math.min(configured.length - 1, p.cursor + 1) } : p));
        } else if (key.upArrow || input === "k") {
          setPicker((p) => (p ? { ...p, cursor: Math.max(0, p.cursor - 1) } : p));
        } else if (key.return) {
          const prov = configured[picker.cursor];
          if (prov) store.sendToDebrid(picker.result, prov.id);
          setPicker(null);
        } else if (/^[1-9]$/.test(input) && Number(input) <= configured.length) {
          const prov = configured[Number(input) - 1];
          if (prov) store.sendToDebrid(picker.result, prov.id);
          setPicker(null);
        }
        return;
      }

      // Category switching works even with no visible rows.
      if (key.leftArrow) return void setCategory((c) => Math.max(0, c - 1));
      if (key.rightArrow)
        return void setCategory((c) => Math.min(TRENDING_CATEGORIES.length - 1, c + 1));
      if (/^[1-9]$/.test(input)) {
        const n = Number(input) - 1;
        if (n < TRENDING_CATEGORIES.length) setCategory(n);
        return;
      }

      if (results.length === 0) return;
      if (key.downArrow || input === "j") setCursor((c) => Math.min(results.length - 1, c + 1));
      else if (key.upArrow || input === "k") setCursor((c) => Math.max(0, c - 1));
      else if (input === "g") setCursor(0);
      else if (input === "G") setCursor(results.length - 1);
      else if (input === "y" || input === "d" || input === "o" || key.return) {
        const r = results[cursor];
        if (!r) return;
        if (input === "y") store.copyMagnet({ name: r.name, magnet: r.magnet });
        else store.openMagnet({ name: r.name, magnet: r.magnet });
      } else if (input === "b") {
        const r = results[cursor];
        if (!r) return;
        if (configured.length >= 2) {
          const preferred = store.config.debrid?.preferred;
          const pre = configured.findIndex((p) => p.id === preferred);
          setPicker({ result: r, cursor: pre === -1 ? 0 : pre });
        } else {
          store.sendToDebrid(r);
        }
      }
    },
    { isActive: active },
  );

  const failed = Object.entries(trending.perSource).filter(([, st]) => st.error);
  // Two header lines (status + chips) vs Results' one, so trim one row.
  const capacity = Math.max(3, listRows - 1);
  const start = Math.max(
    0,
    Math.min(cursor - Math.floor(capacity / 2), Math.max(0, results.length - capacity)),
  );
  const visible = results.slice(start, start + capacity);
  const nameW = Math.max(20, cols - 49);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box justifyContent="space-between">
        <Box>
          {trending.loading ? (
            <Spinner label={`gathering trending ${trending.done}/${trending.total}`} />
          ) : (
            <Text color={COLOR.alt}>
              {categoryKey === "all" ? (
                <>
                  {results.length} trending result{results.length === 1 ? "" : "s"}
                </>
              ) : (
                <>
                  {results.length} of {totalCount} trending
                </>
              )}{" "}
              · {trending.total} source{trending.total === 1 ? "" : "s"}
            </Text>
          )}
        </Box>
        <Box>
          <Text color={COLOR.dim}>{"\u2190\u2192"} category</Text>
        </Box>
      </Box>

      <Box marginTop={1}>
        {TRENDING_CATEGORIES.map((chip, i) => {
          const sel = i === category;
          return (
            <Box key={chip.category} marginRight={1}>
              <Text color={sel ? COLOR.accent : COLOR.dim} bold={sel}>
                {sel ? `[${chip.label}]` : ` ${chip.label} `}
              </Text>
            </Box>
          );
        })}
      </Box>

      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        {results.length === 0 && !trending.loading ? (
          <Text color={COLOR.dim}>
            {totalCount > 0
              ? `No trending ${TRENDING_CATEGORIES[category]!.label} results right now.`
              : "No trending results. Enable more sources in the Sources tab."}
          </Text>
        ) : (
          visible.map((r, i) => {
            const idx = start + i;
            const sel = idx === cursor;
            return (
              <Box key={`${r.source}-${r.infoHash}-${idx}`}>
                <Text color={sel ? COLOR.accent : COLOR.dim}>
                  {sel ? ICON.pointer : " "}{" "}
                </Text>
                <Box width={nameW}>
                  <Text color={sel ? COLOR.text : COLOR.alt} wrap="truncate-end">
                    {truncate(cleanText(r.name), nameW)}
                  </Text>
                </Box>
                <Box width={6} justifyContent="flex-end">
                  <Text color={r.seeders > 0 ? COLOR.good : COLOR.dim}>
                    {ICON.up}
                    {r.seeders}
                  </Text>
                </Box>
                <Box width={11} justifyContent="flex-end">
                  <Text color={COLOR.alt}> {formatBytes(r.sizeBytes)}</Text>
                </Box>
                <Box width={9} justifyContent="flex-end">
                  <Text color={COLOR.dim}> {formatRelative(r.added)}</Text>
                </Box>
                <Box width={10} justifyContent="flex-end">
                  <Text color={COLOR.dim}> {truncate(r.sourceLabel ?? r.source, 9)}</Text>
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
            Send to debrid: {truncate(cleanText(picker.result.name), Math.max(20, cols - 24))}
          </Text>
          {configured.map((p, i) => {
            const sel = i === picker.cursor;
            return (
              <Box key={p.id}>
                <Text color={sel ? COLOR.accent : COLOR.dim}>
                  {sel ? ICON.pointer : " "}{" "}
                </Text>
                <Text color={sel ? COLOR.text : COLOR.alt}>
                  {i + 1}. {p.label}
                </Text>
              </Box>
            );
          })}
          <Text color={COLOR.dim}>
            {"\u2191\u2193"} select · enter send · esc cancel
          </Text>
        </Box>
      ) : null}

      {failed.length > 0 ? (
        <Box>
          <Text color={COLOR.dim}>
            {ICON.warn} {failed.length} source{failed.length === 1 ? "" : "s"} failed:{" "}
            {truncate(failed.map(([id, st]) => `${id} (${st.code})`).join(", "), cols - 24)}
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}
