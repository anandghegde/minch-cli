import { afterEach, describe, expect, it, vi } from "vitest";
import { solidtorrents } from "../src/sources/solidtorrents";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const SAMPLE = {
  success: true,
  results: [
    {
      infohash: "0E36A32D0B43E510BF772E33733C9ECCA708C35D",
      title: "Example.2024.1080p.mp4",
      size: 2095419563,
      seeders: 14,
      leechers: 23,
      updatedAt: "2026-06-30T12:30:32.218Z",
    },
    { title: "missing infohash, skipped", seeders: 1 },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe("solidtorrents source", () => {
  it("exposes the shared Source shape", () => {
    expect(solidtorrents.id).toBe("solidtorrents");
    expect(solidtorrents.kind).toBe("api");
    expect(solidtorrents.requiresConfig).toBe(false);
    expect(solidtorrents.defaultEnabled).toBe(true);
    expect(solidtorrents.links.length).toBeGreaterThan(0);
  });

  it("parses results, skips rows without an infohash, builds magnets", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(SAMPLE)));
    const out = await solidtorrents.search("example");
    expect(out).toHaveLength(1);
    const r = out[0]!;
    expect(r.infoHash).toBe("0e36a32d0b43e510bf772e33733c9ecca708c35d");
    expect(r.name).toBe("Example.2024.1080p.mp4");
    expect(r.sizeBytes).toBe(2095419563);
    expect(r.seeders).toBe(14);
    expect(r.source).toBe("solidtorrents");
    expect(r.magnet).toContain("xt=urn:btih:0e36a32d0b43e510bf772e33733c9ecca708c35d");
    // SolidTorrents' `updatedAt` is the indexer's re-index time, not the
    // torrent publish date (every row refreshes within minutes of now). It must
    // not be mapped to `added`, or old torrents show "10m ago" and leak through
    // the date filter.
    expect(r.added).toBeUndefined();
  });

  it("honors the limit option", async () => {
    const many = {
      results: Array.from({ length: 5 }, (_, i) => ({
        infohash: i.toString(16).padStart(40, "a"),
        title: `t${i}`,
      })),
    };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(many)));
    const out = await solidtorrents.search("x", { limit: 2 });
    expect(out).toHaveLength(2);
  });

  it("uses baseUrl override when provided", async () => {
    const spy = vi.fn(async () => jsonResponse(SAMPLE));
    vi.stubGlobal("fetch", spy);
    await solidtorrents.search("x", { baseUrl: "https://mirror.test/" });
    const call = spy.mock.calls[0] as unknown as [string];
    expect(call[0]).toBe("https://mirror.test/api/v1/search?q=x&sort=seeders");
  });

  it("test() reports ok with a result count", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(SAMPLE)));
    const res = await solidtorrents.test();
    expect(res.ok).toBe(true);
    expect(res.count).toBe(1);
  });

  it("test() reports failure on HTTP error with a code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 503)));
    const res = await solidtorrents.test();
    expect(res.ok).toBe(false);
    expect(res.code).toBeTruthy();
  });
});
