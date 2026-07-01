import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cacheCheckHashes,
  createTorbox,
  mapDownloadState,
} from "../src/debrid/torbox";
import { isDebridError } from "../src/debrid/types";
import { defaultConfig, type Config } from "../src/config/config";

const BTIH = "deadbeef".repeat(5); // 40 hex chars
const MAGNET = `magnet:?xt=urn:btih:${BTIH}`;

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A successful TorBox envelope. */
function ok(data: unknown, extra: Record<string, unknown> = {}): Response {
  return jsonResponse({ success: true, data, ...extra });
}

function cfg(apiKey = "tb_test_key_1234"): Config {
  return { ...defaultConfig, debrid: { torbox: { apiKey } } };
}

async function rejection<T>(p: Promise<T>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error("expected rejection");
    },
    (e) => e,
  );
}

beforeEach(() => {
  // Env precedence would otherwise mask the config key under test.
  delete process.env.MINCH_TORBOX_KEY;
});
afterEach(() => vi.unstubAllGlobals());

describe("torbox: add (multipart construction)", () => {
  it("posts the magnet as multipart and returns the torrent id", async () => {
    const spy = vi.fn(async () => ok({ torrent_id: 42, hash: "abc" }, { detail: "Added" }));
    vi.stubGlobal("fetch", spy);

    const res = await createTorbox(cfg()).addMagnet(MAGNET, { name: "Movie" });
    expect(res.id).toBe("42");
    expect(res.hash).toBe("abc");
    expect(res.detail).toBe("Added");

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.torbox.app/v1/api/torrents/createtorrent");
    expect(init.method).toBe("POST");
    const form = init.body as FormData;
    expect(form.get("magnet")).toBe(MAGNET);
    expect(form.get("name")).toBe("Movie");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer tb_test_key_1234",
    );
  });

  it("appends as_queued=false only for a cache-only add", async () => {
    const spy = vi.fn(async () => ok({ torrent_id: 1 }, { detail: "ok" }));
    vi.stubGlobal("fetch", spy);
    await createTorbox(cfg()).addMagnet(MAGNET, { cacheOnly: true });
    const form = (spy.mock.calls[0] as unknown as [string, RequestInit])[1].body as FormData;
    expect(form.get("as_queued")).toBe("false");
  });

  it("uploads .torrent bytes as an application/x-bittorrent file part", async () => {
    const spy = vi.fn(async () => ok({ torrent_id: 7 }, { detail: "Added" }));
    vi.stubGlobal("fetch", spy);

    const bytes = new Uint8Array([1, 2, 3, 4]);
    await createTorbox(cfg()).addTorrentFile!(bytes, "My Torrent", { name: "Movie" });

    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain("/torrents/createtorrent");
    const form = init.body as FormData;
    const file = form.get("file") as unknown as { name: string; type: string; size: number };
    expect(file.type).toBe("application/x-bittorrent");
    expect(file.name).toBe("My Torrent.torrent");
    expect(file.size).toBe(4);
  });
});

describe("torbox: envelope / add interpretation", () => {
  it("flags an already-added cached torrent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ok({ torrent_id: 9, hash: "h" }, { detail: "Found Cached Torrent. Already added." })),
    );
    const res = await createTorbox(cfg()).addMagnet(MAGNET);
    expect(res.alreadyPresent).toBe(true);
    expect(res.detail).toMatch(/already added/i);
  });

  it("treats a queued_id-only response as queued", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ torrent_id: null, queued_id: 5 }, { detail: "Queued" })));
    const res = await createTorbox(cfg()).addMagnet(MAGNET);
    expect(res.id).toBeUndefined();
    expect(res.queuedId).toBe("5");
  });

  it("throws a validation error when both ids are null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ success: true, data: { torrent_id: null, queued_id: null }, detail: "Invalid magnet" })),
    );
    const err = await rejection(createTorbox(cfg()).addMagnet(MAGNET));
    expect(isDebridError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe("validation");
    expect((err as Error).message).toBe("Invalid magnet");
  });
});

