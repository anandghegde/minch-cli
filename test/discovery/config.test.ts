import { describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../../src/config/config";
import {
  isDiscoveryAdapterEnabled,
  TMDB_CONFIG_DESCRIPTOR,
  probeTmdbCredential,
  resolveStreamingAvailabilityCredential,
  resolveTmdbCredential,
  STREAMING_AVAILABILITY_CONFIG_DESCRIPTOR,
  withStreamingAvailabilityApiKey,
  withDiscoveryAdapterEnabled,
  withTmdbReadToken,
} from "../../src/discovery/config";

describe("TMDB credential descriptor", () => {
  it("toggles adapters independently without deleting configured credentials", () => {
    const configured = withStreamingAvailabilityApiKey(
      withTmdbReadToken(defaultConfig, "tmdb-token"),
      "streaming-key",
    );
    const tmdbDisabled = withDiscoveryAdapterEnabled(configured, "tmdb", false);
    const bothDisabled = withDiscoveryAdapterEnabled(tmdbDisabled, "bluray", false);

    expect(isDiscoveryAdapterEnabled(bothDisabled, "tmdb")).toBe(false);
    expect(isDiscoveryAdapterEnabled(bothDisabled, "bluray")).toBe(false);
    expect(isDiscoveryAdapterEnabled(bothDisabled, "streaming-availability")).toBe(true);
    expect(bothDisabled.discovery).toMatchObject({
      tmdb: { readToken: "tmdb-token" },
      streamingAvailability: { apiKey: "streaming-key" },
      disabledSources: ["tmdb", "bluray"],
    });

    const enabled = withDiscoveryAdapterEnabled(bothDisabled, "tmdb", true);
    expect(enabled.discovery?.disabledSources).toEqual(["bluray"]);
    expect(enabled.discovery?.tmdb?.readToken).toBe("tmdb-token");
  });

  it("resolves environment before owner-only config and supports clearing config", () => {
    const configured = withTmdbReadToken(defaultConfig, " config-token ");
    expect(resolveTmdbCredential(configured, { TMDB_READ_TOKEN: " env-token " }))
      .toEqual({ token: "env-token", source: "env" });
    expect(resolveTmdbCredential(configured, {}))
      .toEqual({ token: "config-token", source: "config" });
    expect(resolveTmdbCredential(withTmdbReadToken(configured, undefined), {}))
      .toEqual({ source: "none" });
    expect(configured.discovery?.tmdb?.readToken).toBe("config-token");
    expect(defaultConfig.discovery).toBeUndefined();
  });

  it("validates with one body-free authenticated request and never returns the token", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      calls.push({ url: String(input), init });
      return new Response(null, { status: 200 });
    });

    const result = await probeTmdbCredential("super-secret-token", { fetchImpl });

    expect(result).toEqual({ ok: true, code: "ok", status: 200 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(TMDB_CONFIG_DESCRIPTOR.probeUrl);
    expect(new Headers(calls[0]!.init?.headers).get("authorization"))
      .toBe("Bearer super-secret-token");
    expect(JSON.stringify(result)).not.toContain("super-secret-token");
  });

  it("classifies auth, HTTP, and transport failures without exposing bodies or errors", async () => {
    await expect(
      probeTmdbCredential("token", {
        fetchImpl: async () => new Response("token echoed", { status: 401 }),
      }),
    ).resolves.toEqual({ ok: false, code: "unauthorized", status: 401 });
    await expect(
      probeTmdbCredential("token", {
        fetchImpl: async () => new Response("server detail", { status: 503 }),
      }),
    ).resolves.toEqual({ ok: false, code: "http", status: 503 });
    await expect(
      probeTmdbCredential("token", {
        fetchImpl: async () => {
          throw new Error("transport echoed token");
        },
      }),
    ).resolves.toEqual({ ok: false, code: "network" });
  });

  it("resolves only the direct-platform streaming key with environment precedence", () => {
    const configured = withStreamingAvailabilityApiKey(defaultConfig, " config-key ");
    expect(resolveStreamingAvailabilityCredential(configured, {
      STREAMING_AVAILABILITY_API_KEY: " env-key ",
    })).toEqual({ apiKey: "env-key", source: "env" });
    expect(resolveStreamingAvailabilityCredential(configured, {}))
      .toEqual({ apiKey: "config-key", source: "config" });
    expect(
      resolveStreamingAvailabilityCredential(
        withStreamingAvailabilityApiKey(configured, undefined),
        {},
      ),
    ).toEqual({ source: "none" });
    expect(STREAMING_AVAILABILITY_CONFIG_DESCRIPTOR).toMatchObject({
      baseUrl: "https://api.movieofthenight.com/v4",
      headerName: "X-API-Key",
    });
    expect("transport" in STREAMING_AVAILABILITY_CONFIG_DESCRIPTOR).toBe(false);
  });
});
