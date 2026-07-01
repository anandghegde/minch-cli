import { XMLParser } from "fast-xml-parser";
import { fetchResilient, HttpError, USER_AGENT } from "../util/net";
import { buildMagnet } from "./magnet";
import { parseSize } from "../util/format";
import { cleanText } from "../util/format";
import type { SearchOptions, Source, TestResult, TorrentResult } from "./types";

// Nyaa anime tracker via its RSS feed (native; exposes nyaa: extension tags
// with infoHash/seeders/leechers/size, so no scraping required).
const BASE = "https://nyaa.si/";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

interface NyaaItem {
  title?: string;
  pubDate?: string;
  "nyaa:infoHash"?: string;
  "nyaa:seeders"?: string | number;
  "nyaa:leechers"?: string | number;
  "nyaa:size"?: string;
}

function toResults(xml: string): TorrentResult[] {
  const doc = parser.parse(xml);
  const rawItems = doc?.rss?.channel?.item;
  const items: NyaaItem[] = Array.isArray(rawItems)
    ? rawItems
    : rawItems
      ? [rawItems]
      : [];
  const out: TorrentResult[] = [];
  for (const it of items) {
    const infoHash = String(it["nyaa:infoHash"] ?? "").toLowerCase();
    const name = cleanText(String(it.title ?? ""));
    if (!infoHash || !name) continue;
    const seeders = Number(it["nyaa:seeders"]);
    const leechers = Number(it["nyaa:leechers"]);
    const dateStr = it.pubDate ? String(it.pubDate) : "";
    out.push({
      infoHash,
      name,
      sizeBytes: parseSize(String(it["nyaa:size"] ?? "")),
      seeders: Number.isFinite(seeders) ? seeders : 0,
      leechers: Number.isFinite(leechers) ? leechers : 0,
      source: "nyaa",
      sourceLabel: "Nyaa",
      magnet: buildMagnet(infoHash, name),
      added: dateStr ? new Date(dateStr).getTime() / 1000 : undefined,
      category: "Anime",
    });
  }
  return out;
}

async function fetchFeed(q: string, opts: SearchOptions): Promise<string> {
  const params = new URLSearchParams({ page: "rss", q, c: "0_0", f: "0" });
  const res = await fetchResilient(`${BASE}?${params.toString()}`, {
    headers: { "User-Agent": USER_AGENT },
    signal: opts.signal,
    retries: 1,
  });
  if (!res.ok) throw new HttpError(res.status, `Nyaa returned ${res.status}`);
  return res.text();
}

async function search(
  query: string,
  opts: SearchOptions = {},
): Promise<TorrentResult[]> {
  const out = toResults(await fetchFeed(query.trim(), opts));
  return typeof opts.limit === "number" ? out.slice(0, opts.limit) : out;
}

async function test(opts: SearchOptions = {}): Promise<TestResult> {
  const started = Date.now();
  try {
    const out = toResults(await fetchFeed("", opts));
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

export const nyaa: Source = {
  id: "nyaa",
  label: "Nyaa",
  kind: "rss",
  links: [BASE],
  requiresConfig: false,
  defaultEnabled: true,
  test,
  search,
};
