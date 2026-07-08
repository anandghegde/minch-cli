import { afterEach, describe, expect, it, vi } from "vitest";
import { fitgirl } from "../src/sources/fitgirl";

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/rss+xml" },
  });
}

// A trimmed FitGirl RSS feed: one real repack post with an embedded magnet, and
// one digest post without a magnet (which must be skipped).
const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>FitGirl Repacks</title>
  <item>
    <title>Some Game (v1.0 + DLC, MULTi12, FitGirl Repack, [14 GB])</title>
    <link>https://fitgirl-repacks.site/some-game/</link>
    <pubDate>Mon, 02 Jun 2025 12:00:00 +0000</pubDate>
    <description><![CDATA[<a href="magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Some+Game">download</a>]]></description>
  </item>
  <item>
    <title>Updates Digest &amp; Repacks News</title>
    <link>https://fitgirl-repacks.site/digest/</link>
    <pubDate>Tue, 03 Jun 2025 12:00:00 +0000</pubDate>
    <description><![CDATA[<p>no magnet here</p>]]></description>
  </item>
</channel></rss>`;

afterEach(() => vi.unstubAllGlobals());

describe("fitgirl source", () => {
  it("exposes the shared Source shape", () => {
    expect(fitgirl.id).toBe("fitgirl");
    expect(fitgirl.kind).toBe("rss");
    expect(fitgirl.requiresConfig).toBe(false);
    expect(fitgirl.defaultEnabled).toBe(true);
    expect(fitgirl.links.length).toBeGreaterThan(0);
  });

  it("keeps magnet-bearing posts, skips digests, extracts hash + size", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => textResponse(FEED)));
    const out = await fitgirl.search("some game");
    expect(out).toHaveLength(1);
    const row = out[0]!;
    expect(row.source).toBe("fitgirl");
    expect(row.infoHash).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(row.category).toBe("Games");
    expect(row.sizeBytes).toBe(14 * 1_000_000_000);
    expect(row.magnet).toContain("xt=urn:btih:0123456789abcdef0123456789abcdef01234567");
    expect(row.detailsUrl).toBe("https://fitgirl-repacks.site/some-game/");
    expect(row.added).toBe(
      Math.floor(Date.parse("Mon, 02 Jun 2025 12:00:00 +0000") / 1000),
    );
  });

  it("test() reports ok with a count", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => textResponse(FEED)));
    const res = await fitgirl.test();
    expect(res.ok).toBe(true);
    expect(res.count).toBe(1);
  });

  it("test() reports failure on HTTP error with a code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => textResponse("", 503)));
    const res = await fitgirl.test();
    expect(res.ok).toBe(false);
    expect(res.code).toBeTruthy();
  });
});
