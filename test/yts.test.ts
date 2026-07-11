import { afterEach, describe, expect, it, vi } from "vitest";
import { yts } from "../src/sources/yts";

afterEach(() => vi.unstubAllGlobals());

describe("YTS mirror selection", () => {
  it.each([
    ["search", () => yts.search("dune", { baseUrl: "https://selected.test/" })],
    ["browse", () => yts.browse!({ baseUrl: "https://selected.test/" })],
    ["probe", () => yts.test({ baseUrl: "https://selected.test/" })],
  ])("uses only the selected mirror for %s", async (_action, run) => {
    const fetchImpl = vi.fn(async (_url: string) =>
      new Response(JSON.stringify({ data: { movies: [] } }), {
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchImpl);

    await run();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0]?.[0]).toMatch(/^https:\/\/selected\.test\/api\/v2\//);
  });
});
