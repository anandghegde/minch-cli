import { describe, expect, it, vi } from "vitest";
import { probeSource } from "../src/sources/health";
import type { Source, TestResult } from "../src/sources/types";

function fakeSource(
  links: string[],
  test: (baseUrl?: string) => Promise<TestResult>,
): Source {
  return {
    id: "fake",
    label: "Fake",
    kind: "html",
    links,
    requiresConfig: false,
    defaultEnabled: true,
    test: (opts) => test(opts?.baseUrl),
    search: async () => [],
  };
}

describe("probeSource mirror fallback", () => {
  it("falls back to a working mirror when the first is down", async () => {
    const links = ["https://a.test/", "https://b.test/", "https://c.test/"];
    const test = vi.fn(async (baseUrl?: string): Promise<TestResult> => {
      if (baseUrl === "https://b.test/")
        return { ok: true, status: "5 results", count: 5 };
      return { ok: false, status: "403", code: "403" };
    });
    const out = await probeSource(fakeSource(links, test), undefined, 1000);
    expect(out.health.ok).toBe(true);
    expect(out.mirror).toBe("https://b.test/");
    // tried a then b, stopped before c
    expect(test).toHaveBeenCalledTimes(2);
  });

  it("tries the preferred mirror first", async () => {
    const links = ["https://a.test/", "https://b.test/"];
    const order: (string | undefined)[] = [];
    const test = vi.fn(async (baseUrl?: string): Promise<TestResult> => {
      order.push(baseUrl);
      return { ok: baseUrl === "https://b.test/", status: "x" };
    });
    const out = await probeSource(fakeSource(links, test), "https://b.test/", 1000);
    expect(out.mirror).toBe("https://b.test/");
    expect(order[0]).toBe("https://b.test/");
    expect(test).toHaveBeenCalledTimes(1);
  });

  it("returns the last failure when no mirror works", async () => {
    const links = ["https://a.test/", "https://b.test/"];
    const test = vi.fn(
      async (): Promise<TestResult> => ({ ok: false, status: "down", code: "503" }),
    );
    const out = await probeSource(fakeSource(links, test), undefined, 1000);
    expect(out.health.ok).toBe(false);
    expect(out.mirror).toBe("https://b.test/");
    expect(test).toHaveBeenCalledTimes(2);
  });

  it("does not retry duplicate preferred/link URLs", async () => {
    const links = ["https://a.test/", "https://b.test/"];
    const test = vi.fn(
      async (): Promise<TestResult> => ({ ok: false, status: "no" }),
    );
    await probeSource(fakeSource(links, test), "https://a.test/", 1000);
    // a (preferred) + b, but not a twice
    expect(test).toHaveBeenCalledTimes(2);
  });
});
