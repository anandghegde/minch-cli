import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { createRatingsCacheRepository } from "../../src/discovery/ratings/cache-repository";
import {
  createImdbDatasetBackend,
  ensureImdbDataset,
  parseImdbRatings,
} from "../../src/discovery/ratings/imdb-dataset";

async function* lines(values: string[]) { yield* values; }

describe("IMDb dataset", () => {
  it("parses only wanted valid synthetic rows and rejects a bad header", async () => {
    const found = await parseImdbRatings(lines([
      "tconst\taverageRating\tnumVotes",
      "tt9000001\t8.4\t146281",
      "tt9000002\tbad\t2",
      "tt9000001\t9.9\t1",
    ]), new Set(["tt9000001", "tt9000002"]));
    expect(found.get("tt9000001")?.value).toBe(8.4);
    expect(found.has("tt9000002")).toBe(false);
    await expect(parseImdbRatings(lines(["bad"]), new Set(["tt1"]))).rejects.toThrow("header");
  });

  it("downloads atomically and handles a conditional 304", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "minch-imdb-"));
    const file = path.join(directory, "ratings.tsv.gz");
    const repository = createRatingsCacheRepository({ file: path.join(directory, "cache.json") });
    const body = gzipSync("tconst\taverageRating\tnumVotes\ntt9000001\t8.4\t2\n");
    const firstFetch = vi.fn(async () => new Response(body, {
      status: 200,
      headers: { etag: '"rev1"', "content-length": String(body.length) },
    }));
    expect(await ensureImdbDataset({ repository, file, fetchImpl: firstFetch as typeof fetch, now: () => 1 }))
      .toMatchObject({ changed: true, stale: false, etag: '"rev1"' });
    expect((await fs.stat(file)).size).toBe(body.length);
    const secondFetch = vi.fn(async () => new Response(null, { status: 304 }));
    const checked = await ensureImdbDataset({
      repository, file, fetchImpl: secondFetch as typeof fetch,
      now: () => 24 * 60 * 60 * 1_000 + 2,
    });
    expect(checked).toMatchObject({ changed: false, stale: false });
    expect(secondFetch).toHaveBeenCalledOnce();
  });

  it("preserves a last-good file after an interrupted refresh", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "minch-imdb-stale-"));
    const file = path.join(directory, "ratings.tsv.gz");
    await fs.writeFile(file, "last-good");
    const repository = createRatingsCacheRepository({ file: path.join(directory, "cache.json") });
    const result = await ensureImdbDataset({
      repository, file,
      fetchImpl: vi.fn(async () => { throw new Error("offline"); }) as typeof fetch,
      now: () => 10,
    });
    expect(result.stale).toBe(true);
    expect(await fs.readFile(file, "utf8")).toBe("last-good");
  });

  it("rejects oversized responses without installing a partial file", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "minch-imdb-large-"));
    const file = path.join(directory, "ratings.tsv.gz");
    const repository = createRatingsCacheRepository({ file: path.join(directory, "cache.json") });
    await expect(ensureImdbDataset({
      repository, file, maxCompressedBytes: 2,
      fetchImpl: vi.fn(async () => new Response("large", {
        status: 200, headers: { "content-length": "5" },
      })) as typeof fetch,
    })).rejects.toThrow("size limit");
    await expect(fs.access(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("coalesces concurrent sparse IDs and invalidates old-ETag missing entries", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "minch-imdb-scan-"));
    const file = path.join(directory, "ratings.tsv.gz");
    await fs.writeFile(file, gzipSync([
      "tconst\taverageRating\tnumVotes",
      "tt9000001\t8.4\t146281",
      "tt9000002\t7.1\t42",
      "",
    ].join("\n")));
    const repository = createRatingsCacheRepository({ file: path.join(directory, "cache.json") });
    await repository.setDataset({ etag: "new-etag", downloadedAt: 10, checkedAt: 10 });
    await repository.putMissing("tt9000002", {
      checkedAt: 10, expiresAt: 10_000, datasetEtag: "old-etag",
    });
    const backend = createImdbDatasetBackend({ repository, file, now: () => 20 });
    const [first, second] = await Promise.all([
      backend.lookup(["tt9000001"]),
      backend.lookup(["tt9000002"]),
    ]);
    expect(first.get("tt9000001")?.value).toBe(8.4);
    expect(second.get("tt9000002")?.value).toBe(7.1);
    expect(await repository.getMissing("tt9000002")).toBeUndefined();
  });

  it("rejects an aborted scan without emitting an uncaught stream error", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "minch-imdb-abort-"));
    const file = path.join(directory, "ratings.tsv.gz");
    await fs.writeFile(file, gzipSync([
      "tconst\taverageRating\tnumVotes",
      "tt9000001\t8.4\t146281",
      "",
    ].join("\n")));
    const repository = createRatingsCacheRepository({ file: path.join(directory, "cache.json") });
    await repository.setDataset({ downloadedAt: 10, checkedAt: 10 });
    const backend = createImdbDatasetBackend({ repository, file, now: () => 20 });
    const controller = new AbortController();
    const addEventListener = controller.signal.addEventListener.bind(controller.signal);
    const registration = vi.spyOn(controller.signal, "addEventListener").mockImplementation(
      (type, listener, options) => {
        addEventListener(type, listener, options);
        if (type === "abort") queueMicrotask(() => controller.abort());
      },
    );

    await expect(backend.lookup(["tt9999999"], controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    registration.mockRestore();
  });
});
