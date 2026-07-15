import type { CatalogRating, RatingProvider, RatingSystem } from "../types";

const SYSTEMS = new Set<RatingSystem>(["imdb", "tmdb", "aggregate"]);
const PROVIDERS = new Set<RatingProvider>([
  "imdb-dataset",
  "mdblist",
  "tmdb",
  "streaming-availability",
]);

export function ratingKey(rating: CatalogRating): string {
  return `${rating.system}:${rating.provider}`;
}

/** Validate and detach a rating received from any cache or provider boundary. */
export function normalizeRating(rating: CatalogRating): CatalogRating | undefined {
  if (!rating || !SYSTEMS.has(rating.system) || !PROVIDERS.has(rating.provider)) return undefined;
  if (rating.scale !== 10 && rating.scale !== 100) return undefined;
  if (!Number.isFinite(rating.value) || rating.value < 0 || rating.value > rating.scale) return undefined;
  if (!Number.isFinite(rating.observedAt) || rating.observedAt < 0) return undefined;
  if (rating.voteCount !== undefined &&
      (!Number.isInteger(rating.voteCount) || rating.voteCount < 0)) return undefined;
  if ((rating.provider === "imdb-dataset" || rating.provider === "mdblist") &&
      rating.system !== "imdb") return undefined;
  if (rating.provider === "tmdb" && rating.system !== "tmdb") return undefined;
  if (rating.provider === "streaming-availability" && rating.system !== "aggregate") {
    return undefined;
  }
  return {
    system: rating.system,
    provider: rating.provider,
    value: rating.value,
    scale: rating.scale,
    ...(rating.voteCount !== undefined ? { voteCount: rating.voteCount } : {}),
    observedAt: rating.observedAt,
  };
}

export function formatRatingValue(rating: CatalogRating): number {
  return rating.scale === 100 ? rating.value / 10 : rating.value;
}

const PRIORITY: Readonly<Record<RatingProvider, number>> = {
  "imdb-dataset": 0,
  mdblist: 1,
  tmdb: 2,
  "streaming-availability": 3,
};

export function selectPreferredRating(
  ratings: readonly CatalogRating[],
): CatalogRating | undefined {
  return ratings
    .flatMap((rating) => {
      const normalized = normalizeRating(rating);
      return normalized ? [normalized] : [];
    })
    .sort((left, right) =>
      PRIORITY[left.provider] - PRIORITY[right.provider] ||
      right.observedAt - left.observedAt)[0];
}

/** Merge ratings by system/provider, retaining the newest observation. */
export function mergeRatings(
  ...groups: readonly (readonly CatalogRating[] | undefined)[]
): CatalogRating[] {
  const merged = new Map<string, CatalogRating>();
  for (const rating of groups.flatMap((group) => group ?? [])) {
    const normalized = normalizeRating(rating);
    if (!normalized) continue;
    const key = ratingKey(normalized);
    const existing = merged.get(key);
    if (!existing || normalized.observedAt > existing.observedAt) merged.set(key, normalized);
  }
  return [...merged.values()].sort((left, right) =>
    PRIORITY[left.provider] - PRIORITY[right.provider] ||
    left.provider.localeCompare(right.provider));
}
