import { executeSearch } from "./executor";
import { definitionRequiresConfig } from "./loader";
import type { CardigannDefinition } from "./model";
import type {
  SearchOptions,
  Source,
  TestResult,
  TorrentResult,
} from "../sources/types";

// A probe query that returns rows on most public sources without being noisy.
const PROBE_QUERY = "1080p";

function toTorrentResults(
  def: CardigannDefinition,
  raw: Awaited<ReturnType<typeof executeSearch>>,
): TorrentResult[] {
  const out: TorrentResult[] = [];
  for (const r of raw) {
    const magnet = r.magnet ?? "";
    if (!magnet && !r.downloadUrl) continue;
    out.push({
      infoHash: r.infoHash ?? r.downloadUrl ?? magnet,
      name: r.title,
      sizeBytes: r.sizeBytes,
      seeders: r.seeders,
      leechers: r.leechers,
      source: def.id,
      sourceLabel: def.name,
      magnet,
      downloadUrl: r.downloadUrl ?? undefined,
      detailsUrl: r.detailsUrl ?? undefined,
      added: r.added,
      category: r.category,
    });
  }
  return out;
}

/**
 * Wrap a parsed Cardigann definition behind the unified Source interface.
 * `getBaseUrl` returns the active mirror (persisted per source); `opts.baseUrl`
 * overrides it for a single call, used when testing a candidate mirror.
 */
export function createCardigannSource(
  def: CardigannDefinition,
  getBaseUrl: () => string,
): Source {
  const requiresConfig = definitionRequiresConfig(def);

  async function search(
    query: string,
    opts: SearchOptions & { baseUrl?: string } = {},
  ): Promise<TorrentResult[]> {
    const base = opts.baseUrl ?? getBaseUrl();
    const raw = await executeSearch(def, query, base, { signal: opts.signal });
    const results = toTorrentResults(def, raw);
    return typeof opts.limit === "number"
      ? results.slice(0, opts.limit)
      : results;
  }

  async function test(
    opts: SearchOptions & { baseUrl?: string } = {},
  ): Promise<TestResult> {
    const started = Date.now();
    try {
      const results = await search(PROBE_QUERY, { ...opts, limit: 25 });
      const latency = Date.now() - started;
      return {
        ok: results.length > 0,
        status: results.length > 0 ? `${results.length} results` : "no results",
        latency,
        count: results.length,
        code: results.length > 0 ? undefined : "empty",
      };
    } catch (e) {
      const latency = Date.now() - started;
      const aborted = opts.signal?.aborted;
      const msg = e instanceof Error ? e.message : String(e);
      const code = aborted
        ? "timed out"
        : /HTTP (\d+)/.exec(msg)?.[0] ?? "no response";
      return { ok: false, status: msg, latency, code };
    }
  }

  return {
    id: def.id,
    label: def.name,
    kind: "cardigann",
    links: def.links,
    language: def.language,
    requiresConfig,
    defaultEnabled: !requiresConfig,
    test,
    search,
  };
}
