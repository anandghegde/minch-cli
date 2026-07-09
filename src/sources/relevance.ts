import type { TorrentResult } from "./types";
import {
  cleanTitle,
  parseReleaseName,
  qualityRank,
  trashPenalty,
  type ParsedRelease,
} from "./releasename";
import {
  nameMatchesExclude,
  parseQuery,
  phraseMatch,
  tokenize,
  type ParsedQuery,
} from "./query";

// Re-export tokenize so existing imports from relevance keep working.
export { tokenize } from "./query";
export type { ParsedQuery } from "./query";
export { parseQuery } from "./query";

/**
 * Options for `rankResults` / `filterByRelevance` (Phase C).
 * Defaults keep Phase A/B behavior when omitted.
 */
export interface RankOptions {
  /**
   * Insert `qualityBand` into the cascade after seeder buckets.
   * Text relevance still strictly outranks quality.
   */
  preferQuality?: boolean;
  /**
   * Hide rows with match tier &lt; 2 (Jackett andmatch-style).
   * Soft default keeps tier 0/1 visible but sunk.
   */
  strictAnd?: boolean;
  /** Hide rows with trashPenalty &gt; 0 (CAM/TS/SAMPLE/…). */
  hideTrash?: boolean;
}

/**
 * Query-text relevance ranking for keyword search.
 *
 * Mirrors the spirit of Jackett's `andmatch` (token presence) and Sonarr's
 * seeder bucketing, without removing non-matching rows — those sink so browse-
 * style noise never hides results the indexer returned.
 *
 * Cascade (Phase A–C):
 *   tier → yearBoost → episodeBoost → textScore → trashPenalty↑
 *   → [qualityBand if preferQuality] → logSeeders → sizeScore → added
 *
 * When `preferQuality` is true, quality sits *before* seeder buckets so a
 * low-seed Remux can beat a high-seed 480p of the same title. Text still
 * strictly outranks quality. (Alternative — quality after seeds — only
 * breaks same-bucket ties; less useful as a user preference.)
 *
 * Tier 3 = all must tokens + all quoted phrases satisfied.
 * Exclude operators (`-word` / `!word`) filter matching rows out.
 * `strictAnd` / `hideTrash` optionally hide (not just sink) weak/trash rows.
 *
 * Kept free of imports from search.ts so sort/quality can depend on this module
 * without a circular dependency.
 */

function tokenEqualsOrPrefix(nameTok: string, queryTok: string): boolean {
  return (
    nameTok === queryTok ||
    (queryTok.length >= 3 && nameTok.startsWith(queryTok))
  );
}

/**
 * Score a release name against pre-tokenized query terms (and optional phrases).
 *
 * - tier 3: every must token present AND every phrase contiguous
 * - tier 2: every must token present (phrases missing or none required)
 * - tier 1: some must tokens (or some phrase signal)
 * - tier 0: none
 *
 * `score` rewards coverage, contiguous/leading runs, signal-to-noise,
 * cleaned-title similarity, and phrase hits. Supports glued tokens
 * (`spider man` ↔ `spiderman`).
 */
