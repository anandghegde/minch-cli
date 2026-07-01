import type { SourceHealth } from "../config/config";
import type { Source } from "./types";
import { mapPool } from "../util/concurrency";

const PROBE_TIMEOUT_MS = 20_000;

export interface ProbeOutcome {
  id: string;
  health: SourceHealth;
  /** The mirror that produced this outcome (the working one, or the last tried). */
  mirror?: string;
}

/** Probe a single candidate mirror with a hard timeout. */
async function probeMirror(
  source: Source,
  baseUrl: string | undefined,
  timeoutMs: number,
): Promise<SourceHealth> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await source.test({ signal: ctrl.signal, baseUrl });
    return {
      ok: res.ok,
      status: res.status,
      code: res.code,
      latency: res.latency,
      testedAt: Date.now(),
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: msg,
      code: ctrl.signal.aborted ? "timed out" : "error",
      testedAt: Date.now(),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Health-probe a source, trying its mirrors in order until one passes. The
 * `preferred` mirror (e.g. the user's configured choice) is tried first, then
 * the remaining `source.links` as fallbacks. Resolves with the first working
 * mirror's outcome, or the last failure if none work. Stops early on success.
 */
export async function probeSource(
  source: Source,
  preferred?: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<ProbeOutcome> {
  // Build an ordered, de-duplicated candidate list: preferred first, then links.
  const candidates: (string | undefined)[] = [];
  const seen = new Set<string>();
  const push = (u: string | undefined): void => {
    const key = u ?? "";
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(u);
  };
  if (preferred) push(preferred);
  for (const link of source.links) push(link);
  if (candidates.length === 0) push(undefined);

  let last: { health: SourceHealth; mirror?: string } | undefined;
  for (const base of candidates) {
    const health = await probeMirror(source, base, timeoutMs);
    if (health.ok) return { id: source.id, health, mirror: base };
    last = { health, mirror: base };
  }
  return { id: source.id, health: last!.health, mirror: last!.mirror };
}

/**
 * Probe many sources concurrently, invoking onResult as each finishes so the
 * first-run UI can stream per-source status. Resolves once all settle.
 */
export async function probeAll(
  sources: Source[],
  mirrorOf: (s: Source) => string | undefined,
  onResult: (outcome: ProbeOutcome) => void,
  concurrency = 12,
): Promise<ProbeOutcome[]> {
  const settled = await mapPool(sources, concurrency, async (source) => {
    const outcome = await probeSource(source, mirrorOf(source));
    onResult(outcome);
    return outcome;
  });
  return settled
    .filter((r): r is PromiseFulfilledResult<ProbeOutcome> => r.status === "fulfilled")
    .map((r) => r.value);
}
