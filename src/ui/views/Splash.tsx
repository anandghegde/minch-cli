import { Box, Text } from "ink";
import { useContext } from "react";
import { StoreContext } from "../store";
import { COLOR, ICON } from "../theme";
import { Spinner } from "../components/Spinner";

export interface ProbeProgress {
  total: number;
  done: number;
  ok: number;
  current?: string;
}

export function Splash({
  progress,
  rows,
  cols,
}: {
  progress: ProbeProgress;
  rows?: number;
  cols?: number;
}) {
  const store = useContext(StoreContext);
  const r = rows ?? store?.rows ?? 24;
  const c = cols ?? store?.cols ?? 80;
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 0;
  const barW = Math.max(10, Math.min(40, c - 20));
  const filled = Math.round((pct / 100) * barW);

  return (
    <Box flexDirection="column" height={r} justifyContent="center" paddingX={2}>
      <Box marginBottom={1}>
        <Text color={COLOR.accent} bold>
          minch
        </Text>
        <Text color={COLOR.alt}> · checking public indexers…</Text>
      </Box>
      <Box>
        <Text color={COLOR.good}>{"\u2588".repeat(filled)}</Text>
        <Text color={COLOR.dim}>{"\u2591".repeat(barW - filled)}</Text>
        <Text color={COLOR.alt}>
          {" "}
          {progress.done}/{progress.total} · {progress.ok} working
        </Text>
      </Box>
      <Box marginTop={1}>
        {progress.done < progress.total ? (
          <Spinner label={progress.current ? `testing ${progress.current}` : "probing"} />
        ) : (
          <Text color={COLOR.good}>
            {ICON.done} Ready. Enabled {progress.ok} working source
            {progress.ok === 1 ? "" : "s"}.
          </Text>
        )}
      </Box>
    </Box>
  );
}
