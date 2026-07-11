import { Box, Text } from "ink";
import { useStore } from "../store";
import { TAB_ORDER, TAB_LABELS } from "../App";
import { COLOR, ICON } from "../theme";

/**
 * A discoverable tab bar showing the top-level views (Torrent Search,
 * Discover, Real-Debrid, TorBox, Sources). The active tab is highlighted; the others are
 * dim. Navigation is via the `tab` key — this bar just makes the set visible.
 */
export function Tabs() {
  const { view, cols } = useStore();
  const compact = cols < 80;
  const compactLabels: Partial<Record<keyof typeof TAB_LABELS, string>> = {
    search: "Search",
    trending: "Disc",
    realdebrid: "RD",
    torbox: "TB",
    sources: "Src",
    settings: "Set",
  };
  return (
    <Box>
      {TAB_ORDER.map((v, i) => {
        const active = v === view;
        const label = compact ? compactLabels[v] ?? TAB_LABELS[v] : TAB_LABELS[v];
        return (
          <Box key={v} marginRight={compact ? 1 : 2}>
            {i > 0 ? <Text color={COLOR.dim}>{ICON.dot} </Text> : null}
            <Text color={active ? COLOR.accent : COLOR.dim} bold={active}>
              {active ? `[ ${label} ]` : label}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
