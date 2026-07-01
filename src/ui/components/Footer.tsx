import { Box, Text } from "ink";
import { COLOR } from "../theme";

export interface Hint {
  keys: string;
  label: string;
}

export function Footer({ hints }: { hints: Hint[] }) {
  return (
    <Box>
      {hints.map((h, i) => (
        <Box key={`${h.keys}-${i}`} marginRight={2}>
          <Text color={COLOR.accent}>{h.keys}</Text>
          <Text color={COLOR.dim}> {h.label}</Text>
        </Box>
      ))}
    </Box>
  );
}