describe("torbox: download_state mapping", () => {
  it("maps every documented state onto a normalized status", () => {
    expect(mapDownloadState("downloading")).toBe("downloading");
    expect(mapDownloadState("metaDL")).toBe("downloading");
    expect(mapDownloadState("downloadingMetadata")).toBe("downloading");
    expect(mapDownloadState("seeding")).toBe("seeding");
    expect(mapDownloadState("uploading")).toBe("seeding");
    expect(mapDownloadState("completed")).toBe("done");
    expect(mapDownloadState("cached")).toBe("done");
    expect(mapDownloadState("downloaded")).toBe("done");
    expect(mapDownloadState("paused")).toBe("queued");
    expect(mapDownloadState("error")).toBe("error");
    expect(mapDownloadState("missingFiles")).toBe("error");
    expect(mapDownloadState("something-else")).toBe("queued");
    expect(mapDownloadState(undefined)).toBe("queued");
  });
});

describe("torbox: list", () => {
  it("merges and normalizes torrents and web downloads", async () => {
    const spy = vi.fn(async (url: string) => {
      if (url.includes("/torrents/mylist")) {
        return ok([
          {
            id: 1,
            name: "Torrent",
            size: 100,
            progress: 0.5,
            download_state: "downloading",
            download_speed: 1000,
            eta: 60,
            hash: "HH",
            files: [{ id: 0, short_name: "f.mkv", size: 100 }],
          },
        ]);
      }
      return ok([{ id: 3, name: "Web", size: 50, progress: 1, download_state: "completed" }]);
    });
    vi.stubGlobal("fetch", spy);

    const out = await createTorbox(cfg("k-list")).listTransfers();
    expect(out).toHaveLength(2);
    const t = out.find((x) => x.id === "1")!;
    expect(t.status).toBe("downloading");
    expect(t.progress).toBe(0.5);
    expect(t.downloadSpeedBps).toBe(1000);
    expect(t.etaSeconds).toBe(60);
    expect(t.files[0]!.name).toBe("f.mkv");
    const w = out.find((x) => x.id === "webdl:3")!;
    expect(w.status).toBe("done");
    expect(w.provider).toBe("torbox");
  });

  it("does not blank when the webdl list fails", async () => {
    const spy = vi.fn(async (url: string) => {
      if (url.includes("/torrents/mylist")) return ok([{ id: 1, download_state: "downloading" }]);
      return jsonResponse({ success: false, detail: "no webdl" }, 403);
    });
    vi.stubGlobal("fetch", spy);
    const out = await createTorbox(cfg("k-webfail")).listTransfers();
    expect(out.map((t) => t.id)).toEqual(["1"]);
  });

  it("adds bypass_cache=true only after an active transfer is seen", async () => {
    const urls: string[] = [];
    const spy = vi.fn(async (url: string) => {
      urls.push(url);
      if (url.includes("/torrents/mylist")) return ok([{ id: 1, download_state: "downloading" }]);
      return ok([]);
    });
    vi.stubGlobal("fetch", spy);

    const tb = createTorbox(cfg("k-bypass"));
    await tb.listTransfers();
    await tb.listTransfers();
    const torrentUrls = urls.filter((u) => u.includes("/torrents/mylist"));
    expect(torrentUrls[0]).not.toContain("bypass_cache");
    expect(torrentUrls[1]).toContain("bypass_cache=true");
  });

  it("treats success:false as an error even on HTTP 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ success: false, detail: "boom" }, 200)));
    const err = await rejection(createTorbox(cfg("k-200fail")).listTransfers());
    expect(isDebridError(err)).toBe(true);
    expect((err as Error).message).toBe("boom");
  });
});

