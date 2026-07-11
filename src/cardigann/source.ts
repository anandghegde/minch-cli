import { applyLimit, runProbe } from "../sources/adapter";
import { executeSearch } from "./executor";
import { definitionRequiresConfig } from "./loader";
import { createRequestGovernor } from "./rate-limit";
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
  const requestGovernor = createRequestGovernor(def.requestDelay);

  async function search(
    query: string,
    opts: SearchOptions & { baseUrl?: string } = {},
  ): Promise<TorrentResult[]> {
    const base = opts.baseUrl ?? getBaseUrl();
    const raw = await executeSearch(def, query, base, {
      signal: opts.signal,
      requestGovernor,
    });
    return applyLimit(toTorrentResults(def, raw), opts);
  }

  async function test(
    opts: SearchOptions & { baseUrl?: string } = {},
  ): Promise<TestResult> {
    return runProbe(opts, async () => {
      const results = await search(PROBE_QUERY, { ...opts, limit: 25 });
      return { count: results.length, code: results.length > 0 ? undefined : "empty" };
    });
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
