/**
 * Query language for keyword search (Phase B).
 *
 * Syntax (bitmagnet-inspired, forgiving):
 *   word          required AND token
 *   "exact phrase" contiguous ordered tokens (stop words kept)
 *   -word / !word exclude (name must not contain token)
 *   19xx/20xx     also sets year preference
 *   SxxEyy / NxNN also sets season/episode preference
 *
 * Unclosed quotes: treat the remainder as a phrase (no throw).
 */

const STOP_WORDS = new Set(["a", "an", "and", "of", "the", "or", "to"]);

/** Private-use char used to protect dotted version numbers through the splitter. */
const VERSION_DOT = "\uE000";

const RE_YEAR_TOKEN = /^(?:19|20)\d{2}$/;
const RE_SE_QUERY =
  /\b[Ss](\d{1,2})[Ee](\d{1,3})\b|\b(\d{1,2})x(\d{1,3})\b/g;
const RE_SE_TOKEN = /^s(\d{1,2})e(\d{1,3})$|^(\d{1,2})x(\d{1,3})$/i;

export interface ParsedQuery {
  /** Required AND tokens (unquoted free text). */
  must: string[];
  /** Ordered phrase token lists from "..." (stop words kept). */
  phrases: string[][];
  /** Tokens that must not appear in the name. */
  exclude: string[];
  year: number | null;
  season: number | null;
  episode: number | null;
}

const EMPTY_QUERY: ParsedQuery = {
  must: [],
  phrases: [],
  exclude: [],
  year: null,
  season: null,
  episode: null,
};

