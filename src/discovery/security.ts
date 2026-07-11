import { cleanText } from "../util/format";
import type { DiscoverySnapshot } from "./adapter";

const REDACTED = "[redacted]";

function secretVariants(secrets: readonly string[]): string[] {
  const variants = new Set<string>();
  for (const value of secrets) {
    const secret = value.trim();
    if (!secret) continue;
    const encoded = encodeURIComponent(secret);
    variants.add(secret);
    variants.add(encoded);
    variants.add(encoded.replace(/%[0-9A-F]{2}/g, (match) => match.toLowerCase()));
  }
  return [...variants].sort((left, right) => right.length - left.length);
}

function containsSecret(value: string, secrets: readonly string[]): boolean {
  const variants = secretVariants(secrets);
  if (variants.some((secret) => value.includes(secret))) return true;
  try {
    const decoded = decodeURIComponent(value.replace(/\+/g, "%20"));
    return secrets.some((secret) => secret.trim() && decoded.includes(secret.trim()));
  } catch {
    return false;
  }
}

/** Remove terminal controls and replace configured credentials in display/cache text. */
export function sanitizeDiscoveryText(
  value: string,
  secrets: readonly string[] = [],
): string {
  let sanitized = value;
  for (const secret of secretVariants(secrets)) {
    sanitized = sanitized.split(secret).join(REDACTED);
  }
  return cleanText(sanitized);
}

function sanitizeValue(
  value: unknown,
  secrets: readonly string[],
  property?: string,
): unknown {
  if (typeof value === "string") {
    if (property === "sourceUrl" && containsSecret(value, secrets)) return undefined;
    return sanitizeDiscoveryText(value, secrets);
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => sanitizeValue(entry, secrets))
      .filter((entry) => entry !== undefined);
  }
  if (!value || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const sanitized = sanitizeValue(entry, secrets, key);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
}

/**
 * Last boundary before a normalized snapshot can reach persistent cache or Ink.
 * Authenticated adapters additionally pass their in-memory credential so an
 * upstream echo cannot persist it in text, warnings, cursors, or source links.
 */
export function sanitizeDiscoverySnapshot(
  snapshot: DiscoverySnapshot,
  secrets: readonly string[] = [],
): DiscoverySnapshot {
  return sanitizeDiscoveryData(snapshot, secrets);
}

/** Sanitize a normalized discovery subdocument before retaining it in memory. */
export function sanitizeDiscoveryData<T>(
  value: T,
  secrets: readonly string[] = [],
): T {
  return sanitizeValue(value, secrets) as T;
}
