import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyLimit,
  errorToCode,
  fetchFirstOk,
  fetchJson,
  makeResult,
  parseRssItems,
  runProbe,
  toUnixSeconds,
} from "../src/sources/adapter";
import { fetchResilient, HttpError } from "../src/util/net";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("errorToCode", () => {
  it("maps an HttpError status to \"HTTP {n}\"", () => {
    expect(errorToCode(new HttpError(503), false)).toBe("HTTP 503");
    expect(errorToCode(new HttpError(404), false)).toBe("HTTP 404");
  });

  it("collapses a status-0 HttpError (unreachable) to \"no response\"", () => {
    expect(errorToCode(new HttpError(0, "unreachable"), false)).toBe("no response");
  });

  it("returns \"timed out\" on abort, overriding any HttpError status", () => {
    expect(errorToCode(new HttpError(503), true)).toBe("timed out");
  });

  it("returns \"no response\" for non-HttpError values", () => {
    expect(errorToCode(new Error("boom"), false)).toBe("no response");
    expect(errorToCode("boom", false)).toBe("no response");
    expect(errorToCode(undefined, false)).toBe("no response");
  });
});

describe("applyLimit", () => {
  const rows = [1, 2, 3, 4];

  it("slices to opts.limit when set", () => {
    expect(applyLimit(rows, { limit: 2 })).toEqual([1, 2]);
  });

  it("returns all rows when limit is unset", () => {
    expect(applyLimit(rows, {})).toEqual([1, 2, 3, 4]);
  });

  it("returns all rows when limit exceeds length", () => {
    expect(applyLimit(rows, { limit: 10 })).toEqual([1, 2, 3, 4]);
  });

  it("returns no rows for invalid or non-positive limits", () => {
    expect(applyLimit(rows, { limit: -1 })).toEqual([]);
    expect(applyLimit(rows, { limit: Number.NaN })).toEqual([]);
    expect(applyLimit(rows, { limit: Number.POSITIVE_INFINITY })).toEqual([]);
  });
});

describe("toUnixSeconds", () => {
  it("converts a date string to floored unix seconds", () => {
    const iso = "2026-06-30T12:30:32.218Z";
    expect(toUnixSeconds(iso)).toBe(Math.floor(Date.parse(iso) / 1000));
  });

  it("converts an epoch-ms number to floored unix seconds", () => {
    expect(toUnixSeconds(1_000_000)).toBe(1000);
    expect(toUnixSeconds(0)).toBe(0);
  });

  it("returns undefined for missing input", () => {
    expect(toUnixSeconds(undefined)).toBeUndefined();
    expect(toUnixSeconds(null)).toBeUndefined();
  });

  it("returns undefined for an unparseable string", () => {
    expect(toUnixSeconds("not a date")).toBeUndefined();
  });

  it("returns undefined for NaN", () => {
    expect(toUnixSeconds(Number.NaN)).toBeUndefined();
  });
});

describe("parseRssItems", () => {
  it("returns the channel.item array as-is", () => {
    const xml =
      '<?xml version="1.0"?><rss><channel><item><title>A</title></item><item><title>B</title></item></channel></rss>';
    expect(parseRssItems(xml)).toHaveLength(2);
  });

  it("wraps a single (non-array) item into an array", () => {
    const xml =
      '<?xml version="1.0"?><rss><channel><item><title>A</title></item></channel></rss>';
    const items = parseRssItems(xml);
    expect(items).toHaveLength(1);
  });

  it("returns an empty array when there are no items", () => {
    const xml =
      '<?xml version="1.0"?><rss><channel><title>feed</title></channel></rss>';
    expect(parseRssItems(xml)).toEqual([]);
  });
});

describe("fetchJson", () => {
  it("parses the JSON body on an ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ a: 1 })));
    const out = await fetchJson<{ a: number }>("https://x.test");
    expect(out).toEqual({ a: 1 });
  });

  it("throws an HttpError carrying the status on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 404)));
    try {
      await fetchJson("https://x.test");
      throw new Error("expected fetchJson to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).status).toBe(404);
    }
  });
});

