import { Box, Text } from "ink";
import { useStore } from "../store";
import { TAB_ORDER, TAB_LABELS } from "../App";
import { COLOR, ICON } from "../theme";

/**
 * A discoverable tab bar showing the top-level views (Torrent Search,
 * Real-Debrid, TorBox, Sources). The active tab is highlighted; the others are
 * dim. Navigation is via the `tab` key — this bar just makes the set visible.
 */
export function Tabs() {
  const { view } = useStore();
  return (
    <Box>
      {TAB_ORDER.map((v, i) => {
        const active = v === view;
        return (
          <Box key={v} marginRight={2}>
            {i > 0 ? <Text color={COLOR.dim}>{ICON.dot} </Text> : null}
            <Text color={active ? COLOR.accent : COLOR.dim} bold={active}>
              {active ? `[ ${TAB_LABELS[v]} ]` : TAB_LABELS[v]}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
