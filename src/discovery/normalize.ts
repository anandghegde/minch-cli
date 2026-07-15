export interface ProviderDescriptor {
  id: string;
  label: string;
  aliases: readonly string[];
}

export interface NormalizedProvider {
  id: string;
  label: string;
  /** Upstream values observed for diagnostics and later dictionary refreshes. */
  upstreamAliases: string[];
}

const PROVIDERS: readonly ProviderDescriptor[] = [
  { id: "netflix", label: "Netflix", aliases: ["netflix"] },
  { id: "prime", label: "Prime Video", aliases: ["prime", "prime video", "amazon prime", "amazon prime video"] },
  { id: "apple", label: "Apple TV", aliases: ["apple", "apple tv", "apple tv+"] },
  { id: "disney", label: "Disney+", aliases: ["disney", "disney+"] },
  { id: "hbo", label: "Max", aliases: ["hbo", "hbo max", "max"] },
  { id: "paramount", label: "Paramount+", aliases: ["paramount", "paramount+"] },
  { id: "hotstar", label: "JioHotstar", aliases: ["hotstar", "jiohotstar", "jio hotstar", "disney+ hotstar"] },
  { id: "zee5", label: "Zee5", aliases: ["zee5", "zee 5"] },
  { id: "sonyliv", label: "SonyLiv", aliases: ["sonyliv", "sony liv"] },
  { id: "mubi", label: "Mubi", aliases: ["mubi"] },
  { id: "curiosity", label: "Curiosity Stream", aliases: ["curiosity", "curiosity stream"] },
  { id: "crunchyroll", label: "Crunchyroll", aliases: ["crunchyroll"] },
] as const;

function aliasKey(value: string | number): string {
  return String(value)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

const PROVIDER_BY_ALIAS = new Map<string, ProviderDescriptor>();
for (const provider of PROVIDERS) {
  for (const alias of [provider.id, provider.label, ...provider.aliases]) {
    PROVIDER_BY_ALIAS.set(aliasKey(alias), provider);
  }
}

function distinctAliases(values: (string | number | undefined)[]): string[] {
  return [...new Set(values
    .filter((value) => value !== undefined)
    .map((value) => cleanText(String(value)))
    .filter(Boolean))];
}

/**
 * Normalize a live dictionary ID/name pair. Unknown providers remain visible
 * under their upstream ID/label instead of being guessed as a known service.
 */
export function normalizeProvider(
  upstreamId: string | number | undefined,
  upstreamLabel?: string,
): NormalizedProvider | undefined {
  const aliases = distinctAliases([upstreamId, upstreamLabel]);
  if (aliases.length === 0) return undefined;
  const known = aliases
    .map((alias) => PROVIDER_BY_ALIAS.get(aliasKey(alias)))
    .find((provider) => provider !== undefined);
  if (known) {
    return {
      id: known.id,
      label: cleanText(upstreamLabel ?? "") || known.label,
      upstreamAliases: aliases,
    };
  }

  const rawId = upstreamId === undefined ? undefined : cleanText(String(upstreamId));
  const rawLabel = upstreamLabel ? cleanText(upstreamLabel) : undefined;
  const fallbackId = rawId || (rawLabel ? aliasKey(rawLabel) : "");
  if (!fallbackId) return undefined;
  return {
    id: fallbackId,
    label: rawLabel || rawId || fallbackId,
    upstreamAliases: aliases,
  };
}

export const LANGUAGE_LABELS = {
  hi: "Hindi",
  kn: "Kannada",
  ta: "Tamil",
  te: "Telugu",
  ml: "Malayalam",
  bn: "Bengali",
  mr: "Marathi",
  pa: "Punjabi",
  gu: "Gujarati",
  en: "English",
} as const;

export type SupportedLanguageCode = keyof typeof LANGUAGE_LABELS;

export interface NormalizedLanguage {
  code: string;
  label: string;
}

const LANGUAGE_BY_ALIAS = new Map<string, SupportedLanguageCode>();
for (const [code, label] of Object.entries(LANGUAGE_LABELS) as [SupportedLanguageCode, string][]) {
  LANGUAGE_BY_ALIAS.set(code, code);
  LANGUAGE_BY_ALIAS.set(label.toLowerCase(), code);
}

/** Normalize ISO codes, BCP-47 tags, or supported display names. */
export function normalizeLanguage(value: string | undefined): NormalizedLanguage | undefined {
  const cleaned = value?.trim().toLowerCase();
  if (!cleaned) return undefined;
  const base = cleaned.split(/[-_]/)[0]!;
  const supported = LANGUAGE_BY_ALIAS.get(cleaned) ?? LANGUAGE_BY_ALIAS.get(base);
  if (supported) return { code: supported, label: LANGUAGE_LABELS[supported] };
  if (/^[a-z]{2}$/.test(base)) return { code: base, label: base };
  return undefined;
}

export function languageLabel(code: string): string {
  return normalizeLanguage(code)?.label ?? code;
}

/** Conservative punctuation/diacritic folding for exact-year identity fallback. */
export function normalizeIdentityTitle(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
import { cleanText } from "../util/format";
