import type { SearchOptions, Source, TorrentResult } from "./types";

const TTL_MS = 5 * 60 * 1000;

interface Entry {
  at: number;
  results: TorrentResult[];
}

const cache = new Map<string, Entry>();

function key(sourceId: string, query: string, baseUrl?: string, limit?: number): string {
  return `${sourceId}::${query.trim().toLowerCase()}::${baseUrl ?? ""}::${limit ?? ""}`;
}

/** Search a source, memoizing results for a short TTL to keep the UI snappy. */
export async function cachedSearch(
  source: Source,
  query: string,
  opts: SearchOptions & { baseUrl?: string } = {},
): Promise<TorrentResult[]> {
  const k = key(source.id, query, opts.baseUrl, opts.limit);
  const hit = cache.get(k);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.results;
  const results = await source.search(query, opts);
  cache.set(k, { at: Date.now(), results });
  return results;
}

export function clearCache(): void {
  cache.clear();
}
