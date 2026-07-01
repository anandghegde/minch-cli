// Single source of truth for what "adding a debrid provider" touches on the
// config side: its env var name, and how its key round-trips through
// `DebridConfig` (read, write, and validate-from-disk). Before this, that
// knowledge was duplicated across keys.ts (configKey/withDebridKey/ENV_VARS)
// and config.ts's coerceDebrid (see refactoring-oppty.md, B5). Adding a new
// provider now means adding one entry here plus one builder in registry.ts.

import type { DebridConfig } from "../config/config";
import { DEBRID_IDS, PROVIDER_LABELS, type DebridId } from "./types";

export interface DebridDescriptor {
  id: DebridId;
  label: string;
  /** Env var that overrides the persisted key for this provider. */
  envVar: string;
  /** Read the persisted key/token for this provider out of a DebridConfig. */
  read(debrid: DebridConfig | undefined): string | undefined;
  /** Return a new DebridConfig with this provider's key set (or cleared). */
  write(debrid: DebridConfig, key: string | undefined): DebridConfig;
  /** Validate + coerce this provider's raw persisted sub-object from disk. */
  coerce(raw: unknown): Partial<DebridConfig>;
}

function stringField(raw: unknown, field: string): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const v = (raw as Record<string, unknown>)[field];
  return typeof v === "string" ? v : undefined;
}

export const DEBRID_DESCRIPTORS: Record<DebridId, DebridDescriptor> = {
  torbox: {
    id: "torbox",
    label: PROVIDER_LABELS.torbox,
    envVar: "MINCH_TORBOX_KEY",
    read: (d) => d?.torbox?.apiKey,
    write: (d, key) => ({ ...d, torbox: key ? { apiKey: key } : undefined }),
    coerce: (raw) => {
      const apiKey = stringField(raw, "apiKey");
      return apiKey !== undefined ? { torbox: { apiKey } } : {};
    },
  },
  realdebrid: {
    id: "realdebrid",
    label: PROVIDER_LABELS.realdebrid,
    envVar: "MINCH_RD_TOKEN",
    read: (d) => d?.realdebrid?.token,
    write: (d, key) => ({ ...d, realdebrid: key ? { token: key } : undefined }),
    coerce: (raw) => {
      const token = stringField(raw, "token");
      return token !== undefined ? { realdebrid: { token } } : {};
    },
  },
};

/** Every descriptor, in the same display order as DEBRID_IDS. */
export function allDescriptors(): DebridDescriptor[] {
  return DEBRID_IDS.map((id) => DEBRID_DESCRIPTORS[id]);
}
