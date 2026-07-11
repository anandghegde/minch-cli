import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertPhysicalRefreshDue,
  PHYSICAL_REFRESH_NOT_BEFORE_MS,
  refreshPhysicalCache,
} from "../scripts/discovery-physical-refresh";

const FIXTURE = path.join(
  process.cwd(),
  "test/discovery/fixtures/bluray-new-releases.xml",
);

describe("P11.2 scheduled physical evidence refresh", () => {
  it("refuses even one millisecond before the recorded 24-hour boundary", () => {
    expect(() => assertPhysicalRefreshDue(PHYSICAL_REFRESH_NOT_BEFORE_MS - 1))
      .toThrow("not permitted before 2026-07-11T06:11:00.000Z");
    expect(() => assertPhysicalRefreshDue(PHYSICAL_REFRESH_NOT_BEFORE_MS)).not.toThrow();
  });

  it("fetches only Blu-ray RSS once and then respects the 24-hour cache", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "minch-physical-refresh-"));
    const xml = await fs.readFile(FIXTURE, "utf8");
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(xml, {
      status: 200,
      headers: { "Content-Type": "application/rss+xml" },
    }));
    try {
      const first = await refreshPhysicalCache({
        directory,
        now: PHYSICAL_REFRESH_NOT_BEFORE_MS,
        fetchImpl,
      });
      expect(first).toMatchObject({
        status: "refreshed",
        requestAttempts: 1,
        titles: 5,
        events: 5,
        datedEvents: 4,
        uhdBlurayEvents: 1,
        unknownRegionEvents: 5,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);

      const second = await refreshPhysicalCache({
        directory,
        now: PHYSICAL_REFRESH_NOT_BEFORE_MS + 60_000,
        fetchImpl,
      });
      expect(second).toMatchObject({ status: "fresh", requestAttempts: 0 });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await expect(fs.stat(path.join(directory, "discovery-cache.json")))
        .resolves.toMatchObject({ mode: expect.any(Number) });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