describe("fetchFirstOk", () => {
  it("returns the first ok body and stops", async () => {
    const spy = vi.fn(async (url: string) => jsonResponse({ host: url }));
    vi.stubGlobal("fetch", spy);
    const out = await fetchFirstOk(
      ["https://a.test/x", "https://b.test/x"],
      {},
      async (r) => r.json(),
    );
    expect(out).toEqual({ host: "https://a.test/x" });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("falls back to a later host when earlier ones are non-ok", async () => {
    const spy = vi.fn(async (url: string) => {
      if (url.startsWith("https://a.test")) return jsonResponse({}, 404);
      return jsonResponse({ host: url });
    });
    vi.stubGlobal("fetch", spy);
    const out = await fetchFirstOk(
      ["https://a.test/x", "https://b.test/x"],
      {},
      async (r) => r.json(),
    );
    expect(out).toEqual({ host: "https://b.test/x" });
  });

  it("cancels a failed host response before trying the next mirror", async () => {
    let canceled = false;
    const failed = new Response(
      new ReadableStream<Uint8Array>({
        cancel: () => {
          canceled = true;
        },
      }),
      { status: 404 },
    );
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.startsWith("https://a.test") ? failed : jsonResponse({ host: url }),
    ));

    await fetchFirstOk(["https://a.test/x", "https://b.test/x"], {}, async (r) => r.json());
    expect(canceled).toBe(true);
  });

  it("throws the last error when every host fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({}, 404)));
    try {
      await fetchFirstOk(
        ["https://a.test/x", "https://b.test/x"],
        {},
        async (r) => r.json(),
      );
      throw new Error("expected fetchFirstOk to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(HttpError);
      expect((e as HttpError).status).toBe(404);
    }
  });

  it("rethrows immediately on an already-aborted signal without fetching", async () => {
    const spy = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal("fetch", spy);
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      fetchFirstOk(
        ["https://a.test/x", "https://b.test/x"],
        { signal: ctrl.signal },
        async (r) => r.json(),
      ),
    ).rejects.toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("fetchResilient", () => {
  it("cancels retryable responses before issuing the retry", async () => {
    let canceled = false;
    const retryable = new Response(
      new ReadableStream<Uint8Array>({
        cancel: () => {
          canceled = true;
        },
      }),
      { status: 503 },
    );
    const fetchImpl = vi
      .fn(async (): Promise<Response> => jsonResponse({ ok: true }))
      .mockResolvedValueOnce(retryable);

    const res = await fetchResilient("https://x.test", {
      fetchImpl,
      retries: 1,
      sleepImpl: async () => {},
    });
    expect(res.ok).toBe(true);
    expect(canceled).toBe(true);
  });
});

describe("runProbe", () => {
  it("reports a count-based success with latency", async () => {
    const res = await runProbe({}, async () => ({ count: 3 }));
    expect(res.ok).toBe(true);
    expect(res.count).toBe(3);
    expect(res.status).toBe("3 results");
    expect(res.latency).toBeGreaterThanOrEqual(0);
    expect(res.code).toBeUndefined();
  });

  it("reports a failed probe (ok=false) on zero results", async () => {
    const res = await runProbe({}, async () => ({ count: 0 }));
    expect(res.ok).toBe(false);
    expect(res.status).toBe("no results");
    expect(res.code).toBeUndefined();
  });

  it("honors an explicit empty code override", async () => {
    const res = await runProbe({}, async () => ({ count: 0, code: "empty" }));
    expect(res.ok).toBe(false);
    expect(res.code).toBe("empty");
  });

  it("honors an ok override (e.g. the torznab always-ok caps probe)", async () => {
    const res = await runProbe({}, async () => ({ count: 0, ok: true }));
    expect(res.ok).toBe(true);
    expect(res.status).toBe("0 results");
  });

  it("maps a thrown HttpError to an HTTP code via errorToCode", async () => {
    const res = await runProbe({}, async () => {
      throw new HttpError(503, "upstream down");
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("HTTP 503");
    expect(res.status).toBe("upstream down");
  });

  it("maps an aborted probe to \"timed out\"", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const res = await runProbe({ signal: ctrl.signal }, async () => {
      throw new Error("boom");
    });
    expect(res.ok).toBe(false);
    expect(res.code).toBe("timed out");
  });
});

describe("makeResult", () => {
  it("injects source id/label and preserves the rest of the row", () => {
    const r = makeResult(
      { id: "foo", label: "Foo" },
      {
        infoHash: "h",
        name: "n",
        sizeBytes: 1,
        seeders: 2,
        leechers: 3,
        magnet: "magnet:?xt=...",
      },
    );
    expect(r.source).toBe("foo");
    expect(r.sourceLabel).toBe("Foo");
    expect(r.infoHash).toBe("h");
    expect(r.magnet).toBe("magnet:?xt=...");
    expect(r.seeders).toBe(2);
  });
});