export function matchScore(
  name: string,
  tokens: string[],
  phrases: string[][] = [],
): { tier: 0 | 1 | 2 | 3; score: number } {
  const nameTokens = tokenize(name);
  const hasMust = tokens.length > 0;
  const hasPhrases = phrases.length > 0;

  if (!hasMust && !hasPhrases) return { tier: 0, score: 0 };
  if (nameTokens.length === 0) return { tier: 0, score: 0 };

  // --- must-token matching (same as Phase A, with glue) --------------------
  const used = new Array<boolean>(nameTokens.length).fill(false);
  const positions: number[] = [];
  let matched = 0;
  let qi = 0;

  while (qi < tokens.length) {
    let found = -1;
    let querySpan = 1;
    let nameSpan = 1;
    const qt = tokens[qi]!;

    // 1) Exact single-token match.
    for (let i = 0; i < nameTokens.length; i++) {
      if (used[i]) continue;
      if (nameTokens[i] === qt) {
        found = i;
        break;
      }
    }

    // 2) Glued query tokens → one name token.
    if (found < 0) {
      for (let span = tokens.length - qi; span >= 2; span--) {
        const glued = tokens.slice(qi, qi + span).join("");
        for (let i = 0; i < nameTokens.length; i++) {
          if (used[i]) continue;
          if (nameTokens[i] === glued) {
            found = i;
            querySpan = span;
            break;
          }
        }
        if (found >= 0) break;
      }
    }

    // 3) One query token → consecutive name tokens.
    if (found < 0) {
      for (let i = 0; i < nameTokens.length; i++) {
        if (used[i]) continue;
        let joined = nameTokens[i]!;
        for (let j = i + 1; j < nameTokens.length; j++) {
          if (used[j]) break;
          joined += nameTokens[j]!;
          if (joined === qt) {
            found = i;
            nameSpan = j - i + 1;
            break;
          }
          if (joined.length > qt.length) break;
        }
        if (found >= 0) break;
      }
    }

    // 4) Prefix match.
    if (found < 0 && qt.length >= 3) {
      for (let i = 0; i < nameTokens.length; i++) {
        if (used[i]) continue;
        if (nameTokens[i]!.startsWith(qt)) {
          found = i;
          break;
        }
      }
    }

    if (found >= 0) {
      for (let k = 0; k < nameSpan; k++) used[found + k] = true;
      positions.push(found);
      matched += querySpan;
      qi += querySpan;
    } else {
      qi += 1;
    }
  }

  const phrasesHit = phrases.filter((p) => phraseMatch(nameTokens, p)).length;
  const allPhrases = !hasPhrases || phrasesHit === phrases.length;
  const mustFull = !hasMust || matched === tokens.length;
  const mustPartial = hasMust && matched > 0 && matched < tokens.length;
  const mustNone = hasMust && matched === 0;

  let tier: 0 | 1 | 2 | 3 = 0;
  if (mustFull && allPhrases && (hasMust || hasPhrases)) {
    // Full must + all phrases (or phrases-only full match).
    tier = hasPhrases ? 3 : 2;
  } else if (mustFull && hasMust && hasPhrases && !allPhrases) {
    // All free tokens match but a required phrase is missing.
    tier = 2;
  } else if (mustPartial || (phrasesHit > 0 && !allPhrases) || (phrasesHit > 0 && mustNone)) {
    tier = 1;
  } else if (!hasMust && phrasesHit > 0 && !allPhrases) {
    tier = 1;
  } else {
    tier = 0;
  }

  // Phrases-only, all matched → already tier 3 above.
  // Phrases-only, none matched → tier 0.
  if (!hasMust && hasPhrases) {
    if (allPhrases && phrasesHit > 0) tier = 3;
    else if (phrasesHit > 0) tier = 1;
    else tier = 0;
  }

  if (tier === 0 && matched === 0 && phrasesHit === 0) {
    return { tier: 0, score: 0 };
  }

  const tokenDenom = hasMust ? tokens.length : 1;
  const coverage = hasMust ? matched / tokens.length : phrasesHit / phrases.length;
  const phraseCoverage = hasPhrases ? phrasesHit / phrases.length : 1;

  // Longest contiguous run of matched positions in name order.
  positions.sort((a, b) => a - b);
  let maxRun = positions.length > 0 ? 1 : 0;
  let run = 1;
  for (let i = 1; i < positions.length; i++) {
    if (positions[i] === positions[i - 1]! + 1) {
      run += 1;
      if (run > maxRun) maxRun = run;
    } else {
      run = 1;
    }
  }
  const contiguousBonus = maxRun / tokenDenom;
  const leadingBonus = positions.length > 0 && positions[0] === 0 ? 1 : 0;
  const snr =
    (matched + phrasesHit) / Math.max(1, nameTokens.length);

  const simTokens =
    tokens.length > 0
      ? tokens
      : phrases.length > 0
        ? phrases.flat()
        : [];
  const sim = titleSimilarity(name, simTokens);

  const score =
    coverage * 100 +
    phraseCoverage * 30 +
    contiguousBonus * 20 +
    leadingBonus * 15 +
    snr * 10 +
    sim * 25;

  return { tier, score };
}

/**
 * Jaccard-ish overlap of query tokens against cleaned title tokens, with a
 * cheap Levenshtein ratio fallback for short titles (RTN-inspired, no deps).
 */
