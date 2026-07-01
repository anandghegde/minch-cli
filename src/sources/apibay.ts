import { applyLimit, fetchJson, makeResult, runProbe, type SourceIdentity } from "./adapter";
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

const SRC: SourceIdentity = { id: "thepiratebay", label: "The Pirate Bay" };

function toResult(it: ApibayItem): Omit<TorrentResult, "source" | "sourceLabel"> | null {
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
    magnet: buildMagnet(infoHash, name),
    added: Number(it.added) || undefined,
    category: CAT_LABELS[catHead],
  };
}

async function search(
  query: string,
  opts: SearchOptions = {},
): Promise<TorrentResult[]> {
  const q = query.trim();
  const url = q
    ? `${API}/q.php?q=${encodeURIComponent(q)}`
    : `${API}/precompiled/data_top100_207.json`;
  const items = await fetchJson<ApibayItem[]>(url, opts);
  const rows = Array.isArray(items) ? items : [];
  const out: TorrentResult[] = [];
  for (const it of rows) {
    const r = toResult(it);
    if (r) out.push(makeResult(SRC, r));
  }
  return applyLimit(out, opts);
}

async function test(opts: SearchOptions = {}): Promise<TestResult> {
  return runProbe(opts, async () => {
    const items = await fetchJson<ApibayItem[]>(
      `${API}/precompiled/data_top100_207.json`,
      opts,
    );
    const rows = Array.isArray(items) ? items : [];
    return { count: rows.length };
  });
}

export const thepiratebay: Source = {
  id: SRC.id,
  label: SRC.label,
  kind: "api",
  links: [API],
  requiresConfig: false,
  defaultEnabled: true,
  test,
  search,
};
