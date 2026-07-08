import { loadBundledDefinitions } from "../cardigann/definitions";
import { createCardigannSource } from "../cardigann/source";
import { createTorznabSource } from "./torznab";
import { thepiratebay } from "./apibay";
import { yts } from "./yts";
import { nyaa } from "./nyaa";
import { solidtorrents } from "./solidtorrents";
import { fitgirl } from "./fitgirl";
import { bitsearch } from "./bitsearch";
import type { Config } from "../config/config";
import type { Source } from "./types";

// Native sources are first-class and always present. They sit alongside the
// Cardigann-interpreted public definitions behind the same Source interface.
// FitGirl (games) and Bitsearch (general meta-search) are ported from TorrentX
// and fill gaps not covered by the bundled Cardigann definitions.
const NATIVE_SOURCES: readonly Source[] = [
  thepiratebay,
  yts,
  nyaa,
  solidtorrents,
  fitgirl,
  bitsearch,
];

export interface Registry {
  /** All known sources (native + cardigann + user torznab), by id. */
  sources: Source[];
  byId: Map<string, Source>;
  /** Definition ids that couldn't be loaded, for the Sources screen. */
  rejected: { id: string; reason: string }[];
}

/**
 * Build the source registry. `config` provides the active mirror per source so
 * Cardigann sources resolve the right base URL. Native source ids that also
 * exist as definitions (e.g. thepiratebay, nyaa) are de-duplicated: the native
 * implementation wins because it's more robust.
 */
export async function buildRegistry(config: Config): Promise<Registry> {
  const { definitions, rejected } = await loadBundledDefinitions();
  const sources: Source[] = [];
  const byId = new Map<string, Source>();

  const add = (s: Source): void => {
    if (byId.has(s.id)) return;
    byId.set(s.id, s);
    sources.push(s);
  };

  // Native sources take precedence over same-id definitions.
  for (const s of NATIVE_SOURCES) add(s);

  for (const def of definitions) {
    if (byId.has(def.id)) continue;
    const source = createCardigannSource(def, () => {
      const mirror = config.sources[def.id]?.mirror;
      return mirror && def.links.includes(mirror) ? mirror : def.links[0]!;
    });
    add(source);
  }

  // User-configured Torznab sources.
  for (const cfg of config.torznab) {
    add(createTorznabSource(cfg));
  }

  sources.sort((a, b) => a.label.localeCompare(b.label));
  return { sources, byId, rejected };
}

/** The default base URL for a source given current config. */
export function activeMirror(source: Source, config: Config): string {
  const mirror = config.sources[source.id]?.mirror;
  return mirror && source.links.includes(mirror) ? mirror : source.links[0]!;
}

/** Whether a source is currently enabled (defaults to its defaultEnabled). */
export function isEnabled(source: Source, config: Config): boolean {
  const state = config.sources[source.id];
  if (state && typeof state.enabled === "boolean") return state.enabled;
  return source.defaultEnabled;
}
