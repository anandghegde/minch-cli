import { XMLParser } from "fast-xml-parser";
import { fetchResilient, HttpError, USER_AGENT } from "../util/net";
import { infoHashFromMagnet, buildMagnet, normalizeInfoHash } from "./magnet";
import { cleanText } from "../util/format";
import type { SearchOptions, Source, TestResult, TorrentResult } from "./types";

// Generic Torznab/Newznab source. User-configured: name, base URL, optional API
// key + categories. Implements the standard t=search Torznab response shape.

export interface TorznabConfig {
  id: string;
  name: string;
  baseUrl: string;
  apiKey?: string;
  categories?: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
});

interface TorznabItem {
  title?: string;
  pubDate?: string;
  size?: string | number;
  enclosure?: { "@_url"?: string; "@_length"?: string };
  link?: string;
  // torznab:attr entries collapse to an array of { @_name, @_value }.
  "torznab:attr"?: { "@_name": string; "@_value": string }[];
}

function attr(item: TorznabItem, name: string): string | undefined {
  const attrs = item["torznab:attr"];
  if (!attrs) return undefined;
  const arr = Array.isArray(attrs) ? attrs : [attrs];
  return arr.find((a) => a["@_name"] === name)?.["@_value"];
}

function toResults(xml: string, cfg: TorznabConfig): TorrentResult[] {
  const doc = parser.parse(xml);
  const rawItems = doc?.rss?.channel?.item;
  const items: TorznabItem[] = Array.isArray(rawItems)
    ? rawItems
    : rawItems
      ? [rawItems]
      : [];
  const out: TorrentResult[] = [];
  for (const it of items) {
    const name = cleanText(String(it.title ?? ""));
    if (!name) continue;
    const enclosureUrl = it.enclosure?.["@_url"];
    const magnetAttr = attr(it, "magneturl");
    let magnet = "";
    let downloadUrl: string | undefined;
    if (magnetAttr?.startsWith("magnet:")) magnet = magnetAttr;
    else if (enclosureUrl?.startsWith("magnet:")) magnet = enclosureUrl;
    else downloadUrl = enclosureUrl ?? it.link ?? undefined;

    let infoHash = attr(it, "infohash");
    if (infoHash) infoHash = normalizeInfoHash(infoHash);
    if (!magnet && infoHash) magnet = buildMagnet(infoHash, name);
    if (!infoHash && magnet) infoHash = infoHashFromMagnet(magnet) ?? undefined;
    if (!magnet && !downloadUrl) continue;

    const sizeRaw = attr(it, "size") ?? it.size ?? it.enclosure?.["@_length"];
    out.push({
      infoHash: infoHash ?? downloadUrl ?? magnet,
      name,
      sizeBytes: Number(sizeRaw) || 0,
      seeders: Number(attr(it, "seeders")) || 0,
      leechers: Number(attr(it, "peers")) || 0,
      source: cfg.id,
      sourceLabel: cfg.name,
      magnet,
      downloadUrl,
      added: it.pubDate ? new Date(String(it.pubDate)).getTime() / 1000 : undefined,
    });
  }
  return out;
}

function buildUrl(cfg: TorznabConfig, params: Record<string, string>): string {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  // Allow either ".../api" or a bare base; Torznab convention is /api.
  const apiBase = /\/api$/i.test(base) ? base : `${base}/api`;
  const u = new URL(apiBase);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  if (cfg.apiKey) u.searchParams.set("apikey", cfg.apiKey);
  if (cfg.categories) u.searchParams.set("cat", cfg.categories);
  return u.href;
}

async function fetchXml(url: string, opts: SearchOptions): Promise<string> {
  const res = await fetchResilient(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: opts.signal,
    retries: 1,
  });
  if (!res.ok) throw new HttpError(res.status, `Torznab returned ${res.status}`);
  return res.text();
}

export function createTorznabSource(cfg: TorznabConfig): Source {
  async function search(
    query: string,
    opts: SearchOptions = {},
  ): Promise<TorrentResult[]> {
    const q = query.trim();
    const url = buildUrl(cfg, q ? { t: "search", q } : { t: "search" });
    const out = toResults(await fetchXml(url, opts), cfg);
    return typeof opts.limit === "number" ? out.slice(0, opts.limit) : out;
  }

  async function test(opts: SearchOptions = {}): Promise<TestResult> {
    const started = Date.now();
    try {
      // Use caps first (cheap), then a tiny search to confirm parsing.
      const capsUrl = buildUrl(cfg, { t: "caps" });
      await fetchXml(capsUrl, opts);
      const out = toResults(
        await fetchXml(buildUrl(cfg, { t: "search" }), opts),
        cfg,
      );
      return {
        ok: true,
        status: `${out.length} results`,
        latency: Date.now() - started,
        count: out.length,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        status: msg,
        latency: Date.now() - started,
        code: opts.signal?.aborted
          ? "timed out"
          : /HTTP \d+/.exec(msg)?.[0] ?? "no response",
      };
    }
  }

  return {
    id: cfg.id,
    label: cfg.name,
    kind: "torznab",
    links: [cfg.baseUrl],
    requiresConfig: true,
    defaultEnabled: false,
    test,
    search,
  };
}
