import { describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDiscoveryCacheRepository } from "../../src/discovery/cache-repository";
import {
  createDiscoveryCacheEntry,
  discoveryRequestKey,
  type DiscoveryCacheEntry,
} from "../../src/discovery/cache";
import type { DiscoverySnapshot } from "../../src/discovery/adapter";
import type { DiscoveryRequest } from "../../src/discovery/request";

const FETCHED_AT = 1_783_665_832_000;

function request(providerIds: string[] = []): DiscoveryRequest {
  return {
    region: "IN",
    feedKind: "streaming_added",
    dateRange: { start: "2026-06-09", end: "2026-07-10", direction: "past" },
    mediaTypes: ["movie"],
    providerIds,
    pageLimit: 4,
  };
}

function snapshot(id: string): DiscoverySnapshot {
  return {
    source: "streaming-availability",
    titles: [{
      id,
      title: id,
      mediaType: "movie",
      originCountries: [],
      genreIds: [],
    }],
    events: [],
    fetchedAt: FETCHED_AT,
    warnings: [],
  };
}

function entry(provider: string, id: string) {
  return createDiscoveryCacheEntry(
    request([provider]),
    snapshot(id),
    FETCHED_AT + 1_000,
    FETCHED_AT + 2_000,
  );
}

describe("discovery cache repository", () => {
  it("recovers from syntactically corrupt JSON as an empty cache", async () => {
    const repository = createDiscoveryCacheRepository({
      readFile: async () => "{not-json",
      writeJson: async () => {},
    });

    await expect(repository.load()).resolves.toMatchObject({
      document: { version: 1, entries: {} },
      rejectedEntries: [],
      documentError: "cache JSON is invalid",
    });
  });

  it("loads valid peers while retaining independent corruption diagnostics", async () => {
    const valid = entry("netflix", "valid");
    const key = discoveryRequestKey(valid.source, valid.request);
    const repository = createDiscoveryCacheRepository({
      readFile: async () => JSON.stringify({
        version: 1,
        entries: {
          [key]: valid,
          corrupt: { source: "tmdb" },
        },
      }),
      writeJson: async () => {},
    });

    const loaded = await repository.load();
    expect(Object.keys(loaded.document.entries)).toEqual([key]);
    expect(loaded.rejectedEntries).toEqual([
      { key: "corrupt", reason: "invalid cache entry" },
    ]);
    expect(await repository.get(valid.source, valid.request)).toEqual(valid);
  });

  it("rejects cache entries containing credential-shaped fields", async () => {
    const unsafe = entry("netflix", "unsafe") as DiscoveryCacheEntry & {
      apiKey: string;
    };
    unsafe.apiKey = "must-not-survive";
    const key = discoveryRequestKey(unsafe.source, unsafe.request);
    const repository = createDiscoveryCacheRepository({
      readFile: async () => JSON.stringify({
        version: 1,
        entries: { [key]: unsafe },
      }),
      writeJson: async () => {},
    });

    await expect(repository.load()).resolves.toEqual({
      document: { version: 1, entries: {} },
      rejectedEntries: [{ key, reason: "invalid cache entry" }],
    });
  });

  it("coalesces concurrent mutations into one serialized document write", async () => {
    const writes: unknown[] = [];
    const writeJson = vi.fn(async (_file: string, value: unknown) => {
      writes.push(value);
    });
    const repository = createDiscoveryCacheRepository({
      readFile: async () => {
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
      writeJson,
    });

    await Promise.all([
      repository.put(entry("netflix", "one")),
      repository.put(entry("prime", "two")),
    ]);

    expect(writeJson).toHaveBeenCalledTimes(1);
    const written = writes[0] as { entries: Record<string, unknown> };
    expect(Object.keys(written.entries)).toHaveLength(2);
  });

  it("writes the normalized cache owner-only", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "minch-discovery-cache-"));
    const file = path.join(directory, "discovery-cache.json");
    try {
      const repository = createDiscoveryCacheRepository({ file });
      await repository.put(entry("netflix", "private-cache"));

      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("retains dirty state after a failed save and recovers on flush", async () => {
    let attempts = 0;
    const writeJson = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("disk full");
    });
    const repository = createDiscoveryCacheRepository({
      readFile: async () => {
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
      writeJson,
    });

    await expect(repository.put(entry("netflix", "retry"))).rejects.toThrow("disk full");
    await repository.flush();

    expect(writeJson).toHaveBeenCalledTimes(2);
    expect(await repository.get("streaming-availability", request(["netflix"])))
      .toMatchObject({ snapshot: { titles: [{ id: "retry" }] } });
  });
});
