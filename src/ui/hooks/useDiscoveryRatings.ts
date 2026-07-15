import { useEffect, useMemo, useState } from "react";
import type { Config } from "../../config/config";
import type { CatalogRating, CatalogTitle } from "../../discovery/types";
import { createRequestLedger } from "../../discovery/budget";
import { resolveMdblistCredential, resolveTmdbCredential } from "../../discovery/config";
import { createTmdbClient, createTmdbEnricher } from "../../discovery/sources/tmdb";
import { createRatingsCacheRepository } from "../../discovery/ratings/cache-repository";
import { createImdbDatasetBackend } from "../../discovery/ratings/imdb-dataset";
import { createRatingIdentityResolver } from "../../discovery/ratings/identity-resolver";
import { createMdblistBackend } from "../../discovery/ratings/mdblist";
import {
  createDiscoveryRatingsService,
  type DiscoveryRatingsResult,
} from "../../discovery/ratings/service";
import { createRatingsUsageLedger } from "../../discovery/ratings/usage";
import { mergeRatings, selectPreferredRating } from "../../discovery/ratings/types";

const repository = createRatingsCacheRepository();
const usage = createRatingsUsageLedger();
const requestLedger = createRequestLedger();
const dataset = createImdbDatasetBackend({ repository });

interface ImdbSuggestionRow {
  id?: unknown;
  l?: unknown;
  qid?: unknown;
  y?: unknown;
}

function imdbSuggestionMediaType(qid: unknown): "movie" | "series" | undefined {
  if (qid === "movie" || qid === "feature") return "movie";
  if (qid === "tvSeries" || qid === "tvMiniSeries" || qid === "tvSpecial") return "series";
  return undefined;
}

export interface DiscoveryRatingsHookResult extends DiscoveryRatingsResult {}

function nativeResult(titles: readonly CatalogTitle[], loading: boolean): DiscoveryRatingsResult {
  const byTitleId = new Map<string, CatalogRating[]>();
  let fallbackCount = 0;
  let unresolvedCount = 0;
  for (const title of titles) {
    const ratings = mergeRatings(title.ratings);
    byTitleId.set(title.id, ratings);
    if (selectPreferredRating(ratings)) fallbackCount += 1;
    else unresolvedCount += 1;
  }
  return { byTitleId, loading, exactCount: 0, fallbackCount, unresolvedCount };
}

export function useDiscoveryRatings(
  config: Config,
  titles: readonly CatalogTitle[],
  active: boolean,
  revision: number,
): DiscoveryRatingsHookResult {
  const provider = config.discovery?.ratingProvider ?? "off";
  const mdblistCredential = resolveMdblistCredential(config);
  const service = useMemo(() => {
    const identities = createRatingIdentityResolver({
      repository,
      enricher: createTmdbEnricher({ config, ledger: requestLedger }),
      searchTitle: async (title, options) => {
        const response = await fetch(
          `https://v3.sg.media-imdb.com/suggestion/x/${encodeURIComponent(title.title)}.json`,
          {
            headers: { accept: "application/json" },
            ...(options.signal ? { signal: options.signal } : {}),
          },
        );
        if (!response.ok) throw new Error(`IMDb suggestion lookup failed (${response.status})`);
        const payload: unknown = await response.json();
        const rows = payload && typeof payload === "object" &&
          Array.isArray((payload as { d?: unknown }).d)
          ? (payload as { d: unknown[] }).d
          : [];
        return rows.flatMap((value) => {
          if (!value || typeof value !== "object") return [];
          const row = value as ImdbSuggestionRow;
          const imdbId = typeof row.id === "string" && /^tt\d+$/.test(row.id) ? row.id : undefined;
          const label = typeof row.l === "string" ? row.l : undefined;
          const mediaType = imdbSuggestionMediaType(row.qid);
          const year = typeof row.y === "number" && Number.isInteger(row.y) ? row.y : undefined;
          return imdbId && label && mediaType ? [{
            imdbId,
            title: label,
            ...(year !== undefined ? { year } : {}),
            mediaType,
          }] : [];
        });
      },
      searchTmdbMovie: async (title, options) => {
        const token = resolveTmdbCredential(config).token;
        if (!token) return [];
        const client = createTmdbClient({
          token,
          fetchImpl: (...args) => fetch(...args),
          ledger: requestLedger,
        });
        const page = await client.getListPages(
          "/search/movie",
          { query: title.title, ...(title.year !== undefined ? { year: title.year } : {}) },
          "ratings-identity-search",
          1,
          options.signal,
        );
        return page.rows.map((row) => ({
          tmdbId: row.id,
          title: row.title,
          ...(row.date && /^\d{4}-/.test(row.date) ? { year: Number(row.date.slice(0, 4)) } : {}),
        }));
      },
    });
    const mdblist = provider === "mdblist" && mdblistCredential.apiKey
      ? createMdblistBackend({ apiKey: mdblistCredential.apiKey, repository, usage })
      : undefined;
    return createDiscoveryRatingsService({ dataset, identities, ...(mdblist ? { mdblist } : {}) });
  }, [config, mdblistCredential.apiKey, provider]);
  const [result, setResult] = useState(() => nativeResult(titles, provider !== "off"));

  useEffect(() => {
    const enrich = active && provider !== "off" &&
      !(provider === "mdblist" && !mdblistCredential.apiKey);
    setResult(nativeResult(titles, enrich));
    if (!enrich || titles.length === 0) return;
    const controller = new AbortController();
    let alive = true;
    void service.load(titles, {
      provider,
      signal: controller.signal,
      onUpdate: (loaded) => {
        if (alive) setResult(loaded);
      },
    }).then((loaded) => {
      if (alive) setResult(loaded);
    }).catch((error: unknown) => {
      if (alive && !controller.signal.aborted) {
        setResult({ ...nativeResult(titles, false), error: error instanceof Error ? error : new Error(String(error)) });
      }
    });
    return () => { alive = false; controller.abort(); };
  }, [active, mdblistCredential.apiKey, provider, revision, service, titles]);
  return result;
}
