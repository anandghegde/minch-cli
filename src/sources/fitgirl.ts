import {
  applyLimit,
  makeResult,
  runProbe,
  toUnixSeconds,
  type SourceIdentity,
} from "./adapter";
import { buildMagnet, infoHashFromMagnet } from "./magnet";
import { cleanText, parseSize } from "../util/format";
import { fetchText } from "../util/net";
import type { SearchOptions, Source, TestResult, TorrentResult } from "./types";

// FitGirl Repacks — a reputable PC-games repack site. Its WordPress RSS feed
// (?s=query&feed=rss2) lists each repack post with a title, details link,
// pubDate, and the magnet URI embedded in the post body. The feed exposes no
// swarm stats (seeders/leechers) and no machine-readable size, so rows come
// back with seeders 0 and a best-effort size parsed from the title. Ported from
// TorrentX's fitgirl adapter, adapted to minch's Source interface.
const BASE = "https://fitgirl-repacks.site";
const SRC: SourceIdentity = { id: "fitgirl", label: "FitGirl Repacks" };

interface FitGirlItem {
  title: string;
  link: string;
  pubDate?: string;
  magnet?: string;
}

function decodeHtml(html: string): string {
  return html
    .replace(/&amp;/g, "&")
    .replace(/&#038;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#8211;/g, "\u2013")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

// The magnet is embedded in the post body (inside an href or as bare text), so
// split on <item> and regex each block — cleaner than fighting fast-xml-parser
// over CDATA content:encoded.
function parseFeed(xml: string): FitGirlItem[] {
  const items = xml.split("<item>").slice(1);
  const out: FitGirlItem[] = [];
  for (const item of items) {
    const titleMatch = item.match(/<title>([^<]+)<\/title>/);
    const linkMatch = item.match(/<link>([^<]+)<\/link>/);
    if (!titleMatch || !linkMatch) continue;
    const pubDateMatch = item.match(/<pubDate>([^<]+)<\/pubDate>/);
    const magnetMatch =
      item.match(/href="([^"]*magnet:\?xt=urn:btih:[^"]*)"/i) ||
      item.match(/(magnet:\?xt=urn:btih:[^\s<>"]+)/i);
    out.push({
      title: decodeHtml(titleMatch[1]!),
      link: linkMatch[1]!.trim(),
      pubDate: pubDateMatch?.[1],
      magnet: magnetMatch ? decodeHtml(magnetMatch[1]!) : undefined,
    });
  }
  return out;
}

// FitGirl titles often end with the repack size, e.g. "… [14 GB]" or "(2.3 GB)".
function parseSizeFromTitle(title: string): number {
  const m = title.match(/(\d+(?:\.\d+)?)\s*(GB|MB|TB)\b/i);
  return m ? parseSize(`${m[1]} ${m[2]}`) : 0;
}

function toResults(items: FitGirlItem[]): TorrentResult[] {
  const out: TorrentResult[] = [];
  for (const it of items) {
    // Digest/roundup posts carry no game magnet; skip them so only real repacks
    // (which always embed a magnet) surface as torrent results.
    if (!it.magnet) continue;
    const infoHash = infoHashFromMagnet(it.magnet);
    if (!infoHash) continue;
    const name = cleanText(it.title);
    if (!name) continue;
    if (name.toLowerCase().includes("updates digest")) continue;
    out.push(
      makeResult(SRC, {
        infoHash,
        name,
        sizeBytes: parseSizeFromTitle(name),
        seeders: 0,
        leechers: 0,
        magnet: buildMagnet(infoHash, name),
        detailsUrl: it.link,
        added: toUnixSeconds(it.pubDate),
        category: "Games",
      }),
    );
  }
  return out;
}

function feedUrl(query: string): string {
  const q = query.trim();
  return q ? `${BASE}/?s=${encodeURIComponent(q)}&feed=rss2` : `${BASE}/?feed=rss2`;
}

async function search(
  query: string,
  opts: SearchOptions = {},
): Promise<TorrentResult[]> {
  const xml = await fetchText(feedUrl(query), { signal: opts.signal, retries: 1 });
  return applyLimit(toResults(parseFeed(xml)), opts);
}

async function test(opts: SearchOptions = {}): Promise<TestResult> {
  return runProbe(opts, async () => {
    const xml = await fetchText(feedUrl(""), { signal: opts.signal, retries: 1 });
    return { count: toResults(parseFeed(xml)).length };
  });
}

export const fitgirl: Source = {
  id: SRC.id,
  label: SRC.label,
  kind: "rss",
  links: [BASE],
  requiresConfig: false,
  defaultEnabled: true,
  test,
  search,
};