function sanitize(text: string): string {
  return text
    .toLowerCase()
    // Apostrophes collapse so possessives match (Zoey's ≡ Zoeys).
    .replace(/[''`´']/g, "")
    // Dashes / en-dashes / em-dashes become separators (not glued tokens).
    .replace(/[\u2010-\u2015\u2212-]+/g, " ")
    // Keep dotted versions (24.04, 1.2.3) as single tokens through the split.
    .replace(/\d+(?:\.\d+)+/g, (m) => m.replace(/\./g, VERSION_DOT));
}

function splitTokens(sanitized: string): string[] {
  return sanitized
    .split(/[^\p{L}\p{N}\uE000]+/u)
    .map((t) => t.replace(new RegExp(VERSION_DOT, "g"), "."))
    .filter((t) => t.length > 1);
}

/**
 * Lowercase, strip apostrophes, turn dashes into separators, keep dotted
 * version numbers whole, split on non-word chars, drop stop words and 1-char
 * tokens. Used for free-text (must) tokens and release-name tokenization.
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  return splitTokens(sanitize(text)).filter((t) => !STOP_WORDS.has(t));
}

/**
 * Like tokenize, but keeps stop words — used for explicit "quoted phrases".
 */
export function tokenizePhrase(text: string): string[] {
  if (!text) return [];
  return splitTokens(sanitize(text));
}

function extractSeasonEpisode(raw: string): {
  season: number | null;
  episode: number | null;
} {
  let season: number | null = null;
  let episode: number | null = null;
  RE_SE_QUERY.lastIndex = 0;
  let seMatch: RegExpExecArray | null;
  while ((seMatch = RE_SE_QUERY.exec(raw)) !== null) {
    if (seMatch[1] != null && seMatch[2] != null) {
      season = Number(seMatch[1]);
      episode = Number(seMatch[2]);
    } else if (seMatch[3] != null && seMatch[4] != null) {
      season = Number(seMatch[3]);
      episode = Number(seMatch[4]);
    }
  }
  return { season, episode };
}

function isTokenBoundary(raw: string, index: number): boolean {
  return index === 0 || /\s/.test(raw.charAt(index - 1));
}

/**
 * Parse a raw search string into structured must/phrase/exclude + year/S-E hints.
 */
export function parseQuery(raw: string): ParsedQuery {
  if (!raw || !raw.trim()) return { ...EMPTY_QUERY };

  const phrases: string[][] = [];
  const exclude: string[] = [];
  const freeChunks: string[] = [];

  let i = 0;
  let free = "";

  const flushFree = () => {
    if (free.trim()) freeChunks.push(free);
    free = "";
  };

  while (i < raw.length) {
    const c = raw.charAt(i);

    // Quoted phrase (unclosed → rest of string is the phrase).
    if (c === '"') {
      flushFree();
      i += 1;
      let phraseRaw = "";
      while (i < raw.length && raw.charAt(i) !== '"') {
        phraseRaw += raw.charAt(i);
        i += 1;
      }
      if (i < raw.length && raw.charAt(i) === '"') i += 1;
      const pt = tokenizePhrase(phraseRaw);
      if (pt.length > 0) phrases.push(pt);
      continue;
    }

    // Exclude: -word or !word only at a token boundary (not spider-man).
    if (
      (c === "-" || c === "!") &&
      isTokenBoundary(raw, i) &&
      i + 1 < raw.length
    ) {
      const next = raw.charAt(i + 1);
      if (next && !/\s/.test(next) && next !== "-" && next !== "!" && next !== '"') {
        flushFree();
        i += 1; // skip - or !
        let term = "";
        while (i < raw.length) {
          const ch = raw.charAt(i);
          if (/\s/.test(ch) || ch === '"') break;
          term += ch;
          i += 1;
        }
        const et = tokenize(term);
        if (et.length > 0) {
          for (const t of et) exclude.push(t);
        } else if (term.length > 1) {
          // Fallback for odd tokens tokenize would drop.
          exclude.push(term.toLowerCase());
        }
        continue;
      }
    }

    free += c;
    i += 1;
  }
  flushFree();

  const freeText = freeChunks.join(" ");
  const allFreeTokens = tokenize(freeText);

  let year: number | null = null;
  for (const t of allFreeTokens) {
    if (RE_YEAR_TOKEN.test(t)) year = Number(t);
  }
  // Years inside phrases also set the year preference (last wins).
  for (const phrase of phrases) {
    for (const t of phrase) {
      if (RE_YEAR_TOKEN.test(t)) year = Number(t);
    }
  }

  const { season, episode } = extractSeasonEpisode(raw);

  const must = allFreeTokens.filter((t) => {
    if (RE_YEAR_TOKEN.test(t)) return false;
    if (RE_SE_TOKEN.test(t)) return false;
    return true;
  });

  return {
    must,
    phrases,
    exclude: [...new Set(exclude)],
    year,
    season,
    episode,
  };
}

/** True when the name contains any excluded token. */
export function nameMatchesExclude(name: string, exclude: string[]): boolean {
  if (exclude.length === 0) return false;
  const nameTokens = tokenize(name);
  if (nameTokens.length === 0) {
    // Still check raw lowercased contains for safety on odd names.
    const lower = name.toLowerCase();
    return exclude.some((e) => lower.includes(e));
  }
  for (const ex of exclude) {
    for (const nt of nameTokens) {
      if (nt === ex || (ex.length >= 3 && nt.startsWith(ex))) return true;
    }
  }
  return false;
}

/** Whether a phrase appears as contiguous ordered tokens in the name. */
export function phraseMatch(nameTokens: string[], phrase: string[]): boolean {
  if (phrase.length === 0) return true;
  if (nameTokens.length === 0) return false;

  // Contiguous window (exact or query-token prefix of name token).
  for (let i = 0; i <= nameTokens.length - phrase.length; i++) {
    let ok = true;
    for (let j = 0; j < phrase.length; j++) {
      const nt = nameTokens[i + j]!;
      const pt = phrase[j]!;
      if (nt !== pt && !(pt.length >= 3 && nt.startsWith(pt))) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }

  // Glued phrase as a single name token: "spider man" ↔ spiderman
  const glued = phrase.join("");
  if (glued.length > 1 && nameTokens.some((nt) => nt === glued)) return true;

  return false;
}
