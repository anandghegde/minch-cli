import { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { useStore } from "../store";
import { useConcurrentSearch } from "../hooks/useConcurrentSearch";
import { activeMirror, isEnabled } from "../../sources/registry";
import { sortResults, sortLabel } from "../../sources/search";
import { applyFilters, filterSummary } from "../../sources/filters";
import { formatBytes, truncate, cleanText } from "../../util/format";
import type { TorrentResult } from "../../sources/types";
import { COLOR, ICON } from "../theme";
import { Spinner } from "./Spinner";

export function Results({ active }: { active: boolean }) {
  const store = useStore();
  const { config, registry, sort, filters, submittedQuery, listRows, cols } = store;

  const enabledSources = useMemo(
    () =>
      registry.sources.filter(
        (s) => isEnabled(s, config) && config.sources[s.id]?.health?.ok !== false,
      ),
    [registry, config],
  );

  const search = useConcurrentSearch(submittedQuery, enabledSources, (s) =>
    activeMirror(s, config),
  );

  // Filter first, then sort, over the deduped/streamed result set.
  const filtered = useMemo(
    () => applyFilters(search.results, filters),
    [search.results, filters],
  );
  const results = useMemo(
    () => (sort === "default" ? filtered : sortResults(filtered, sort)),
    [filtered, sort],
  );
  const totalCount = search.results.length;
  const filterActive = store.activeFilterCount > 0;

  const [cursor, setCursor] = useState(0);
  useEffect(() => setCursor(0), [submittedQuery]);
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
  // A picker is only meaningful while the providers it lists stay configured.
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

      // Filter/sort cycle keys work even with no visible rows, so the user can
      // always relax filters that hid everything.
      if (input === "s") return void store.cycleSort();
      if (input === "t") return void store.cycleTimeFilter();
      if (input === "z") return void store.cycleSizeFilter();
      if (input === "x") return void store.cycleSeederFilter();
      if (input === "r") return void store.resetFilters();
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
          // Pre-select the preferred provider when one is set.
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

  const failed = Object.entries(search.perSource).filter(([, st]) => st.error);
  const start = Math.max(0, Math.min(cursor - Math.floor(listRows / 2), Math.max(0, results.length - listRows)));
  const visible = results.slice(start, start + listRows);
  const nameW = Math.max(20, cols - 40);

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box justifyContent="space-between">
        <Box>
          {search.loading ? (
            <Spinner label={`searching ${search.done}/${search.total}`} />
          ) : (
            <Text color={COLOR.alt}>
              {filterActive ? (
                <>
                  {results.length} of {totalCount} result{totalCount === 1 ? "" : "s"}
                </>
              ) : (
                <>
                  {results.length} result{results.length === 1 ? "" : "s"}
                </>
              )}{" "}
              · {search.total} source{search.total === 1 ? "" : "s"}
            </Text>
          )}
        </Box>
        <Box>
          {filterActive ? (
            <Text color={COLOR.dim}>
              filter: <Text color={COLOR.warn}>{filterSummary(filters)}</Text>
              {"   "}
            </Text>
          ) : null}
          <Text color={COLOR.dim}>sort: {sortLabel(sort)}</Text>
        </Box>
      </Box>

      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        {!submittedQuery ? (
          <Text color={COLOR.dim}>Type a query and press enter to search.</Text>
        ) : results.length === 0 && !search.loading ? (
          <Text color={COLOR.dim}>
            {filterActive && totalCount > 0
              ? `No results match the active filters (${totalCount} hidden). Press r to reset.`
              : "No results."}
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
