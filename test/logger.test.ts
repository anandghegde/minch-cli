import { promises as fs } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { appLogFile } from "../src/config/paths";
import { flushLogs, logError, logEvent } from "../src/util/logger";

describe("app logger", () => {
  beforeEach(async () => {
    await flushLogs();
    await fs.rm(appLogFile, { force: true });
  });

  it("persists structured events and redacts configured credentials", async () => {
    vi.stubEnv("TMDB_READ_TOKEN", "secret-token");
    logEvent("info", "test.navigation", {
      from: "trending",
      to: "realdebrid",
      detail: "request failed with secret-token",
    });
    await flushLogs();

    const line = (await fs.readFile(appLogFile, "utf8")).trim();
    const entry = JSON.parse(line) as Record<string, unknown>;
    expect(entry).toMatchObject({
      level: "info",
      event: "test.navigation",
      from: "trending",
      to: "realdebrid",
      detail: "request failed with [redacted]",
    });
    expect(entry.timestamp).toEqual(expect.any(String));
    expect(entry.sessionId).toEqual(expect.any(String));
    vi.unstubAllEnvs();
  });

  it("records error type, message, and stack", async () => {
    logError("test.crash", new TypeError("render failed"), { view: "trending" });
    await flushLogs();

    const entry = JSON.parse((await fs.readFile(appLogFile, "utf8")).trim()) as {
      error: Record<string, unknown>;
    };
    expect(entry.error).toMatchObject({ name: "TypeError", message: "render failed" });
    expect(entry.error.stack).toEqual(expect.stringContaining("render failed"));
  });
});
