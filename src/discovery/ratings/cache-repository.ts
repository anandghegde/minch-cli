import { promises as fs } from "node:fs";
import { discoveryRatingsCacheFile } from "../../config/paths";
import { serializeWrites, writeJsonAtomic } from "../../util/atomic";
import {
  emptyRatingsCache,
  normalizeCachedIdentity,
  normalizeCachedMissingRating,
  normalizeCachedRating,
  normalizeRatingsDatasetMetadata,
  parseRatingsCache,
  type CachedIdentity,
  type CachedMissingRating,
  type CachedRating,
  type ParsedRatingsCache,
  type RatingsCacheDocument,
  type RatingsDatasetMetadata,
} from "./cache";

export interface RatingsCacheRepositoryOptions {
  file?: string;
  readFile?: (file: string) => Promise<string>;
  writeJson?: (file: string, value: unknown) => Promise<void>;
}

export interface RatingsCacheRepository {
  load(): Promise<ParsedRatingsCache>;
  snapshot(): Promise<RatingsCacheDocument>;
  getRating(key: string): Promise<CachedRating | undefined>;
  putRating(entry: CachedRating): Promise<void>;
  getIdentity(key: string): Promise<CachedIdentity | undefined>;
  putIdentity(entry: CachedIdentity): Promise<void>;
  getMissing(key: string): Promise<CachedMissingRating | undefined>;
  putMissing(key: string, entry: CachedMissingRating): Promise<void>;
  removeMissing(key: string): Promise<void>;
  getDataset(): Promise<RatingsDatasetMetadata>;
  setDataset(metadata: RatingsDatasetMetadata): Promise<void>;
  flush(): Promise<void>;
}

function missing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

export function createRatingsCacheRepository(
  options: RatingsCacheRepositoryOptions = {},
): RatingsCacheRepository {
  const file = options.file ?? discoveryRatingsCacheFile;
  const readFile = options.readFile ?? ((target: string) => fs.readFile(target, "utf8"));
  const writeJson = options.writeJson ?? ((target: string, value: unknown) =>
    writeJsonAtomic(target, value, { mode: 0o600 }));
  const writes = serializeWrites();
  let document = emptyRatingsCache();
  let loaded: Promise<ParsedRatingsCache> | undefined;
  let pending: Promise<void> | undefined;
  let dirty = false;

  async function load(): Promise<ParsedRatingsCache> {
    loaded ??= (async () => {
      try {
        const text = await readFile(file);
        try {
          const parsed = parseRatingsCache(JSON.parse(text) as unknown);
          document = parsed.document;
          return parsed;
        } catch {
          const parsed = { document: emptyRatingsCache(), rejectedEntries: [],
            documentError: "cache JSON is invalid" } satisfies ParsedRatingsCache;
          document = parsed.document;
          return parsed;
        }
      } catch (error) {
        if (!missing(error)) throw error;
        return { document, rejectedEntries: [] };
      }
    })();
    return loaded;
  }

  function save(): Promise<void> {
    dirty = true;
    if (pending) return pending;
    pending = writes(async () => {
      await Promise.resolve();
      while (dirty) {
        dirty = false;
        try { await writeJson(file, structuredClone(document)); }
        catch (error) { dirty = true; throw error; }
      }
    }).finally(() => { pending = undefined; });
    return pending;
  }

  async function mutate(task: () => void): Promise<void> {
    await load();
    task();
    await save();
  }

  return {
    load,
    async snapshot() { await load(); return structuredClone(document); },
    async getRating(key) { await load(); return document.ratings[key] && structuredClone(document.ratings[key]); },
    putRating: async (entry) => {
      const normalized = normalizeCachedRating(entry);
      if (!normalized) throw new TypeError("invalid cached rating");
      await mutate(() => { document.ratings[normalized.key] = normalized; });
    },
    async getIdentity(key) { await load(); return document.identities[key] && structuredClone(document.identities[key]); },
    putIdentity: async (entry) => {
      const normalized = normalizeCachedIdentity(entry);
      if (!normalized) throw new TypeError("invalid cached identity");
      await mutate(() => { document.identities[normalized.key] = normalized; });
    },
    async getMissing(key) { await load(); return document.missing[key] && structuredClone(document.missing[key]); },
    putMissing: async (key, entry) => {
      const normalized = normalizeCachedMissingRating(entry);
      if (!key || !normalized) throw new TypeError("invalid cached missing rating");
      await mutate(() => { document.missing[key] = normalized; });
    },
    removeMissing: (key) => mutate(() => { delete document.missing[key]; }),
    async getDataset() { await load(); return structuredClone(document.dataset); },
    setDataset: async (metadata) => {
      const normalized = normalizeRatingsDatasetMetadata(metadata);
      if (!normalized) throw new TypeError("invalid ratings dataset metadata");
      await mutate(() => { document.dataset = normalized; });
    },
    async flush() { await load(); if (dirty && !pending) await save(); else if (pending) await pending; await writes.flush(); },
  };
}
