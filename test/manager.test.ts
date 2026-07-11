import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { DownloadManager, resolveDownloadDir } from "../src/download/manager";
import { defaultConfig, type Config } from "../src/config/config";
import type { DebridProvider, Transfer, TransferFile } from "../src/debrid/types";

// A minimal range server (200/206) backing a fake provider's resolveFileUrl.
async function startServer(body: Buffer): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const range = typeof req.headers.range === "string" ? req.headers.range : undefined;
    res.setHeader("ETag", '"v1"');
    if (!range) {
      res.statusCode = 200;
      res.setHeader("Content-Length", String(body.length));
      res.end(body);
      return;
    }
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = m ? Number(m[1]) : 0;
    const end = m && m[2] !== "" ? Number(m[2]) : body.length - 1;
    const slice = body.subarray(start, end + 1);
    res.statusCode = 206;
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Range", `bytes ${start}-${end}/${body.length}`);
    res.end(slice);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/file.bin`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function file(id: string, name: string, size: number): TransferFile {
  return { id, name, sizeBytes: size, selected: true };
}

function transfer(files: TransferFile[]): Transfer {
  return {
    provider: "torbox",
    id: "t1",
    name: "Some Release",
    sizeBytes: files.reduce((s, f) => s + f.sizeBytes, 0),
    progress: 1,
    status: "done",
    files,
  };
}

function fakeProvider(url: string, filename: string): DebridProvider {
  return {
    id: "torbox",
    label: "TorBox",
    isConfigured: () => true,
    checkAuth: async () => ({}),
    addMagnet: async () => ({}),
    listTransfers: async () => [],
    getTransfer: async () => {
      throw new Error("unused");
    },
    remove: async () => {},
    resolveFileUrl: async () => ({ url, filename }),
  };
}

async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!fn() && Date.now() - start < ms) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

let dir = "";
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "minch-mgr-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("resolveDownloadDir", () => {
  it("prefers the configured directory", () => {
    const cfg: Config = { ...defaultConfig, debrid: { downloadDir: "/tmp/minch-dl" } };
    expect(resolveDownloadDir(cfg)).toBe("/tmp/minch-dl");
  });
  it("falls back to a real directory when unset", () => {
    expect(resolveDownloadDir(defaultConfig)).toBeTruthy();
  });
});

describe("DownloadManager", () => {
  it("runs a download to completion and writes the file", async () => {
    const body = crypto.randomBytes(128 * 1024);
    const server = await startServer(body);
    const manager = new DownloadManager();
    const provider = fakeProvider(server.url, "movie.mkv");
    const t = transfer([file("f1", "movie.mkv", body.length)]);
    try {
      const id = manager.start({ provider, transfer: t, file: t.files[0]!, dir });
      await until(() => manager.get(id)?.status === "done");
      const entry = manager.get(id);
      expect(entry?.status).toBe("done");
      expect(entry?.path).toBe(path.join(dir, "movie.mkv"));
      const onDisk = await fs.readFile(path.join(dir, "movie.mkv"));
      expect(Buffer.compare(onDisk, body)).toBe(0);
      expect(manager.isActive("t1")).toBe(false);
      expect(manager.latestDone("t1")?.id).toBe(id);
    } finally {
      await server.close();
    }
  });

  it("dedupes a second start for the same file while active", async () => {
    const body = crypto.randomBytes(64 * 1024);
    const server = await startServer(body);
    const manager = new DownloadManager();
    const provider = fakeProvider(server.url, "a.bin");
    const t = transfer([file("f1", "a.bin", body.length)]);
    try {
      const id1 = manager.start({ provider, transfer: t, file: t.files[0]!, dir });
      const id2 = manager.start({ provider, transfer: t, file: t.files[0]!, dir });
      expect(id1).toBe(id2);
      await until(() => manager.get(id1)?.status === "done");
      expect(manager.list().filter((e) => e.id === id1)).toHaveLength(1);
    } finally {
      await server.close();
    }
  });

  it("reserves distinct destinations for concurrent same-name downloads", async () => {
    const bodyA = crypto.randomBytes(64 * 1024);
    const bodyB = crypto.randomBytes(64 * 1024);
    const serverA = await startServer(bodyA);
    const serverB = await startServer(bodyB);
    const manager = new DownloadManager(2);
    const providerA = fakeProvider(serverA.url, "movie.mkv");
    const providerB: DebridProvider = { ...fakeProvider(serverB.url, "movie.mkv"), id: "realdebrid" };
    const tA = transfer([file("fa", "movie.mkv", bodyA.length)]);
    const tB: Transfer = {
      ...transfer([file("fb", "movie.mkv", bodyB.length)]),
      provider: "realdebrid",
      id: "t2",
    };
    try {
      const idA = manager.start({ provider: providerA, transfer: tA, file: tA.files[0]!, dir });
      const idB = manager.start({ provider: providerB, transfer: tB, file: tB.files[0]!, dir });
      await until(() => !!manager.get(idA)?.dest && !!manager.get(idB)?.dest);

      expect([manager.get(idA)?.dest, manager.get(idB)?.dest].sort()).toEqual([
        path.join(dir, "movie (1).mkv"),
        path.join(dir, "movie.mkv"),
      ]);
      await until(() => manager.get(idA)?.status === "done" && manager.get(idB)?.status === "done");
      // URL resolution is concurrent, so either transfer may claim the base
      // name first. Assert each entry owns its own bytes, not a race-dependent
      // filename assignment.
      expect(Buffer.compare(await fs.readFile(manager.get(idA)!.dest!), bodyA)).toBe(0);
      expect(Buffer.compare(await fs.readFile(manager.get(idB)!.dest!), bodyB)).toBe(0);
    } finally {
      await serverA.close();
      await serverB.close();
    }
  });

  it("notifies subscribers as state changes", async () => {
    const body = crypto.randomBytes(64 * 1024);
    const server = await startServer(body);
    const manager = new DownloadManager();
    const provider = fakeProvider(server.url, "b.bin");
    const t = transfer([file("f1", "b.bin", body.length)]);
    let notifications = 0;
    const unsub = manager.subscribe(() => notifications++);
    try {
      const id = manager.start({ provider, transfer: t, file: t.files[0]!, dir });
      await until(() => manager.get(id)?.status === "done");
      expect(notifications).toBeGreaterThan(1);
      manager.dismiss(id);
      expect(manager.get(id)).toBeUndefined();
    } finally {
      unsub();
      await server.close();
    }
  });

  // Regression for A1: when the concurrency cap is saturated and a queued
  // download's slot only frees up after another download finishes, it must run
  // against its OWN input (provider/transfer/file) — not the input of the
  // download that just completed (the original pump(input) thread-through bug).
  it("runs each queued download against its own input when a slot frees", async () => {
    const bodyA = crypto.randomBytes(64 * 1024);
    const bodyB = crypto.randomBytes(64 * 1024);
    const serverA = await startServer(bodyA);
    const serverB = await startServer(bodyB);
    // cap=1 so the 2nd start queues until the 1st finishes
    const manager = new DownloadManager(1);
    const calls: string[] = [];
    const providerA: DebridProvider = {
      ...fakeProvider(serverA.url, "a.bin"),
      resolveFileUrl: async (_t, fileId) => {
        calls.push(`A:${fileId}`);
        return { url: serverA.url, filename: "a.bin" };
      },
    };
    const providerB: DebridProvider = {
      ...fakeProvider(serverB.url, "b.bin"),
      id: "realdebrid",
      resolveFileUrl: async (_t, fileId) => {
        calls.push(`B:${fileId}`);
        return { url: serverB.url, filename: "b.bin" };
      },
    };
    const tA = transfer([file("fa", "a.bin", bodyA.length)]);
    const tB: Transfer = {
      ...transfer([file("fb", "b.bin", bodyB.length)]),
      provider: "realdebrid",
      id: "t2",
    };
    try {
      const idA = manager.start({ provider: providerA, transfer: tA, file: tA.files[0]!, dir });
      const idB = manager.start({ provider: providerB, transfer: tB, file: tB.files[0]!, dir });
      await until(() => manager.get(idA)?.status === "done" && manager.get(idB)?.status === "done");
      // B's resolve must target B's file/provider, not A's
      expect(calls).toEqual(["A:fa", "B:fb"]);
      const onA = await fs.readFile(path.join(dir, "a.bin"));
      const onB = await fs.readFile(path.join(dir, "b.bin"));
      expect(Buffer.compare(onA, bodyA)).toBe(0);
      expect(Buffer.compare(onB, bodyB)).toBe(0);
    } finally {
      await serverA.close();
      await serverB.close();
    }
  });
});
