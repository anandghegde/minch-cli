// Coarse release classification from a result title: quality tier, media type,
// and a normalized title for de-duplication. Ported from TorrentX's
// utils/text.ts and adapted to minch's model — results carry no quality/
// mediaType fields, so the ranking + intent modules derive them here.

export type MediaType =
  | "movie"
  | "tv"
  | "anime"
  | "game"
  | "software"
  | "documentary"
  | "other";

const QUALITY_PATTERNS = [
  "2160p",
  "4k",
  "1080p",
  "1080i",
  "720p",
  "480p",
  "uhd",
  "hdr",
] as const;

/** Detect a quality tier mentioned in the title (e.g. "1080p", "2160p"). */
export function detectQuality(title: string): string | undefined {
  const lower = title.toLowerCase();
  const quality = QUALITY_PATTERNS.find((candidate) => lower.includes(candidate));
  if (quality === "4k" || quality === "uhd") return "2160p";
  return quality?.toUpperCase().replace("P", "p");
}

/** Infer a coarse media type from release-name conventions. */
export function detectMediaType(title: string): MediaType | undefined {
  const lower = title.toLowerCase();
  if (/\bs\d{1,2}e\d{1,3}\b|\bseason\s+\d+\b/.test(lower)) return "tv";
  if (/\banime\b|\bsubsplease\b|\bdual audio\b/.test(lower)) return "anime";
  if (/\brepack\b|\bfitgirl\b|\bgame\b/.test(lower)) return "game";
  if (/\bsoftware\b|\bmacos\b|\bwindows\b|\blinux\b/.test(lower)) return "software";
  if (/\bdocumentary\b|\bdocu\b/.test(lower)) return "documentary";
  return undefined;
}

/** Strip release/quality/codec/source tags to a comparable bare title. */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\b(2160p|4k|1080p|1080i|720p|480p|uhd|hdr|bluray|web-?dl|webrip|brrip)\b/g, " ")
    .replace(/\b(x265|h265|hevc|x264|h264|av1|aac|dts|ddp?\d?(?:\.\d)?)\b/g, " ")
    .replace(/\b(yts|yify|rarbg|eztv|nyaa|fitgirl)\b/g, " ")
    .replace(/[._()[\]{}-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
