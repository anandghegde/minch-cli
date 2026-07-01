import { fetchResilient, HttpError, USER_AGENT } from "../util/net";
import { buildMagnet } from "./magnet";
import type { SearchOptions, Source, TestResult, TorrentResult } from "./types";

// SolidTorrents native JSON API. General-purpose meta-search returning magnets
// with seeders directly, no scraping. Ported from torlink (MIT) and adapted to
// minch's Source interface (adds test()/metadata).
const HOSTS = ["solidtorrents.net", "solidtorrents.to"];

interface SolidResult {
  infohash?: string;
  title?: string;
  size?: number;
  seeders?: number;
  leechers?: number;
  updatedAt?: string;
}

interface SolidResponse {
  success?: boolean;
  results?: SolidResult[];
}

async function fetchSearch(
  params: URLSearchParams,
  opts: SearchOptions & { baseUrl?: string },
): Promise<SolidResponse> {
  // baseUrl overrides the mirror list (used by the health probe to try one
  // candidate at a time); otherwise fall through the known hosts.
  const bases = opts.baseUrl
    ? [opts.baseUrl.replace(/\/$/, "")]
    : HOSTS.map((h) => `https://${h}`);
  let lastError: unknown;
  for (const base of bases) {
    try {
      const res = await fetchResilient(`${base}/api/v1/search?${params.toString()}`, {
        headers: { "User-Agent": USER_AGENT },
        signal: opts.signal,
        retries: 1,
      });
      if (res.ok) return (await res.json()) as SolidResponse;
      lastError = new HttpError(res.status, `SolidTorrents returned ${res.status}`);
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      lastError = e;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new HttpError(0, "SolidTorrents unreachable");
}

function toResults(json: SolidResponse): TorrentResult[] {
  const out: TorrentResult[] = [];
  for (const item of json.results ?? []) {
    if (!item.infohash) continue;
    const infoHash = item.infohash.toLowerCase();
    const name = item.title || "Unknown";
    const added = item.updatedAt
      ? Math.floor(new Date(item.updatedAt).getTime() / 1000)
      : undefined;
    out.push({
      infoHash,
      name,
      sizeBytes: item.size ?? 0,
      seeders: item.seeders ?? 0,
      leechers: item.leechers ?? 0,
      source: "solidtorrents",
      sourceLabel: "SolidTorrents",
      magnet: buildMagnet(infoHash, name),
      added: Number.isFinite(added) ? added : undefined,
    });
  }
  return out;
}

async function search(
  query: string,
  opts: SearchOptions & { baseUrl?: string } = {},
): Promise<TorrentResult[]> {
  const q = query.trim();
  const params = new URLSearchParams({ q: q || "1080p", sort: "seeders" });
  const json = await fetchSearch(params, opts);
  const out = toResults(json);
  return typeof opts.limit === "number" ? out.slice(0, opts.limit) : out;
}

async function test(
  opts: SearchOptions & { baseUrl?: string } = {},
): Promise<TestResult> {
  const started = Date.now();
  try {
    const json = await fetchSearch(
      new URLSearchParams({ q: "1080p", sort: "seeders" }),
      opts,
    );
    const out = toResults(json);
    return {
      ok: out.length > 0,
      status: out.length > 0 ? `${out.length} results` : "no results",
      latency: Date.now() - started,
      count: out.length,
      code: out.length > 0 ? undefined : "empty",
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: msg,
      latency: Date.now() - started,
      code: opts.signal?.aborted
        ? "timed out"
        : /HTTP \d+/.exec(msg)?.[0] ?? /returned (\d+)/.exec(msg)?.[1] ?? "no response",
    };
  }
}

export const solidtorrents: Source = {
  id: "solidtorrents",
  label: "SolidTorrents",
  kind: "api",
  links: HOSTS.map((h) => `https://${h}`),
  requiresConfig: false,
  defaultEnabled: true,
  test,
  search,
};
