import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  downloadFile,
  planChunks,
  chunkLength,
  parseContentRangeTotal,
  SpeedMeter,
  sanitizeFilename,
  resolveCollision,
  sidecarMatches,
  readSidecar,
  writeSidecar,
  sidecarPath,
  DownloadCanceledError,
  type DownloadProgress,
  type Sidecar,
} from "../src/download/accelerator";

// --- mock range server -----------------------------------------------------

interface ServerOpts {
  /** Ignore Range and always return 200 + the full body. */
  denyRanges?: boolean;
  /** Drop the connection mid-stream on the first real (multi-byte) chunk. */
  dropOnce?: boolean;
  /** Return 403 for the first N non-probe requests (forces reResolve). */
  forbidTimes?: number;
  /** Artificial latency before each response (ms). */
  delayMs?: number;
  etag?: string;
  lastModified?: string;
}

interface MockServer {
  url: string;
  close: () => Promise<void>;
  /** Range strings the server served, excluding the 1-byte probe ("0-0"). */
  dataRanges: string[];
  requests: number;
  maxConcurrent: number;
}

async function startServer(body: Buffer, opts: ServerOpts = {}): Promise<MockServer> {
  let forbid = opts.forbidTimes ?? 0;
  let dropArmed = !!opts.dropOnce;
  const state = { dataRanges: [] as string[], requests: 0, maxConcurrent: 0 };
  let active = 0;

  const server = http.createServer((req, res) => {
    state.requests++;
    active++;
    state.maxConcurrent = Math.max(state.maxConcurrent, active);
    res.on("close", () => {
      active--;
    });

    const range = typeof req.headers.range === "string" ? req.headers.range : undefined;
    const isProbe = range === "bytes=0-0";

    const respond = (): void => {
      if (!isProbe && forbid > 0) {
        forbid--;
        res.statusCode = 403;
        res.end("forbidden");
        return;
      }
      if (opts.etag) res.setHeader("ETag", opts.etag);
      if (opts.lastModified) res.setHeader("Last-Modified", opts.lastModified);

      if (opts.denyRanges || !range) {
        res.statusCode = 200;
        res.setHeader("Content-Length", String(body.length));
        res.end(body);
        return;
      }

      const m = /bytes=(\d+)-(\d*)/.exec(range);
      const startB = m ? Number(m[1]) : 0;
      const endB = m && m[2] !== "" ? Number(m[2]) : body.length - 1;
      if (!isProbe) state.dataRanges.push(`${startB}-${endB}`);
      const slice = body.subarray(startB, endB + 1);
      res.statusCode = 206;
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Range", `bytes ${startB}-${endB}/${body.length}`);
      res.setHeader("Content-Length", String(slice.length));

      if (dropArmed && slice.length > 2) {
        dropArmed = false;
        res.write(slice.subarray(0, Math.floor(slice.length / 2)));
        req.socket.destroy(); // simulate a mid-stream network drop
        return;
      }
      res.end(slice);
    };

    if (opts.delayMs) setTimeout(respond, opts.delayMs);
    else respond();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/file.bin`,
    close: () => new Promise<void>((r) => server.close(() => r())),
    get dataRanges() {
      return state.dataRanges;
    },
    get requests() {
      return state.requests;
    },
    get maxConcurrent() {
      return state.maxConcurrent;
    },
  };
}

const instantSleep = (): Promise<void> => Promise.resolve();

let dir = "";
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "minch-dl-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

// --- pure helpers ----------------------------------------------------------

describe("range math", () => {
  it("splits into inclusive ranges with a correct last chunk", () => {
    const chunks = planChunks(10, 4);
    expect(chunks).toEqual([
      { index: 0, start: 0, end: 3 },
      { index: 1, start: 4, end: 7 },
      { index: 2, start: 8, end: 9 },
    ]);
    expect(chunks.map(chunkLength)).toEqual([4, 4, 2]);
    expect(chunks.reduce((s, c) => s + chunkLength(c), 0)).toBe(10);
  });

  it("handles exact multiples and sub-chunk totals", () => {
    expect(planChunks(8, 4).map(chunkLength)).toEqual([4, 4]);
    expect(planChunks(5, 10)).toEqual([{ index: 0, start: 0, end: 4 }]);
    expect(planChunks(0, 4)).toEqual([]);
  });

  it("parses the total from a Content-Range header", () => {
    expect(parseContentRangeTotal("bytes 0-0/12345")).toBe(12345);
    expect(parseContentRangeTotal("bytes 0-0/*")).toBeUndefined();
    expect(parseContentRangeTotal(null)).toBeUndefined();
  });
});

describe("SpeedMeter (EWMA)", () => {
  it("starts at zero and tracks a steady rate", () => {
    const m = new SpeedMeter(0.5);
    expect(m.sample(0, 1000)).toBe(0);
    const s1 = m.sample(1_000_000, 2000); // 1 MB in 1s
    expect(s1).toBeGreaterThan(0);
    const s2 = m.sample(2_000_000, 3000);
    expect(s2).toBeGreaterThan(0);
    // ETA over remaining bytes at the smoothed rate.
    const eta = m.eta(2_000_000, 4_000_000);
    expect(eta).toBeGreaterThan(0);
    expect(m.eta(0, undefined)).toBeUndefined();
  });
});

describe("filename safety", () => {
  it("strips path components, control and illegal chars", () => {
    expect(sanitizeFilename("a/b\\c.mkv")).toBe("c.mkv");
    expect(sanitizeFilename('a<b>:c|d?.txt')).not.toMatch(/[<>:"|?*]/);
    expect(sanitizeFilename("name...")).toBe("name");
    expect(sanitizeFilename("   ")).toBe("download");
    expect(sanitizeFilename("CON")).toBe("_CON");
  });

  it("resolves collisions with numeric suffixes", async () => {
    await fs.writeFile(path.join(dir, "f.txt"), "a");
    const first = await resolveCollision(dir, "f.txt");
    expect(path.basename(first)).toBe("f (1).txt");
    await fs.writeFile(first, "b");
    const second = await resolveCollision(dir, "f.txt");
    expect(path.basename(second)).toBe("f (2).txt");
  });
});

describe("resume sidecar", () => {
  it("round-trips and validates against a probe", async () => {
    const part = path.join(dir, "x.part");
    const s: Sidecar = {
      version: 1,
      totalBytes: 100,
      chunkSize: 10,
      etag: "v1",
      completedChunks: [0, 1],
    };
    await writeSidecar(part, s);
    expect(await readSidecar(part)).toEqual(s);
    expect(await fs.readFile(sidecarPath(part), "utf8")).toContain('"version":1');

    expect(sidecarMatches(s, { totalBytes: 100, etag: "v1" }, 10)).toBe(true);
    expect(sidecarMatches(s, { totalBytes: 100, etag: "v2" }, 10)).toBe(false); // changed
    expect(sidecarMatches(s, { totalBytes: 999, etag: "v1" }, 10)).toBe(false); // size
    expect(sidecarMatches(s, { totalBytes: 100, etag: "v1" }, 16)).toBe(false); // chunkSize
  });
});

// --- engine integration ----------------------------------------------------

async function sha(buf: Buffer | Uint8Array): Promise<string> {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

describe("downloadFile: multi-connection", () => {
  it("assembles a byte-identical file across parallel workers", async () => {
    const body = crypto.randomBytes(1024 * 1024); // 1 MiB
    const server = await startServer(body, { etag: '"v1"', delayMs: 8 });
    const dest = path.join(dir, "out.bin");
    try {
      const events: DownloadProgress[] = [];
      const res = await downloadFile(server.url, dest, {
        connections: 4,
        chunkSizeBytes: 64 * 1024,
        sleepImpl: instantSleep,
        progressIntervalMs: 5,
        onProgress: (p) => events.push(p),
      });
      expect(res.bytes).toBe(body.length);
      expect(await sha(await fs.readFile(dest))).toBe(await sha(body));
      // Proved parallelism: more than one in-flight range at some point.
      expect(server.maxConcurrent).toBeGreaterThan(1);
      // Cleaned up: no leftover .part or sidecar.
      expect(await exists(`${dest}.part`)).toBe(false);
      expect(await exists(sidecarPath(`${dest}.part`))).toBe(false);
      // Final progress is a done snapshot at 100%.
      expect(events.at(-1)).toMatchObject({ done: true, receivedBytes: body.length });
    } finally {
      await server.close();
    }
  });
});

describe("downloadFile: single-stream fallback", () => {
  it("downloads byte-identical when ranges are unsupported", async () => {
    const body = crypto.randomBytes(200 * 1024);
    const server = await startServer(body, { denyRanges: true });
    const dest = path.join(dir, "out.bin");
    try {
      const events: DownloadProgress[] = [];
      const res = await downloadFile(server.url, dest, {
        connections: 4,
        chunkSizeBytes: 16 * 1024,
        sleepImpl: instantSleep,
        progressIntervalMs: 5,
        onProgress: (p) => events.push(p),
      });
      expect(res.bytes).toBe(body.length);
      expect(await sha(await fs.readFile(dest))).toBe(await sha(body));
      // Never issued a real range request (no 206 path).
      expect(server.dataRanges).toEqual([]);
      expect(events.at(-1)).toMatchObject({ done: true, receivedBytes: body.length });
    } finally {
      await server.close();
    }
  });
});

describe("downloadFile: robustness", () => {
  it("retries a segment after a mid-stream drop", async () => {
    const body = crypto.randomBytes(256 * 1024);
    const server = await startServer(body, { dropOnce: true, etag: '"v1"' });
    const dest = path.join(dir, "out.bin");
    try {
      const res = await downloadFile(server.url, dest, {
        connections: 2,
        chunkSizeBytes: 32 * 1024,
        sleepImpl: instantSleep,
      });
      expect(res.bytes).toBe(body.length);
      expect(await sha(await fs.readFile(dest))).toBe(await sha(body));
    } finally {
      await server.close();
    }
  });

  it("re-resolves the URL on a 403 and continues", async () => {
    const body = crypto.randomBytes(256 * 1024);
    const server = await startServer(body, { forbidTimes: 1, etag: '"v1"' });
    const dest = path.join(dir, "out.bin");
    let reResolveCalls = 0;
    try {
      const res = await downloadFile(server.url, dest, {
        connections: 2,
        chunkSizeBytes: 32 * 1024,
        sleepImpl: instantSleep,
        reResolve: async () => {
          reResolveCalls++;
          return server.url; // a fresh, valid link
        },
      });
      expect(res.bytes).toBe(body.length);
      expect(reResolveCalls).toBeGreaterThanOrEqual(1);
      expect(await sha(await fs.readFile(dest))).toBe(await sha(body));
    } finally {
      await server.close();
    }
  });
});

describe("downloadFile: resume", () => {
  it("only fetches the missing ranges from a valid sidecar", async () => {
    const chunkSize = 32 * 1024;
    const body = crypto.randomBytes(chunkSize * 6); // 6 chunks
    const server = await startServer(body, { etag: '"v1"' });
    const dest = path.join(dir, "out.bin");
    const part = `${dest}.part`;
    const chunks = planChunks(body.length, chunkSize);

    // Pre-seed a half-finished download: chunks 0,2,4 already on disk.
    const completed = [0, 2, 4];
    const fh = await fs.open(part, "w+");
    await fh.truncate(body.length);
    for (const i of completed) {
      const c = chunks[i]!;
      await fh.write(body.subarray(c.start, c.end + 1), 0, chunkLength(c), c.start);
    }
    await fh.close();
    await writeSidecar(part, {
      version: 1,
      totalBytes: body.length,
      chunkSize,
      etag: '"v1"',
      completedChunks: completed,
    });

    try {
      const res = await downloadFile(server.url, dest, {
        connections: 3,
        chunkSizeBytes: chunkSize,
        sleepImpl: instantSleep,
      });
      expect(res.bytes).toBe(body.length);
      expect(await sha(await fs.readFile(dest))).toBe(await sha(body));
      // Exactly the missing chunks (1,3,5) were fetched — nothing already done.
      const expected = [1, 3, 5]
        .map((i) => chunks[i]!)
        .map((c) => `${c.start}-${c.end}`)
        .sort();
      expect([...server.dataRanges].sort()).toEqual(expected);
    } finally {
      await server.close();
    }
  });
});

describe("downloadFile: cancellation", () => {
  it("aborts promptly and leaves a resumable .part + sidecar", async () => {
    const chunkSize = 32 * 1024;
    const body = crypto.randomBytes(chunkSize * 8);
    const server = await startServer(body, { etag: '"v1"', delayMs: 15 });
    const dest = path.join(dir, "out.bin");
    const ctrl = new AbortController();
    try {
      const p = downloadFile(server.url, dest, {
        connections: 1,
        chunkSizeBytes: chunkSize,
        sleepImpl: instantSleep,
        progressIntervalMs: 5,
        signal: ctrl.signal,
        onProgress: (prog) => {
          // Abort once at least one full chunk has committed.
          if (prog.receivedBytes > chunkSize) ctrl.abort();
        },
      });
      await expect(p).rejects.toBeInstanceOf(DownloadCanceledError);
      // The partial file and its resume sidecar survive for a later resume.
      expect(await exists(`${dest}.part`)).toBe(true);
      expect(await exists(sidecarPath(`${dest}.part`))).toBe(true);
      // The final file was never produced.
      expect(await exists(dest)).toBe(false);
    } finally {
      await server.close();
    }
  });
});

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
