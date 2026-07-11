import { Box, Text } from "ink";
import { COLOR } from "../theme";
import { useStore } from "../store";

export interface Hint {
  keys: string;
  label: string;
}

export function Footer({ hints }: { hints: Hint[] }) {
  const { cols } = useStore();
  let used = 0;
  const visible = hints.filter((hint) => {
    const width = hint.keys.length + hint.label.length + 3;
    if (used + width > Math.max(12, cols - 2)) return false;
    used += width;
    return true;
  });
  return (
    <Box>
      {visible.map((h, i) => (
        <Box key={`${h.keys}-${i}`} marginRight={2}>
          <Text color={COLOR.accent}>{h.keys}</Text>
          <Text color={COLOR.dim}> {h.label}</Text>
        </Box>
      ))}
      {visible.length < hints.length ? <Text color={COLOR.dim}>…</Text> : null}
    </Box>
  );
}
