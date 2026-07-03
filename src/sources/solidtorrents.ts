import { applyLimit, fetchFirstOk, makeResult, runProbe, type SourceIdentity } from "./adapter";
import { buildMagnet } from "./magnet";
import type { SearchOptions, Source, TestResult, TorrentResult } from "./types";

// SolidTorrents native JSON API. General-purpose meta-search returning magnets
// with seeders directly, no scraping. Ported from torlink (MIT) and adapted to
// minch's Source interface (adds test()/metadata).
const HOSTS = ["solidtorrents.net", "solidtorrents.to"];
const SRC: SourceIdentity = { id: "solidtorrents", label: "SolidTorrents" };

function searchUrls(
  params: URLSearchParams,
  opts: { baseUrl?: string },
): string[] {
  // baseUrl overrides the mirror list (the health probe tries one candidate at
  // a time); otherwise fall through the known hosts.
  const bases = opts.baseUrl
    ? [opts.baseUrl.replace(/\/$/, "")]
    : HOSTS.map((h) => `https://${h}`);
  return bases.map((b) => `${b}/api/v1/search?${params.toString()}`);
}

interface SolidResult {
  infohash?: string;
  title?: string;
  size?: number;
  seeders?: number;
  leechers?: number;
  // SolidTorrents exposes only `updatedAt`, which is the indexer's last
  // re-index/swarm-stat refresh time — NOT the torrent's publish date. Every
  // row refreshes within minutes of now, so mapping it to `added` made
  // genuinely old torrents show "10m ago" and bypass the date filter. The API
  // offers no creation date, so we leave `added` undefined (row stays, just
  // undated, like a Cardigann source whose def has no date field).
  updatedAt?: string;
}

interface SolidResponse {
  success?: boolean;
  results?: SolidResult[];
}

function toResults(json: SolidResponse): TorrentResult[] {
  const out: TorrentResult[] = [];
  for (const item of json.results ?? []) {
    if (!item.infohash) continue;
    const infoHash = item.infohash.toLowerCase();
    const name = item.title || "Unknown";
    out.push(
      makeResult(SRC, {
        infoHash,
        name,
        sizeBytes: item.size ?? 0,
        seeders: item.seeders ?? 0,
        leechers: item.leechers ?? 0,
        magnet: buildMagnet(infoHash, name),
        // Deliberately omitted: the API's `updatedAt` is a re-index timestamp,
        // not a publish date (see SolidResult). Leaving `added` unset keeps old
        // torrents from masquerading as recent.
      }),
    );
  }
  return out;
}

async function search(
  query: string,
  opts: SearchOptions & { baseUrl?: string } = {},
): Promise<TorrentResult[]> {
  const q = query.trim();
  const params = new URLSearchParams({ q: q || "1080p", sort: "seeders" });
  const json = await fetchFirstOk(searchUrls(params, opts), opts, async (r) => (await r.json()) as SolidResponse);
  const out = toResults(json);
  return applyLimit(out, opts);
}

async function test(
  opts: SearchOptions & { baseUrl?: string } = {},
): Promise<TestResult> {
  return runProbe(opts, async () => {
    const json = await fetchFirstOk(
      searchUrls(new URLSearchParams({ q: "1080p", sort: "seeders" }), opts),
      opts,
      async (r) => (await r.json()) as SolidResponse,
    );
    const out = toResults(json);
    return { count: out.length, code: out.length > 0 ? undefined : "empty" };
  });
}

export const solidtorrents: Source = {
  id: SRC.id,
  label: SRC.label,
  kind: "api",
  links: HOSTS.map((h) => `https://${h}`),
  requiresConfig: false,
  defaultEnabled: true,
  test,
  search,
};
