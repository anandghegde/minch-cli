import type { Config } from "../config/config";
import { DEBRID_IDS, type DebridId, type DebridProvider } from "./types";
import { resolveKey } from "./keys";
import { createTorbox } from "./torbox";
import { createRealDebrid } from "./realdebrid";

// Each entry knows how to build its provider from current config. A provider id
// without a builder is simply skipped everywhere (so the UI degrades cleanly).
type Builder = (config: Config) => DebridProvider;

const BUILDERS: Partial<Record<DebridId, Builder>> = {
  torbox: createTorbox,
  realdebrid: createRealDebrid,
};

/** Build a single provider instance bound to the current config, if registered. */
export function getProvider(
  id: DebridId,
  config: Config,
): DebridProvider | undefined {
  return BUILDERS[id]?.(config);
}

/** Every registered provider, configured or not (for the Accounts screen). */
export function allProviders(config: Config): DebridProvider[] {
  const out: DebridProvider[] = [];
  for (const id of DEBRID_IDS) {
    const p = BUILDERS[id]?.(config);
    if (p) out.push(p);
  }
  return out;
}

/** Only providers that currently have a usable key (env var or config). */
export function configuredProviders(config: Config): DebridProvider[] {
  return allProviders(config).filter((p) => p.isConfigured());
}

/** True when at least one provider is usable right now. */
export function anyConfigured(config: Config): boolean {
  return DEBRID_IDS.some((id) => resolveKey(id, config).key !== undefined);
}

/**
 * The provider a `b` hand-off should target: the configured preference when
 * valid, otherwise the sole configured provider, otherwise undefined (so the
 * caller can prompt the user to pick or to add a key).
 */
export function defaultProvider(config: Config): DebridProvider | undefined {
  const configured = configuredProviders(config);
  if (configured.length === 0) return undefined;
  const preferred = config.debrid?.preferred;
  if (preferred) {
    const match = configured.find((p) => p.id === preferred);
    if (match) return match;
  }
  return configured[0];
}
