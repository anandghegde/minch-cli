import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRealDebrid, mapStatus, mapTransfer } from "../src/debrid/realdebrid";
import { isDebridError } from "../src/debrid/types";
import { defaultConfig, type Config } from "../src/config/config";

const BTIH = "deadbeef".repeat(5); // 40 hex chars
const MAGNET = `magnet:?xt=urn:btih:${BTIH}`;

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A 204 No Content (selectFiles / delete success). */
function noContent(status = 204): Response {
  return new Response(null, { status });
}

function cfg(token = "rd_test_token_1234"): Config {
  return { ...defaultConfig, debrid: { realdebrid: { token } } };
}

/** Build an RD provider with an instant (no-op) poll delay for tests. */
function rd(token?: string) {
  return createRealDebrid(cfg(token), { sleep: async () => {} });
}

async function rejection<T>(p: Promise<T>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error("expected rejection");
    },
    (e) => e,
  );
}

const PREMIUM_USER = { id: 1, username: "u", email: "a@b.co", type: "premium", premium: 1000 };

/**
 * Route RD requests by method + path so each test only specifies the responses
 * it cares about. `info` may be a function to return changing poll responses.
 */
function rdStub(routes: {
  user?: unknown;
  addMagnet?: Response;
  addTorrent?: Response;
  info?: (n: number) => Response;
  selectFiles?: Response;
  unrestrict?: Response;
  torrents?: Response;
  del?: Response;
}): { spy: ReturnType<typeof vi.fn>; calls: { method: string; url: string }[] } {
  let infoCount = 0;
  const calls: { method: string; url: string }[] = [];
  const spy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url });
    if (url.endsWith("/user")) return jsonResponse(routes.user ?? PREMIUM_USER);
    if (url.includes("/torrents/addMagnet"))
      return routes.addMagnet ?? jsonResponse({ id: "RDID", uri: "x" }, 201);
    if (url.includes("/torrents/addTorrent"))
      return routes.addTorrent ?? jsonResponse({ id: "RDID", uri: "x" }, 201);
    if (url.includes("/torrents/selectFiles/"))
      return routes.selectFiles ?? noContent();
    if (url.includes("/torrents/info/"))
      return routes.info ? routes.info(infoCount++) : jsonResponse({});
    if (url.includes("/torrents/delete/")) return routes.del ?? noContent();
    if (url.includes("/unrestrict/link"))
      return routes.unrestrict ?? jsonResponse({ download: "https://d/f.mkv" });
    if (url.includes("/torrents")) return routes.torrents ?? jsonResponse([]);
    return jsonResponse({});
  });
  return { spy, calls };
}

beforeEach(() => {
  delete process.env.MINCH_RD_TOKEN;
});
afterEach(() => vi.unstubAllGlobals());

