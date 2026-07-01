import { fetchResilient, HttpError, USER_AGENT } from "../util/net";
import { buildMagnet } from "./magnet";
import type { SearchOptions, Source, TestResult, TorrentResult } from "./types";

// YTS native JSON API. High-quality movie source, no scraping needed.
const HOSTS = ["yts.mx", "yts.am", "yts.rs"];

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

async function fetchMovies(
  params: URLSearchParams,
  opts: SearchOptions,
): Promise<YtsResponse> {
  let lastError: unknown;
  for (const host of HOSTS) {
    try {
      const res = await fetchResilient(
        `https://${host}/api/v2/list_movies.json?${params.toString()}`,
        { headers: { "User-Agent": USER_AGENT }, signal: opts.signal, retries: 1 },
      );
      if (res.ok) return (await res.json()) as YtsResponse;
      lastError = new HttpError(res.status, `YTS returned ${res.status}`);
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new HttpError(0, "YTS unreachable");
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
      out.push({
        infoHash,
        name,
        sizeBytes: t.size_bytes ?? 0,
        seeders: t.seeds ?? 0,
        leechers: t.peers ?? 0,
        source: "yts",
        sourceLabel: "YTS",
        magnet: buildMagnet(infoHash, name),
        added: movie.date_uploaded_unix,
        category: "Movies",
      });
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
  const json = await fetchMovies(params, opts);
  const out = toResults(json);
  return typeof opts.limit === "number" ? out.slice(0, opts.limit) : out;
}

async function test(opts: SearchOptions = {}): Promise<TestResult> {
  const started = Date.now();
  try {
    const json = await fetchMovies(
      new URLSearchParams({ limit: "10", sort_by: "date_added" }),
      opts,
    );
    const out = toResults(json);
    return {
      ok: out.length > 0,
      status: out.length > 0 ? `${out.length} results` : "no results",
      latency: Date.now() - started,
      count: out.length,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      status: msg,
      latency: Date.now() - started,
      code: opts.signal?.aborted ? "timed out" : /HTTP \d+/.exec(msg)?.[0] ?? "no response",
    };
  }
}

export const yts: Source = {
  id: "yts",
  label: "YTS",
  kind: "api",
  links: HOSTS.map((h) => `https://${h}`),
  requiresConfig: false,
  defaultEnabled: true,
  test,
  search,
};
