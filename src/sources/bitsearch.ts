import {
  applyLimit,
  fetchFirstOk,
  makeResult,
  runProbe,
  type SourceIdentity,
} from "./adapter";
import { buildMagnet } from "./magnet";
import type { SearchOptions, Source, TestResult, TorrentResult } from "./types";

// Bitsearch — a general-purpose public torrent index with a clean JSON API
// (/api/v1/search?q=…). Mirrors the solidtorrents adapter shape. Like
// solidtorrents, the API's date field is the indexer's last refresh, not a
// reliable publish date, so `added` is intentionally left unset (keeps old
// torrents from leaking through the date filter as "recent"). Ported from
// TorrentX's bitsearch adapter.
const HOSTS = ["bitsearch.to"];
const SRC: SourceIdentity = { id: "bitsearch", label: "Bitsearch" };

function searchUrls(
  params: URLSearchParams,
  opts: { baseUrl?: string },
): string[] {
  const bases = opts.baseUrl
    ? [opts.baseUrl.replace(/\/$/, "")]
    : HOSTS.map((h) => `https://${h}`);
  return bases.map((b) => `${b}/api/v1/search?${params.toString()}`);
}

interface BitsearchItem {
  id?: string;
  infohash?: string;
  title?: string;
  size?: number;
  seeders?: number;
  leechers?: number;
  verified?: boolean;
  updatedAt?: string;
}

interface BitsearchResponse {
  success?: boolean;
  results?: BitsearchItem[];
}

function toResults(json: BitsearchResponse): TorrentResult[] {
  const out: TorrentResult[] = [];
  for (const item of json.results ?? []) {
    if (!item.infohash || !item.title) continue;
    const infoHash = item.infohash.toLowerCase();
    out.push(
      makeResult(SRC, {
        infoHash,
        name: item.title,
        sizeBytes: item.size ?? 0,
        seeders: item.seeders ?? 0,
        leechers: item.leechers ?? 0,
        magnet: buildMagnet(infoHash, item.title),
      }),
    );
  }
  return out;
}

async function search(
  query: string,
  opts: SearchOptions & { baseUrl?: string } = {},
): Promise<TorrentResult[]> {
  const params = new URLSearchParams({ q: query.trim() });
  const json = await fetchFirstOk(searchUrls(params, opts), opts, async (r) =>
    (await r.json()) as BitsearchResponse,
  );
  return applyLimit(toResults(json), opts);
}

async function test(
  opts: SearchOptions & { baseUrl?: string } = {},
): Promise<TestResult> {
  return runProbe(opts, async () => {
    const json = await fetchFirstOk(
      searchUrls(new URLSearchParams({ q: "1080p" }), opts),
      opts,
      async (r) => (await r.json()) as BitsearchResponse,
    );
    const out = toResults(json);
    return { count: out.length, code: out.length > 0 ? undefined : "empty" };
  });
}

export const bitsearch: Source = {
  id: SRC.id,
  label: SRC.label,
  kind: "api",
  links: HOSTS.map((h) => `https://${h}`),
  requiresConfig: false,
  defaultEnabled: true,
  test,
  search,
};
