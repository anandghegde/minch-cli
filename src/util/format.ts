export function formatBytes(bytes?: number): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

const SIZE_UNITS: Record<string, number> = {
  B: 1,
  KIB: 1024,
  MIB: 1024 ** 2,
  GIB: 1024 ** 3,
  TIB: 1024 ** 4,
  PIB: 1024 ** 5,
  KB: 1000,
  MB: 1e6,
  GB: 1e9,
  TB: 1e12,
  PB: 1e15,
};

/** Parse a human size string (e.g. "1.5 GiB", "700MB") into bytes. */
export function parseSize(s: string): number {
  if (!s) return 0;
  const cleaned = s.replace(/,/g, "").trim();
  const m = cleaned.match(/([\d.]+)\s*([KMGTP]?I?B)/i);
  if (!m) {
    const n = Number(cleaned);
    return Number.isFinite(n) ? Math.round(n) : 0;
  }
  return Math.round(parseFloat(m[1]!) * (SIZE_UNITS[m[2]!.toUpperCase()] ?? 1));
}

export function formatRelative(unixSeconds?: number): string {
  if (!unixSeconds || !Number.isFinite(unixSeconds) || unixSeconds <= 0) return "";
  const diff = Date.now() / 1000 - unixSeconds;
  if (diff < 60) return "now";
  const m = Math.floor(diff / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}hr ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

function isJunkCodePoint(cp: number): boolean {
  if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return true;
  if (cp === 0xfffd) return true;
  if (cp >= 0x200b && cp <= 0x200f) return true;
  if (cp >= 0x2028 && cp <= 0x202e) return true;
  if (cp === 0x2060 || (cp >= 0x2066 && cp <= 0x2069) || cp === 0xfeff) return true;
  return false;
}

/** Strip control/zero-width characters and collapse whitespace. */
export function cleanText(s: string): string {
  let out = "";
  for (const ch of s.normalize("NFC")) {
    if (!isJunkCodePoint(ch.codePointAt(0)!)) out += ch;
  }
  return out.replace(/\s+/g, " ").trim();
}

export function truncate(s: string, max: number): string {
  if (max <= 1) return s.slice(0, Math.max(0, max));
  return s.length <= max ? s : s.slice(0, max - 1) + "\u2026";
}

export function formatLatency(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
