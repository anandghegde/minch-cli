import { afterEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { serializeWrites, writeJsonAtomic } from "../src/util/atomic";

let tempDir: string | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("serializeWrites", () => {
  it("rejects the failed task but continues processing later tasks", async () => {
    const writes = serializeWrites();
    const failed = writes(async () => {
      throw new Error("disk full");
    });
    const completed = writes(async () => {});

    await expect(failed).rejects.toThrow("disk full");
    await expect(completed).resolves.toBeUndefined();
    await expect(writes.flush()).resolves.toBeUndefined();
  });
});

describe("writeJsonAtomic", () => {
  it("creates the temporary credentials file owner-only before rename", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "minch-atomic-"));
    const file = path.join(tempDir, "config.json");
    const originalRename = fs.rename;
    const rename = vi.spyOn(fs, "rename");
    let tempMode: number | undefined;
    rename.mockImplementationOnce(async (from, to) => {
      tempMode = (await fs.stat(from)).mode & 0o777;
      await originalRename(from, to);
    });

    await writeJsonAtomic(file, { token: "secret" }, { mode: 0o600 });

    expect(tempMode).toBe(0o600);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it("removes the temp file when rename fails", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "minch-atomic-"));
    const file = path.join(tempDir, "config.json");
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("rename failed"));

    await expect(writeJsonAtomic(file, { token: "secret" }, { mode: 0o600 }))
      .rejects.toThrow("rename failed");
    await expect(fs.access(`${file}.tmp`)).rejects.toThrow();
  });
});