export function titleSimilarity(name: string, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;
  const titleToks = tokenize(cleanTitle(name));
  if (titleToks.length === 0) return 0;

  let hit = 0;
  const used = new Array<boolean>(titleToks.length).fill(false);
  for (const qt of queryTokens) {
    for (let i = 0; i < titleToks.length; i++) {
      if (used[i]) continue;
      if (tokenEqualsOrPrefix(titleToks[i]!, qt) || titleToks[i] === qt) {
        used[i] = true;
        hit += 1;
        break;
      }
    }
  }
  const jaccard =
    hit / (queryTokens.length + titleToks.length - hit || 1);

  let lev = 0;
  if (queryTokens.length <= 6 && titleToks.length <= 8) {
    const a = queryTokens.join(" ");
    const b = titleToks.join(" ");
    lev = levenshteinRatio(a, b);
  }

  return Math.max(jaccard, lev * 0.85);
}

function levenshteinRatio(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const m = a.length;
  const n = b.length;
  if (m > 64 || n > 64) return 0;
  const prev = new Array<number>(n + 1);
  const cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j]!;
  }
  const dist = prev[n]!;
  return 1 - dist / Math.max(m, n);
}

/** Sonarr-style seeder bucket: log10 of seeders, rounded. */
export function logSeeders(seeders: number): number {
  return Math.round(Math.log10(Math.max(1, seeders)));
}

function yearBoost(queryYear: number | null, nameYear: number | null): number {
  if (queryYear == null) return 0;
  if (nameYear == null) return 0;
  if (nameYear === queryYear) return 1;
  return -1;
}

function episodeBoost(
  qSeason: number | null,
  qEpisode: number | null,
  nameSeason: number | null,
  nameEpisode: number | null,
): number {
  if (qSeason == null || qEpisode == null) return 0;
  if (nameSeason === qSeason && nameEpisode === qEpisode) return 1;
  return 0;
}

/** Ephemeral per-call rank features — never attached to TorrentResult. */
interface RankFeatures {
  r: TorrentResult;
  tier: 0 | 1 | 2 | 3;
  score: number;
  yearBoost: number;
  episodeBoost: number;
  trash: number;
  seeds: number;
  quality: number;
  sizeScore: number;
  added: number;
}

function isEmptyQuery(q: ParsedQuery): boolean {
  return (
    q.must.length === 0 &&
    q.phrases.length === 0 &&
    q.year == null &&
    q.season == null
  );
}

/** Tokens used for matchScore when must is empty but year/S-E is set. */
function matchTokensFor(parsed: ParsedQuery): string[] {
  if (parsed.must.length > 0) return parsed.must;
  if (parsed.year != null) return [String(parsed.year)];
  if (parsed.season != null && parsed.episode != null) {
    return [
      `s${String(parsed.season).padStart(2, "0")}e${String(parsed.episode).padStart(2, "0")}`,
    ];
  }
  return [];
}

/**
 * Soft size reasonableness for media releases (Phase C4).
 *
 * Only applies when resolution (and optionally source) tags are present so
 * software / ebooks / games without scene tags are never penalized.
 * Returns 0 for normal, −1 for absurdly small/large for the detected res.
 *
 * Feature-film oriented bands (packs may score −1 — intentional soft demotion).
 */
export function sizeReasonableness(
  release: ParsedRelease,
  sizeBytes: number,
): number {
  const res = release.resolution;
  // Media heuristic only when scene-style tags exist.
  if (res == null && release.source == null) return 0;
  if (res == null) return 0;
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return 0;

  const MB = 1_000_000;
  const GB = 1_000_000_000;
  let min: number;
  let max: number;
  if (res >= 2160) {
    min = 1 * GB;
    max = 80 * GB;
  } else if (res >= 1080) {
    min = 300 * MB;
    max = 25 * GB;
  } else if (res >= 720) {
    min = 200 * MB;
    max = 12 * GB;
  } else if (res >= 480) {
    min = 100 * MB;
    max = 4 * GB;
  } else {
    return 0;
  }

  if (sizeBytes < min || sizeBytes > max) return -1;
  return 0;
}