describe("torbox: resolveFileUrl", () => {
  it("returns the bare URL string and passes the token query param", async () => {
    const spy = vi.fn(async () => ok("https://store.torbox.app/abc/file.mkv"));
    vi.stubGlobal("fetch", spy);

    const r = await createTorbox(cfg("k-dl")).resolveFileUrl("123", "0");
    expect(r.url).toBe("https://store.torbox.app/abc/file.mkv");
    expect(r.filename).toBe("file.mkv");

    const [url] = spy.mock.calls[0] as unknown as [string];
    expect(url).toContain("/torrents/requestdl?");
    expect(url).toContain("torrent_id=123");
    expect(url).toContain("file_id=0");
    expect(url).toContain("append_name=true");
    expect(url).toContain("token=k-dl");
  });

  it("sends only the raw file id when given a composite <transfer>:<file> id", async () => {
    const spy = vi.fn(async () => ok("https://x/y.mkv"));
    vi.stubGlobal("fetch", spy);
    await createTorbox(cfg()).resolveFileUrl("123", "123:4");
    expect((spy.mock.calls[0] as unknown as [string])[0]).toContain("file_id=4");
  });

  it("resolves web downloads through web_id", async () => {
    const spy = vi.fn(async () => ok("https://x/web.mkv"));
    vi.stubGlobal("fetch", spy);
    await createTorbox(cfg()).resolveFileUrl("webdl:9", "0");
    const [url] = spy.mock.calls[0] as unknown as [string];
    expect(url).toContain("/webdl/requestdl?");
    expect(url).toContain("web_id=9");
  });
});

describe("torbox: error normalization", () => {
  it.each([
    [401, "auth"],
    [403, "auth"],
    [400, "validation"],
    [422, "validation"],
    [402, "quota"],
    [429, "quota"],
    [500, "transient"],
  ])("maps HTTP %i to a %s DebridError", async (status, kind) => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ success: false, detail: "nope" }, status)));
    const err = await rejection(createTorbox(cfg()).addMagnet(MAGNET));
    expect(isDebridError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe(kind);
  });

  it("reads Retry-After for a quota backoff", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ success: false, detail: "slow down" }, 402, { "retry-after": "30" })),
    );
    const err = await rejection(createTorbox(cfg()).addMagnet(MAGNET));
    expect((err as { kind: string }).kind).toBe("quota");
    expect((err as { retryAfterMs?: number }).retryAfterMs).toBe(30_000);
    expect((err as Error).message).toBe("slow down");
  });

  it("throws an auth error when no key is configured", async () => {
    const tb = createTorbox({ ...defaultConfig });
    expect(tb.isConfigured()).toBe(false);
    const err = await rejection(tb.addMagnet(MAGNET));
    expect((err as { kind: string }).kind).toBe("auth");
  });
});

describe("torbox: checkAuth + checkcached", () => {
  it("returns plan info from /user/me", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok({ email: "a@b.co", plan: 2 })));
    const info = await createTorbox(cfg()).checkAuth();
    expect(info.email).toBe("a@b.co");
    expect(info.plan).toBe("Pro");
    expect(info.premium).toBe(true);
  });

  it("extracts BTIH from magnets and dedupes for the cache CSV", () => {
    const out = cacheCheckHashes([
      `magnet:?xt=urn:btih:${"A".repeat(40)}`,
      "B".repeat(40),
      `magnet:?xt=urn:btih:${"a".repeat(40)}`, // dup of the first, lowercased
      "   ",
    ]);
    expect(out).toEqual(["a".repeat(40), "b".repeat(40)]);
  });

  it("labels cached vs not from the hash-keyed object", async () => {
    const hash = "a".repeat(40);
    const other = "b".repeat(40);
    let captured = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        captured = url;
        return ok({ [hash]: { name: "x" } });
      }),
    );
    const res = await createTorbox(cfg()).checkCached!([
      `magnet:?xt=urn:btih:${hash}`,
      other,
    ]);
    expect(res[hash]).toBe(true);
    expect(res[other]).toBe(false);
    expect(captured).toContain("/torrents/checkcached?");
    expect(captured).toContain("format=object");
    expect(captured).toContain("list_files=false");
    expect(captured).toContain(hash);
    expect(captured).toContain(other);
  });
});
