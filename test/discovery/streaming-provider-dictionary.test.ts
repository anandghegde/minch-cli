import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/config/config";
import type { BudgetStatus, RequestLedger } from "../../src/discovery/budget";
import { createDiscoveryCacheRepository } from "../../src/discovery/cache-repository";
import type { DiscoveryRequest } from "../../src/discovery/request";
import { createDiscoveryService } from "../../src/discovery/service";
import {
  createStreamingAvailabilityAdapter,
  parseStreamingCountry,
} from "../../src/discovery/sources/streaming-availability";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/streaming-availability-countries-in.json",
);
const NOW = 1_783_665_832_000;

function rawCountry(): { countryCode: string; name: string; services: unknown[] } {
  return JSON.parse(readFileSync(FIXTURE, "utf8")) as {
    countryCode: string;
    name: string;
    services: unknown[];
  };
}

function ledger() {
  const status: BudgetStatus = {
    source: "streaming-availability",
    endpoint: "countries",
    month: "2026-07",
    used: 1,
    endpointUsed: 1,
    allowed: true,
    warning: false,
    softWarning: 350,
    hardCap: 450,
    remaining: 449,
  };
  return {
    recordAttempt: vi.fn<Pick<RequestLedger, "recordAttempt">["recordAttempt"]>(
      async () => status,
    ),
    canSpend: vi.fn<Pick<RequestLedger, "canSpend">["canSpend"]>(async () => status),
  };
}

function request(): DiscoveryRequest {
  return {
    region: "IN",
    feedKind: "provider_dictionary",
    mediaTypes: [],
    providerIds: [],
    pageLimit: 1,
  };
}

describe("India provider dictionary", () => {
  it("uses live IDs/names, preserving rebrands and unknown services", () => {
    const raw = rawCountry();
    raw.services.push({ id: "future-service", name: "Future Service" }, null);
    const hotstar = raw.services.find(
      (service) => !!service && typeof service === "object" && "id" in service && service.id === "hotstar",
    ) as { id: string; name: string };
    hotstar.name = "Hotstar Rebranded";

    const parsed = parseStreamingCountry(raw);

    expect(parsed.countryCode).toBe("in");
    expect(parsed.providers).toEqual(expect.arrayContaining([
      { id: "hotstar", label: "Hotstar Rebranded", upstreamAliases: ["hotstar", "Hotstar Rebranded"] },
      { id: "future-service", label: "Future Service", upstreamAliases: ["future-service", "Future Service"] },
    ]));
    expect(parsed.warnings).toEqual([
      expect.objectContaining({ code: "malformed-provider" }),
    ]);
  });

  it("fetches India once and serves the dictionary as fresh for 30 days", async () => {
    let now = NOW;
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(rawCountry()), { status: 200 }));
    const repository = createDiscoveryCacheRepository({
      readFile: async () => {
        const error = new Error("missing") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
      writeJson: async () => {},
    });
    const service = createDiscoveryService({ cache: repository, fetchImpl, now: () => now });
    const adapter = createStreamingAvailabilityAdapter({
      config: defaultConfig,
      env: { STREAMING_AVAILABILITY_API_KEY: "key" },
      ledger: ledger(),
      now: () => now,
      retries: 0,
    });

    const first = await service.load(adapter, request());
    now += 29 * 24 * 60 * 60 * 1_000;
    const cached = await service.load(adapter, request());

    expect(first).toMatchObject({
      cacheState: "refreshed",
      snapshot: {
        providers: [
          { id: "netflix", label: "Netflix" },
          { id: "prime", label: "Prime Video" },
          { id: "hotstar", label: "JioHotstar" },
          { id: "zee5", label: "Zee5" },
          { id: "sonyliv", label: "SonyLiv" },
        ],
      },
    });
    expect(cached.cacheState).toBe("fresh");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
