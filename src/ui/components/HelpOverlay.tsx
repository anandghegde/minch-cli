import { Box, Text } from "ink";
import {
  DISCOVERY_CREDITS_NOTICE,
  DISCOVERY_SOURCE_CLAIM_NOTICE,
  JUSTWATCH_ATTRIBUTION_NOTICE,
  IMDB_REQUIRED_NOTICE,
  TMDB_REQUIRED_NOTICE,
} from "../../discovery/attribution";
import { COLOR } from "../theme";
import { useStore } from "../store";

const GROUPS: { title: string; hints: { keys: string; label: string }[] }[] = [
  {
    title: "Navigate",
    hints: [
      { keys: "\u2191 \u2193 / j k", label: "Move selection" },
      { keys: "g / G", label: "Top / bottom" },
      { keys: "tab", label: "Search / Discover / Real-Debrid / TorBox / Sources / Settings" },
      { keys: "esc", label: "Close overlay / stop editing" },
      { keys: "a", label: "Accounts (debrid keys)" },
      { keys: "?", label: "Toggle this help" },
      { keys: "q", label: "Quit" },
    ],
  },
  {
    title: "Search",
    hints: [
      { keys: "/ or i", label: "Edit query" },
      { keys: "\u2190 \u2192", label: "Move caret in query" },
      { keys: "Ctrl+A / E", label: "Caret start / end" },
      { keys: "enter", label: "Run search" },
      { keys: "esc", label: "Stop editing" },
      { keys: "s", label: "Cycle sort" },
      { keys: "t / z / x", label: "Filter date/size/seeders" },
      { keys: "c", label: "Filter torrent category" },
      { keys: "f", label: "Match mode soft/strict" },
      { keys: "r", label: "Reset filters" },
      { keys: "y", label: "Copy magnet" },
      { keys: "d / o", label: "Open magnet" },
      { keys: "b", label: "Send to debrid (pick provider)" },
      { keys: '"phrase"', label: "Require contiguous words" },
      { keys: "-word / !word", label: "Exclude token from results" },
    ],
  },
  {
    title: "Discover",
    hints: [
      { keys: "\u2190 \u2192", label: "Switch feed" },
      { keys: "1-7", label: "Jump to feed" },
      { keys: "m", label: "Cycle media type" },
      { keys: "p", label: "Cycle provider" },
      { keys: "l", label: "Cycle language" },
      { keys: "t", label: "Cycle date window" },
      { keys: "o", label: "Cycle sort" },
      { keys: "y", label: "Cycle year filter" },
      { keys: "i", label: "Cycle min IMDb rating" },
      { keys: "v", label: "Cycle min IMDb votes" },
      { keys: "x", label: "Reset filters and sort" },
      { keys: "enter", label: "Open / close details" },
      { keys: "s", label: "Search selected title" },
      { keys: "r", label: "Refresh sources" },
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
      { keys: "y", label: "Copy download link" },
      { keys: "c", label: "Cancel download" },
      { keys: "o", label: "Open finished file" },
      { keys: "r", label: "Refresh now" },
      { keys: "x", label: "Remove from provider" },
      { keys: "a", label: "Manage accounts" },
    ],
  },
  {
    title: "Settings",
    hints: [
      { keys: "↑ ↓ / j k", label: "Select setting" },
      { keys: "enter / e", label: "Edit or toggle" },
      { keys: "← →", label: "Preferred provider" },
      { keys: "← → Ctrl+A/E", label: "Edit text caret" },
    ],
  },
];

export const DISCOVERY_HELP_FOOTNOTES = [
  `Date filters require a known source-added date. ${DISCOVERY_SOURCE_CLAIM_NOTICE}`,
  DISCOVERY_CREDITS_NOTICE,
  TMDB_REQUIRED_NOTICE,
  JUSTWATCH_ATTRIBUTION_NOTICE,
  IMDB_REQUIRED_NOTICE,
] as const;

export function HelpOverlay() {
  const { cols } = useStore();
  const narrow = cols < 100;
  const keyWidth = Math.max(10, Math.min(16, Math.floor(cols / 3)));
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={COLOR.accent} paddingX={2} paddingY={1}>
      <Text color={COLOR.accent} bold>
        Keys
      </Text>
      <Box marginTop={1} flexDirection={narrow ? "column" : "row"} gap={narrow ? 1 : 4}>
        {GROUPS.map((g) => (
          <Box key={g.title} flexDirection="column">
            <Text color={COLOR.bright} bold>
              {g.title}
            </Text>
            {g.hints.map((h) => (
              <Box key={h.keys}>
                <Box width={keyWidth}>
                  <Text color={COLOR.accent}>{h.keys}</Text>
                </Box>
                <Text color={COLOR.alt}>{h.label}</Text>
              </Box>
            ))}
          </Box>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        {DISCOVERY_HELP_FOOTNOTES.map((notice) => (
          <Text key={notice} color={COLOR.dim}>{notice}</Text>
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
