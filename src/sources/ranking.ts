import { detectMediaType, detectQuality } from "./classify";
import type { SearchIntent } from "./intent";
import type { TorrentResult } from "./types";

const QUALITY_SCORE: Record<string, number> = {
  "2160p": 9,
  "1080p": 7,
  "1080i": 5,
  "720p": 4,
  "480p": 1,
};

// Per-source reliability/trust. Native + well-known Cardigann ids get a bump;
// everything else defaults to a neutral 0.6. Only a mild factor (x20) so it
// breaks ties between equally healthy results without burying the broad
// Cardigann catalog that is minch's whole point.
const RELIABILITY: Record<string, number> = {
  yts: 0.9,
  nyaa: 0.9,
  thepiratebay: 0.8,
  solidtorrents: 0.8,
  eztv: 0.85,
  "1337x": 0.8,
  limetorrents: 0.6,
  rutor: 0.7,
  torrent9: 0.6,
  kickasstorrents: 0.6,
  fitgirl: 0.88,
  bitsearch: 0.82,
};
const DEFAULT_RELIABILITY = 0.6;
const TRUSTED_RELIABILITY = 0.8;

function reliabilityOf(source: string): number {
  return RELIABILITY[source] ?? DEFAULT_RELIABILITY;
}

function freshnessScore(added: number | undefined): number {
  if (added === undefined || !Number.isFinite(added) || added <= 0) return 0;
  const ageMs = Date.now() - added * 1000;
  if (!Number.isFinite(ageMs) || ageMs < 0) return 0;
  const days = ageMs / 86_400_000;
  if (days < 7) return 6;
  if (days < 30) return 4;
  if (days < 365) return 2;
  return 0;
}

function isSuspicious(title: string): boolean {
  return /\.(exe|scr|bat)\b/i.test(title) || /\b(password|crack only|keygen only)\b/i.test(title);
}

/**
 * Multi-factor relevance score for a single result, given the search intent.
 * Adapted from TorrentX's ranking-service.ts to minch's TorrentResult shape:
 * quality and media type are derived from the title, freshness from the unix
 * `added` field, and source trust from a reliability map. Region matching is
 * dropped (minch results carry no region). Penalties are softened so dead rows
 * still surface but rank below healthy ones, and broad Cardigann sources aren't
 * buried for being "untrusted".
 */
export function scoreResult(result: TorrentResult, intent: SearchIntent): number {
  const seeders = Math.max(0, result.seeders);
  const leechers = Math.max(0, result.leechers);
  const seedScore = Math.log10(seeders + 1) * 18;
  const peerHealth =
    seeders + leechers > 0 ? (seeders / (seeders + leechers)) * 8 : 0;
  const reliabilityScore = reliabilityOf(result.source) * 20;
  const quality = detectQuality(result.name);
  const qualityScore = quality ? (QUALITY_SCORE[quality] ?? 2) : 0;
  const preferredSource = intent.preferredSources.includes(result.source) ? 10 : 0;
  const mediaType = detectMediaType(result.name);
  const mediaMatch = intent.mediaType && mediaType === intent.mediaType ? 7 : 0;
  const trusted = reliabilityOf(result.source) >= TRUSTED_RELIABILITY ? 5 : 0;
  // Truly dead (no peers at all) is heavily penalized; a freshly added row with
  // leechers but no seeders is only lightly damped.
  const dead = seeders === 0 && leechers === 0 ? -25 : seeders === 0 ? -8 : 0;
  const suspicious = isSuspicious(result.name) ? -20 : 0;
  const freshness = freshnessScore(result.added);

  return Number(
    (
      seedScore +
      peerHealth +
      reliabilityScore +
      qualityScore +
      preferredSource +
      mediaMatch +
      trusted +
      freshness +
      dead +
      suspicious
    ).toFixed(2),
  );
}

/** Rank results by relevance score (desc), tie-broken by seeders (desc). */
export function rankResults(
  results: TorrentResult[],
  intent: SearchIntent,
): TorrentResult[] {
  return results
    .slice()
    .sort(
      (a, b) => scoreResult(b, intent) - scoreResult(a, intent) || b.seeders - a.seeders,
    );
}