/**
 * Apply optional strict-AND / hide-trash filters without sorting.
 * Used when the user picked a manual sort field but still wants match filters.
 */
export function filterByRelevance(
  list: TorrentResult[],
  query: string,
  opts: RankOptions = {},
): TorrentResult[] {
  const strictAnd = opts.strictAnd === true;
  const hideTrash = opts.hideTrash === true;
  if (!strictAnd && !hideTrash) return list;

  const parsed = parseQuery(query);
  const matchTokens = matchTokensFor(parsed);
  const hasText =
    matchTokens.length > 0 || parsed.phrases.length > 0;

  return list.filter((r) => {
    if (hideTrash && trashPenalty(r.name) > 0) return false;
    if (strictAnd) {
      // Empty/stop-only query: nothing is "strict" — keep all.
      if (!hasText) return true;
      const m = matchScore(r.name, matchTokens, parsed.phrases);
      if (m.tier < 2) return false;
    }
    return true;
  });
}

/**
 * Composite order for keyword search:
 *   1. match tier desc (phrase+must > full AND > partial > none)
 *   2. yearBoost desc
 *   3. episodeBoost desc
 *   4. text score desc
 *   5. trashPenalty asc (clean before CAM)
 *   6. qualityBand desc (only when preferQuality — before seeders)
 *   7. logSeeders desc
 *   8. sizeScore desc (media size reasonableness)
 *   9. added desc (recency)
 *
 * Exclude operators remove matching rows before sort.
 * Empty query falls back to legacy seeders-then-recency order.
 */
export function rankResults(
  list: TorrentResult[],
  query: string,
  opts: RankOptions = {},
): TorrentResult[] {
  const parsed = parseQuery(query);
  const preferQuality = opts.preferQuality === true;
  const strictAnd = opts.strictAnd === true;
  const hideTrash = opts.hideTrash === true;

  if (isEmptyQuery(parsed)) {
    // Still honor hideTrash on empty/browse-style queries when requested.
    const base = hideTrash
      ? list.filter((r) => trashPenalty(r.name) === 0)
      : list;
    return base.slice().sort((a, b) => {
      if (b.seeders !== a.seeders) return b.seeders - a.seeders;
      return (b.added ?? 0) - (a.added ?? 0);
    });
  }

  // B3: excludes are hard filters (user intent), not soft demotion.
  let filtered =
    parsed.exclude.length > 0
      ? list.filter((r) => !nameMatchesExclude(r.name, parsed.exclude))
      : list;

  const matchTokens = matchTokensFor(parsed);

  const scored: RankFeatures[] = [];
  for (const r of filtered) {
    const trash = trashPenalty(r.name);
    if (hideTrash && trash > 0) continue;

    const m = matchScore(r.name, matchTokens, parsed.phrases);
    if (strictAnd && m.tier < 2) continue;

    const release = parseReleaseName(r.name);
    scored.push({
      r,
      tier: m.tier,
      score: m.score,
      yearBoost: yearBoost(parsed.year, release.year),
      episodeBoost: episodeBoost(
        parsed.season,
        parsed.episode,
        release.season,
        release.episode,
      ),
      trash,
      seeds: logSeeders(r.seeders),
      quality: preferQuality ? qualityRank(release) : 0,
      sizeScore: sizeReasonableness(release, r.sizeBytes),
      added: r.added ?? 0,
    });
  }

  scored.sort((a, b) => {
    if (b.tier !== a.tier) return b.tier - a.tier;
    if (b.yearBoost !== a.yearBoost) return b.yearBoost - a.yearBoost;
    if (b.episodeBoost !== a.episodeBoost)
      return b.episodeBoost - a.episodeBoost;
    if (b.score !== a.score) return b.score - a.score;
    if (a.trash !== b.trash) return a.trash - b.trash;
    // preferQuality: quality before popularity so Remux beats noisy 480p.
    if (preferQuality && b.quality !== a.quality) return b.quality - a.quality;
    if (b.seeds !== a.seeds) return b.seeds - a.seeds;
    if (b.sizeScore !== a.sizeScore) return b.sizeScore - a.sizeScore;
    return b.added - a.added;
  });

  return scored.map((s) => s.r);
}
