import type { MediaType } from "./classify";

export type Region =
  | "global"
  | "usa"
  | "india"
  | "japan"
  | "korea"
  | "china"
  | "europe";

export interface SearchIntent {
  /** Query with intent keywords stripped. Falls back to the raw query when
   * every term was an intent keyword, so a bare "anime" still searches for
   * "anime" rather than an empty string. */
  query: string;
  /** minch source ids to boost in ranking for this intent. */
  preferredSources: string[];
  /** Original tokenized terms, for reference. */
  terms: string[];
  mediaType?: MediaType;
  region?: Region;
  language?: string;
}

const MEDIA_ALIASES: Record<string, MediaType> = {
  movie: "movie",
  film: "movie",
  tv: "tv",
  show: "tv",
  series: "tv",
  anime: "anime",
  kdrama: "tv",
  bollywood: "movie",
  game: "game",
  games: "game",
  software: "software",
  documentary: "documentary",
};

const REGION_ALIASES: Record<string, Region> = {
  bollywood: "india",
  indian: "india",
  hindi: "india",
  tamil: "india",
  telugu: "india",
  malayalam: "india",
  kannada: "india",
  bengali: "india",
  punjabi: "india",
  kdrama: "korea",
  korean: "korea",
  jdrama: "japan",
  japanese: "japan",
  cdrama: "china",
  chinese: "china",
  hollywood: "usa",
};

const LANGUAGE_ALIASES = new Set([
  "english",
  "hindi",
  "tamil",
  "telugu",
  "malayalam",
  "kannada",
  "bengali",
  "punjabi",
  "japanese",
  "korean",
  "chinese",
]);

function languageRegion(language: string): Region | undefined {
  const normalized = language.toLowerCase();
  if (
    ["hindi", "tamil", "telugu", "malayalam", "kannada", "bengali", "punjabi"].includes(
      normalized,
    )
  ) {
    return "india";
  }
  if (normalized === "japanese") return "japan";
  if (normalized === "korean") return "korea";
  if (normalized === "chinese") return "china";
  if (normalized === "english") return "global";
  return undefined;
}

/**
 * Infer a search intent from a raw query: detect media type / region / language
 * hints, strip those keywords from the search terms, and pick preferred sources
 * to boost in ranking. Ported from TorrentX's core/query-intelligence.ts, with
 * preferredSources mapped to minch's source ids (note The Pirate Bay is
 * `thepiratebay` here, not `piratebay`).
 */
export function inferSearchIntent(rawQuery: string): SearchIntent {
  const terms = rawQuery.trim().split(/\s+/).filter(Boolean);
  let mediaType: MediaType | undefined;
  let region: Region | undefined;
  let language: string | undefined;
  const queryTerms: string[] = [];

  for (const term of terms) {
    const normalized = term.toLowerCase();
    const mediaAlias = MEDIA_ALIASES[normalized];
    const regionAlias = REGION_ALIASES[normalized];
    const consumesMediaHint = Boolean(mediaAlias && !mediaType);
    const consumesRegionHint = Boolean(regionAlias && !region);
    if (consumesMediaHint) mediaType = mediaAlias;
    if (consumesRegionHint) region = regionAlias;
    const consumesLanguageHint = Boolean(!language && LANGUAGE_ALIASES.has(normalized));
    if (consumesLanguageHint) {
      language = normalized;
      if (!region) region = languageRegion(normalized);
    }

    if (!consumesMediaHint && !consumesRegionHint && !consumesLanguageHint) {
      queryTerms.push(term);
    }
  }

  if (mediaType === "anime") region ??= "japan";
  if (rawQuery.toLowerCase().includes("kdrama")) mediaType ??= "tv";
  if (rawQuery.toLowerCase().includes("bollywood")) mediaType ??= "movie";

  const preferredSources: string[] = [];
  if (mediaType === "anime" || region === "japan" || region === "korea")
    preferredSources.push("nyaa");
  if (mediaType === "movie") preferredSources.push("yts");
  if (mediaType === "tv") preferredSources.push("eztv");
  if (mediaType === "game") preferredSources.push("fitgirl");
  if (region === "india") preferredSources.push("thepiratebay");

  return {
    query: queryTerms.join(" ").trim() || rawQuery.trim(),
    preferredSources,
    terms,
    ...(mediaType ? { mediaType } : {}),
    ...(region ? { region } : {}),
    ...(language ? { language } : {}),
  };
}
