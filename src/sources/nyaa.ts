import { applyLimit, makeResult, parseRssItems, runProbe, toUnixSeconds, type SourceIdentity } from "./adapter";
import { fetchText } from "../util/net";
import { buildMagnet } from "./magnet";
import { parseSize } from "../util/format";
import { cleanText } from "../util/format";
import type { SearchOptions, Source, TestResult, TorrentResult } from "./types";

// Nyaa anime tracker via its RSS feed (native; exposes nyaa: extension tags
// with infoHash/seeders/leechers/size, so no scraping required).
const BASE = "https://nyaa.si/";

const SRC: SourceIdentity = { id: "nyaa", label: "Nyaa" };

interface NyaaItem {
  title?: string;
  pubDate?: string;
  "nyaa:infoHash"?: string;
  "nyaa:seeders"?: string | number;
  "nyaa:leechers"?: string | number;
  "nyaa:size"?: string;
}

function toResults(xml: string): TorrentResult[] {
  const items = parseRssItems(xml) as NyaaItem[];
  const out: TorrentResult[] = [];
  for (const it of items) {
    const infoHash = String(it["nyaa:infoHash"] ?? "").toLowerCase();
    const name = cleanText(String(it.title ?? ""));
    if (!infoHash || !name) continue;
    const seeders = Number(it["nyaa:seeders"]);
    const leechers = Number(it["nyaa:leechers"]);
    out.push(
      makeResult(SRC, {
        infoHash,
        name,
        sizeBytes: parseSize(String(it["nyaa:size"] ?? "")),
        seeders: Number.isFinite(seeders) ? seeders : 0,
        leechers: Number.isFinite(leechers) ? leechers : 0,
        magnet: buildMagnet(infoHash, name),
        added: toUnixSeconds(it.pubDate),
        category: "Anime",
      }),
    );
  }
  return out;
}

function feedUrl(q: string): string {
  const params = new URLSearchParams({ page: "rss", q, c: "0_0", f: "0" });
  return `${BASE}?${params.toString()}`;
}

async function search(
  query: string,
  opts: SearchOptions = {},
): Promise<TorrentResult[]> {
  const out = toResults(await fetchText(feedUrl(query.trim()), { signal: opts.signal, retries: 1 }));
  return applyLimit(out, opts);
}

async function test(opts: SearchOptions = {}): Promise<TestResult> {
  return runProbe(opts, async () => {
    const out = toResults(await fetchText(feedUrl(""), { signal: opts.signal, retries: 1 }));
    return { count: out.length };
  });
}

export const nyaa: Source = {
  id: SRC.id,
  label: SRC.label,
  kind: "rss",
  links: [BASE],
  requiresConfig: false,
  defaultEnabled: true,
  test,
  search,
};