describe("realdebrid: add → poll → selectFiles orchestration", () => {
  it("posts the magnet form-urlencoded, polls, then ALWAYS selects all files", async () => {
    const { spy, calls } = rdStub({
      // magnet_conversion first, then files appear → ready to select.
      info: (n) =>
        n === 0
          ? jsonResponse({ id: "RDID", status: "magnet_conversion", files: [] })
          : jsonResponse({
              id: "RDID",
              status: "waiting_files_selection",
              files: [{ id: 1, path: "/a.mkv", bytes: 10, selected: 0 }],
            }),
    });
    vi.stubGlobal("fetch", spy);

    const res = await rd().addMagnet(MAGNET, { name: "Movie" });
    expect(res.id).toBe("RDID");

    // addMagnet request: urlencoded body + bearer auth.
    const add = calls.find((c) => c.url.includes("/torrents/addMagnet"));
    expect(add?.method).toBe("POST");
    const addInit = spy.mock.calls.find(([u]) =>
      String(u).includes("/torrents/addMagnet"),
    )![1] as RequestInit;
    expect((addInit.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    expect((addInit.headers as Record<string, string>).Authorization).toBe(
      "Bearer rd_test_token_1234",
    );
    expect(addInit.body).toBe(`magnet=${encodeURIComponent(MAGNET)}`);

    // selectFiles is always called with files=all.
    const select = spy.mock.calls.find(([u]) =>
      String(u).includes("/torrents/selectFiles/RDID"),
    )!;
    expect((select[1] as RequestInit).body).toBe("files=all");
    // Ordering: addMagnet precedes at least one info poll precedes selectFiles.
    const order = calls.map((c) => c.url);
    const addIdx = order.findIndex((u) => u.includes("/addMagnet"));
    const selIdx = order.findIndex((u) => u.includes("/selectFiles/"));
    const infoIdx = order.findIndex((u) => u.includes("/info/"));
    expect(addIdx).toBeLessThan(infoIdx);
    expect(infoIdx).toBeLessThan(selIdx);
  });

  it("uploads .torrent bytes via PUT, then selects all files", async () => {
    const { spy, calls } = rdStub({
      addTorrent: jsonResponse({ id: "T2", uri: "x" }, 201),
      info: () =>
        jsonResponse({
          id: "T2",
          status: "waiting_files_selection",
          files: [{ id: 1, path: "/a.mkv", bytes: 1, selected: 0 }],
        }),
    });
    vi.stubGlobal("fetch", spy);

    const bytes = new Uint8Array([1, 2, 3, 4]);
    const res = await rd().addTorrentFile!(bytes, "My Torrent", { name: "Movie" });
    expect(res.id).toBe("T2");

    const put = spy.mock.calls.find(([u]) =>
      String(u).includes("/torrents/addTorrent"),
    )!;
    expect((put[1] as RequestInit).method).toBe("PUT");
    expect((put[1] as RequestInit).body).toBe(bytes);
    expect(calls.some((c) => c.url.includes("/torrents/selectFiles/T2"))).toBe(true);
  });

  it("aborts the add when the magnet conversion errors", async () => {
    const { spy } = rdStub({
      info: () => jsonResponse({ id: "RDID", status: "magnet_error", files: [] }),
    });
    vi.stubGlobal("fetch", spy);
    const err = await rejection(rd().addMagnet(MAGNET));
    expect(isDebridError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe("validation");
    // selectFiles must NOT be called on a failed conversion.
    expect(
      spy.mock.calls.some(([u]) => String(u).includes("/selectFiles/")),
    ).toBe(false);
  });
});

describe("realdebrid: premium gating", () => {
  it("refuses the hand-off for a non-premium account with a clear message", async () => {
    const { spy } = rdStub({ user: { type: "free", email: "f@b.co" } });
    vi.stubGlobal("fetch", spy);
    const err = await rejection(rd().addMagnet(MAGNET));
    expect(isDebridError(err)).toBe(true);
    expect((err as Error).message).toMatch(/premium/i);
    // Never reaches addMagnet/selectFiles when not premium.
    expect(spy.mock.calls.some(([u]) => String(u).includes("/addMagnet"))).toBe(false);
  });

  it("checkAuth reports premium from a fixture /user response", async () => {
    vi.stubGlobal("fetch", rdStub({ user: PREMIUM_USER }).spy);
    const info = await rd().checkAuth();
    expect(info.email).toBe("a@b.co");
    expect(info.plan).toBe("Premium");
    expect(info.premium).toBe(true);
  });

  it("checkAuth reports free accounts as not premium", async () => {
    vi.stubGlobal("fetch", rdStub({ user: { type: "free", email: "f@b.co" } }).spy);
    const info = await rd().checkAuth();
    expect(info.plan).toBe("Free");
    expect(info.premium).toBe(false);
  });
});

describe("realdebrid: status + progress mapping", () => {
  it("maps every documented status onto a normalized status", () => {
    expect(mapStatus("downloaded")).toBe("done");
    expect(mapStatus("downloading")).toBe("downloading");
    expect(mapStatus("compressing")).toBe("downloading");
    expect(mapStatus("uploading")).toBe("downloading");
    expect(mapStatus("queued")).toBe("queued");
    expect(mapStatus("magnet_conversion")).toBe("queued");
    expect(mapStatus("waiting_files_selection")).toBe("needs_selection");
    expect(mapStatus("error")).toBe("error");
    expect(mapStatus("virus")).toBe("error");
    expect(mapStatus("dead")).toBe("error");
    expect(mapStatus("magnet_error")).toBe("error");
    expect(mapStatus("something")).toBe("queued");
    expect(mapStatus(undefined)).toBe("queued");
  });

  it("converts progress from 0..100 to 0..1 and derives an ETA", () => {
    const t = mapTransfer({
      id: 9,
      filename: "Movie",
      bytes: 1000,
      progress: 50,
      status: "downloading",
      speed: 100,
      hash: "HH",
      added: "2024-01-01T00:00:00.000Z",
      files: [{ id: 1, path: "/dir/Movie.mkv", bytes: 1000, selected: 1 }],
    });
    expect(t.provider).toBe("realdebrid");
    expect(t.progress).toBe(0.5);
    expect(t.downloadSpeedBps).toBe(100);
    expect(t.etaSeconds).toBe(5); // 500 bytes remaining / 100 Bps
    expect(t.files[0]!.name).toBe("Movie.mkv");
    expect(t.files[0]!.selected).toBe(true);
    expect(t.addedAt).toBe(Math.floor(Date.parse("2024-01-01T00:00:00.000Z") / 1000));
  });

  it("listTransfers normalizes the /torrents rows", async () => {
    vi.stubGlobal(
      "fetch",
      rdStub({
        torrents: jsonResponse([
          { id: "A", filename: "One", bytes: 10, progress: 100, status: "downloaded" },
          { id: "B", filename: "Two", bytes: 20, progress: 10, status: "downloading", speed: 5 },
        ]),
      }).spy,
    );
    const out = await rd().listTransfers();
    expect(out.map((t) => t.id)).toEqual(["A", "B"]);
    expect(out[0]!.status).toBe("done");
    expect(out[1]!.status).toBe("downloading");
    expect(out[1]!.progress).toBe(0.1);
  });
});

describe("realdebrid: resolveFileUrl", () => {
  it("maps selected files to links in order and unrestricts the chosen one", async () => {
    let unrestrictBody = "";
    const { spy } = rdStub({
      // file id 2 is the SECOND selected file (id 1 is unselected and skipped).
      info: () =>
        jsonResponse({
          id: "RDID",
          status: "downloaded",
          files: [
            { id: 1, path: "/skip.nfo", bytes: 1, selected: 0 },
            { id: 2, path: "/a.mkv", bytes: 10, selected: 1 },
            { id: 3, path: "/b.mkv", bytes: 20, selected: 1 },
          ],
          links: ["https://rd/link-a", "https://rd/link-b"],
        }),
    });
    const spy2 = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/unrestrict/link")) {
        unrestrictBody = String((init as RequestInit).body);
        return jsonResponse({
          download: "https://direct/b.mkv",
          filename: "b.mkv",
          filesize: 20,
        });
      }
      return spy(input, init);
    });
    vi.stubGlobal("fetch", spy2);

    // Resolve the file with id "3" → it is selected index 1 → links[1] (link-b).
    const r = await rd().resolveFileUrl("RDID", "3");
    expect(r.url).toBe("https://direct/b.mkv");
    expect(r.filename).toBe("b.mkv");
    expect(r.sizeBytes).toBe(20);
    expect(unrestrictBody).toBe(`link=${encodeURIComponent("https://rd/link-b")}`);
  });

  it("rejects a file id that is not among the selected files", async () => {
    vi.stubGlobal(
      "fetch",
      rdStub({
        info: () =>
          jsonResponse({
            id: "RDID",
            files: [{ id: 1, path: "/a.mkv", bytes: 1, selected: 1 }],
            links: ["https://rd/link-a"],
          }),
      }).spy,
    );
    const err = await rejection(rd().resolveFileUrl("RDID", "99"));
    expect(isDebridError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe("validation");
  });
});

describe("realdebrid: remove", () => {
  it("issues a DELETE to /torrents/delete/{id}", async () => {
    const { spy, calls } = rdStub({ del: noContent() });
    vi.stubGlobal("fetch", spy);
    await rd().remove("RDID");
    const del = calls.find((c) => c.url.includes("/torrents/delete/RDID"));
    expect(del?.method).toBe("DELETE");
  });
});

describe("realdebrid: error normalization (error_code)", () => {
  it.each([
    [8, "auth"],
    [9, "auth"],
    [34, "quota"],
    [21, "quota"],
    [23, "quota"],
    [5, "quota"],
    [35, "validation"],
    [16, "validation"],
    [30, "validation"],
    [25, "transient"],
  ])("maps error_code %i to a %s DebridError", async (code, kind) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "nope", error_code: code }, 400)),
    );
    // checkAuth hits /user directly, exercising the error path.
    const err = await rejection(rd().checkAuth());
    expect(isDebridError(err)).toBe(true);
    expect((err as { kind: string }).kind).toBe(kind);
  });

  it("falls back to HTTP status when no error_code is present", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "boom" }, 401)));
    const err = await rejection(rd().checkAuth());
    expect((err as { kind: string }).kind).toBe("auth");
    expect((err as Error).message).toBe("boom");
  });

  it("attaches a conservative quota backoff on rate limits", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({ error: "slow", error_code: 34 }, 429)),
    );
    const err = await rejection(rd().checkAuth());
    expect((err as { kind: string }).kind).toBe("quota");
    expect((err as { retryAfterMs?: number }).retryAfterMs).toBe(60_000);
  });

  it("throws an auth error when no token is configured", async () => {
    const provider = createRealDebrid({ ...defaultConfig });
    expect(provider.isConfigured()).toBe(false);
    const err = await rejection(provider.addMagnet(MAGNET));
    expect((err as { kind: string }).kind).toBe("auth");
  });
});
