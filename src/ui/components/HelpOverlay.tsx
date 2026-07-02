import { Box, Text } from "ink";
import { COLOR } from "../theme";

const GROUPS: { title: string; hints: { keys: string; label: string }[] }[] = [
  {
    title: "Navigate",
    hints: [
      { keys: "\u2191 \u2193 / j k", label: "Move selection" },
      { keys: "g / G", label: "Top / bottom" },
      { keys: "tab", label: "Search / Real-Debrid / TorBox / Sources" },
      { keys: "a", label: "Accounts (debrid keys)" },
      { keys: "?", label: "Toggle this help" },
      { keys: "q", label: "Quit" },
    ],
  },
  {
    title: "Search",
    hints: [
      { keys: "/", label: "Edit query" },
      { keys: "enter", label: "Run search" },
      { keys: "s", label: "Cycle sort" },
      { keys: "t / z / x", label: "Filter date/size/seeders" },
      { keys: "r", label: "Reset filters" },
      { keys: "y", label: "Copy magnet" },
      { keys: "d / o", label: "Open magnet" },
      { keys: "b", label: "Send to debrid (pick provider)" },
    ],
  },
  {
    title: "Sources",
    hints: [
      { keys: "e / space", label: "Enable / disable" },
      { keys: "t", label: "Retest source" },
      { keys: "T", label: "Retest all" },
      { keys: "m / enter", label: "Switch mirror & retest" },
    ],
  },
  {
    title: "Debrid tabs",
    hints: [
      { keys: "l / enter", label: "Download to disk" },
      { keys: "c", label: "Cancel download" },
      { keys: "o", label: "Open finished file" },
      { keys: "r", label: "Refresh now" },
      { keys: "x", label: "Remove from provider" },
      { keys: "a", label: "Manage accounts" },
    ],
  },
];

export function HelpOverlay() {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={COLOR.accent} paddingX={2} paddingY={1}>
      <Text color={COLOR.accent} bold>
        Keys
      </Text>
      <Box marginTop={1} flexDirection="row" gap={4}>
        {GROUPS.map((g) => (
          <Box key={g.title} flexDirection="column">
            <Text color={COLOR.bright} bold>
              {g.title}
            </Text>
            {g.hints.map((h) => (
              <Box key={h.keys}>
                <Box width={12}>
                  <Text color={COLOR.accent}>{h.keys}</Text>
                </Box>
                <Text color={COLOR.alt}>{h.label}</Text>
              </Box>
            ))}
          </Box>
        ))}
      </Box>
      <Box marginTop={1}>
        <Text color={COLOR.dim}>
          Public sources only · powered by a scoped Cardigann interpreter · credits Prowlarr/Indexers
        </Text>
      </Box>
    </Box>
  );
}
