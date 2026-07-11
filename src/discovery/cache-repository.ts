import { promises as fs } from "node:fs";
import { discoveryCacheFile } from "../config/paths";
import { serializeWrites, writeJsonAtomic } from "../util/atomic";
import {
  createDiscoveryCacheEntry,
  discoveryRequestKey,
  emptyDiscoveryCache,
  parseDiscoveryCache,
  type DiscoveryCacheEntry,
  type DiscoveryCacheDocument,
  type ParsedDiscoveryCache,
} from "./cache";
import type { DiscoverySnapshot } from "./adapter";
import type { DiscoveryRequest } from "./request";

export interface CacheRepositoryOptions {
  file?: string;
  readFile?: (file: string) => Promise<string>;
  writeJson?: (file: string, value: unknown) => Promise<void>;
}

export interface DiscoveryCacheRepository {
  load(): Promise<ParsedDiscoveryCache>;
  get(source: DiscoverySnapshot["source"], request: DiscoveryRequest): Promise<DiscoveryCacheEntry | undefined>;
  put(entry: DiscoveryCacheEntry): Promise<void>;
  putSnapshot(
    request: DiscoveryRequest,
    snapshot: DiscoverySnapshot,
    expiresAt: number,
    staleUntil: number,
  ): Promise<void>;
  remove(source: DiscoverySnapshot["source"], request: DiscoveryRequest): Promise<void>;
  flush(): Promise<void>;
}

function isMissingFile(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

export function createDiscoveryCacheRepository(
  options: CacheRepositoryOptions = {},
): DiscoveryCacheRepository {
  const file = options.file ?? discoveryCacheFile;
  const readFile = options.readFile ?? ((target: string) => fs.readFile(target, "utf8"));
  const writeJson = options.writeJson ?? ((target: string, value: unknown) =>
    writeJsonAtomic(target, value, { mode: 0o600 }));
  const writes = serializeWrites();

  let document: DiscoveryCacheDocument = emptyDiscoveryCache();
  let loadResult: ParsedDiscoveryCache | undefined;
  let loadPromise: Promise<ParsedDiscoveryCache> | undefined;
  let dirty = false;
  let pendingWrite: Promise<void> | undefined;

  async function readDocument(): Promise<ParsedDiscoveryCache> {
    try {
      const text = await readFile(file);
      let raw: unknown;
      try {
        raw = JSON.parse(text) as unknown;
      } catch {
        return {
          document: emptyDiscoveryCache(),
          rejectedEntries: [],
          documentError: "cache JSON is invalid",
        };
      }
      return parseDiscoveryCache(raw);
    } catch (error) {
      if (isMissingFile(error)) {
        return { document: emptyDiscoveryCache(), rejectedEntries: [] };
      }
      throw error;
    }
  }

  async function load(): Promise<ParsedDiscoveryCache> {
    if (loadResult) return loadResult;
    loadPromise ??= readDocument().then((parsed) => {
      document = parsed.document;
      loadResult = parsed;
      return parsed;
    });
    return loadPromise;
  }

  function scheduleWrite(): Promise<void> {
    dirty = true;
    if (pendingWrite) return pendingWrite;
    pendingWrite = writes(async () => {
      // Let concurrent mutations that resumed from the same load coalesce.
      await Promise.resolve();
      while (dirty) {
        dirty = false;
        const snapshot = structuredClone(document);
        try {
          await writeJson(file, snapshot);
        } catch (error) {
          dirty = true;
          throw error;
        }
      }
    }).finally(() => {
      pendingWrite = undefined;
    });
    return pendingWrite;
  }

  async function get(
    source: DiscoverySnapshot["source"],
    request: DiscoveryRequest,
  ): Promise<DiscoveryCacheEntry | undefined> {
    await load();
    return document.entries[discoveryRequestKey(source, request)];
  }

  async function put(entry: DiscoveryCacheEntry): Promise<void> {
    await load();
    const key = discoveryRequestKey(entry.source, entry.request);
    document.entries[key] = entry;
    await scheduleWrite();
  }

  async function putSnapshot(
    request: DiscoveryRequest,
    snapshot: DiscoverySnapshot,
    expiresAt: number,
    staleUntil: number,
  ): Promise<void> {
    await put(createDiscoveryCacheEntry(request, snapshot, expiresAt, staleUntil));
  }

  async function remove(
    source: DiscoverySnapshot["source"],
    request: DiscoveryRequest,
  ): Promise<void> {
    await load();
    const key = discoveryRequestKey(source, request);
    if (!Object.hasOwn(document.entries, key)) return;
    delete document.entries[key];
    await scheduleWrite();
  }

  async function flush(): Promise<void> {
    await load();
    if (dirty && !pendingWrite) await scheduleWrite();
    else if (pendingWrite) await pendingWrite;
    await writes.flush();
  }

  return { load, get, put, putSnapshot, remove, flush };
}
