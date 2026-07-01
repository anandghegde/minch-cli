import { fetchResilient, HttpError, USER_AGENT } from "../util/net";
import { buildMagnet } from "./magnet";
import type { SearchOptions, Source, TestResult, TorrentResult } from "./types";

// The Pirate Bay via apibay JSON. A native source: simpler and more robust than
// scraping, and apibay is the canonical public API.
const API = "https://apibay.org";
const ZERO_HASH = "0000000000000000000000000000000000000000";

interface ApibayItem {
  id?: string;
  name?: string;
  info_hash?: string;
  seeders?: string;
  leechers?: string;
  num_files?: string;
  size?: string;
  added?: string;
  category?: string;
}

const CAT_LABELS: Record<string, string> = {
  "1": "Audio",
  "2": "Video",
  "3": "Apps",
  "4": "Games",
  "5": "Other",
  "6": "Other",
};

function toResult(it: ApibayItem): TorrentResult | null {
  const infoHash = (it.info_hash ?? "").toLowerCase();
  if (!infoHash || infoHash === ZERO_HASH || it.id === "0") return null;
  const name = it.name || "Unknown";
  const catHead = (it.category ?? "").charAt(0);
  return {
    infoHash,
    name,
    sizeBytes: Number(it.size) || 0,
    seeders: Number(it.seeders) || 0,
    leechers: Number(it.leechers) || 0,
    source: "thepiratebay",
    sourceLabel: "The Pirate Bay",
    magnet: buildMagnet(infoHash, name),
    added: Number(it.added) || undefined,
    category: CAT_LABELS[catHead],
  };
}

async function fetchItems(url: string, opts: SearchOptions): Promise<ApibayItem[]> {
  const res = await fetchResilient(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: opts.signal,
    retries: 1,
  });
  if (!res.ok) throw new HttpError(res.status, `Pirate Bay returned ${res.status}`);
  const json = (await res.json()) as ApibayItem[];
  return Array.isArray(json) ? json : [];
}

async function search(
  query: string,
  opts: SearchOptions = {},
): Promise<TorrentResult[]> {
  const q = query.trim();
  const url = q
    ? `${API}/q.php?q=${encodeURIComponent(q)}`
    : `${API}/precompiled/data_top100_207.json`;
  const items = await fetchItems(url, opts);
  const out: TorrentResult[] = [];
  for (const it of items) {
    const r = toResult(it);
    if (r) out.push(r);
  }
  return typeof opts.limit === "number" ? out.slice(0, opts.limit) : out;
}

async function test(opts: SearchOptions = {}): Promise<TestResult> {
  const started = Date.now();
  try {
    const items = await fetchItems(
      `${API}/precompiled/data_top100_207.json`,
      opts,
    );
    const latency = Date.now() - started;
    return {
      ok: items.length > 0,
      status: items.length > 0 ? `${items.length} results` : "no results",
      latency,
      count: items.length,
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

export const thepiratebay: Source = {
  id: "thepiratebay",
  label: "The Pirate Bay",
  kind: "api",
  links: [API],
  requiresConfig: false,
  defaultEnabled: true,
  test,
  search,
};
