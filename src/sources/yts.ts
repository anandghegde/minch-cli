import { applyLimit, fetchFirstOk, makeResult, runProbe, type SourceIdentity } from "./adapter";
import { buildMagnet } from "./magnet";
import type { SearchOptions, Source, TestResult, TorrentResult } from "./types";

// YTS native JSON API. High-quality movie source, no scraping needed.
const HOSTS = ["yts.mx", "yts.am", "yts.rs"];
const SRC: SourceIdentity = { id: "yts", label: "YTS" };

function movieUrls(params: URLSearchParams): string[] {
  return HOSTS.map((h) => `https://${h}/api/v2/list_movies.json?${params.toString()}`);
}

interface YtsTorrent {
  hash?: string;
  quality?: string;
  type?: string;
  size_bytes?: number;
  seeds?: number;
  peers?: number;
}
interface YtsMovie {
  title_long?: string;
  title?: string;
  date_uploaded_unix?: number;
  torrents?: YtsTorrent[];
}
interface YtsResponse {
  data?: { movies?: YtsMovie[] };
}

function toResults(json: YtsResponse): TorrentResult[] {
  const out: TorrentResult[] = [];
  for (const movie of json.data?.movies ?? []) {
    const base = movie.title_long || movie.title || "Unknown";
    for (const t of movie.torrents ?? []) {
      if (!t.hash) continue;
      const infoHash = t.hash.toLowerCase();
      const tag = [t.quality, t.type].filter(Boolean).join(" ");
      const name = tag ? `${base} [${tag}]` : base;
      out.push(
        makeResult(SRC, {
          infoHash,
          name,
          sizeBytes: t.size_bytes ?? 0,
          seeders: t.seeds ?? 0,
          leechers: t.peers ?? 0,
          magnet: buildMagnet(infoHash, name),
          added: movie.date_uploaded_unix,
          category: "Movies",
        }),
      );
    }
  }
  return out;
}

async function search(
  query: string,
  opts: SearchOptions = {},
): Promise<TorrentResult[]> {
  const q = query.trim();
  const params = new URLSearchParams({ limit: "50" });
  if (q) params.set("query_term", q);
  else params.set("sort_by", "date_added");
  const json = await fetchFirstOk(movieUrls(params), opts, async (r) => (await r.json()) as YtsResponse);
  const out = toResults(json);
  return applyLimit(out, opts);
}

async function test(opts: SearchOptions = {}): Promise<TestResult> {
  return runProbe(opts, async () => {
    const json = await fetchFirstOk(
      movieUrls(new URLSearchParams({ limit: "10", sort_by: "date_added" })),
      opts,
      async (r) => (await r.json()) as YtsResponse,
    );
    return { count: toResults(json).length };
  });
}

export const yts: Source = {
  id: SRC.id,
  label: SRC.label,
  kind: "api",
  links: HOSTS.map((h) => `https://${h}`),
  requiresConfig: false,
  defaultEnabled: true,
  test,
  search,
};
