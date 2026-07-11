import type { Config } from "../config/config";
import { isEnabled } from "../sources/registry";
import type { ProbeOutcome } from "../sources/health";
import type { Source } from "../sources/types";

/**
 * Apply a probe result without overwriting source choices made after the probe
 * began. A failed probe reports health only; only a successful fallback can
 * replace the currently selected mirror.
 */
export function mergeSourceProbe(
  current: Config,
  started: Config,
  source: Source,
  outcome: ProbeOutcome,
  requestedMirror?: string,
): Config {
  const latest = current.sources[source.id];
  const initial = started.sources[source.id];
  const mirrorChangedDuringProbe = latest?.mirror !== initial?.mirror;
  const mirror = mirrorChangedDuringProbe
    ? latest?.mirror
    : outcome.health.ok
      ? requestedMirror ?? outcome.mirror ?? latest?.mirror
      : latest?.mirror;

  return {
    ...current,
    sources: {
      ...current.sources,
      [source.id]: {
        ...latest,
        enabled: latest?.enabled ?? isEnabled(source, current),
        ...(mirror ? { mirror } : {}),
        health: outcome.health,
      },
    },
  };
}
