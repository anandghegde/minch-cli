/**
 * Minimal release-name parser for ranking. Extracts only the signals quality
 * sort needs — resolution, source, codec, HDR, revision, year, season/episode.
 * Inspired by Sonarr's QualityParser, scoped to a handful of regexes rather
 * than a full scene parser. Zero runtime deps.
 */

export interface ParsedRelease {
  /** Vertical resolution in pixels (480 / 720 / 1080 / 2160), or null. */
  resolution: number | null;
  /** Normalized source tag: remux | bluray | webdl | webrip | hdtv | dvd | cam. */
  source: string | null;
  /** Normalized codec: x264 | x265 | hevc | xvid | av1. */
  codec: string | null;
  /** HDR family flag: hdr10 | dv | hdr, or null. */
  hdr: string | null;
  /** Revision marker: proper | repack | v2, or null. */
  revision: string | null;
  year: number | null;
  season: number | null;
  episode: number | null;
}

const RE_RESOLUTION =
  /\b(?:(2160|1080|720|480)p|4k|uhd)\b/i;
const RE_SOURCE =
  /\b(remux|blu-?ray|bdrip|brrip|web-?dl|webrip|web|hdtv|dvd(?:rip)?|cam|ts|telesync|hdrip)\b/i;
const RE_CODEC = /\b(x264|x265|h\.?264|h\.?265|hevc|xvid|av1)\b/i;
const RE_HDR = /\b(hdr10\+?|dolby\s*vision|dv|hdr)\b/i;
const RE_REVISION = /\b(proper|repack|v2|rerip)\b/i;
const RE_YEAR = /(?:^|[^\d])((?:19|20)\d{2})(?:[^\d]|$)/;
const RE_SE =
  /\b[Ss](\d{1,2})[Ee](\d{1,3})\b|\b(\d{1,2})x(\d{1,3})\b/;

/** Hard trash (CAM family, samples, porn-in-title noise). */
const RE_TRASH_HARD =
  /\b(CAM|HDCAM|TELESYNC|HDTS|TS|TC|TELECINE|SAMPLE|PROOF|XXX)\b/i;
/** Soft trash (screeners / R5) — demote less aggressively. */
const RE_TRASH_SOFT = /\b(SCR|SCREENER|R5|DVDSCR)\b/i;

/** Tokens stripped when building a clean title for similarity. */
const RE_TITLE_NOISE =
  /\b(?:(?:2160|1080|720|480)p|4k|uhd|remux|blu-?ray|bdrip|brrip|web-?dl|webrip|web|hdtv|dvd(?:rip)?|cam|ts|telesync|hdrip|x264|x265|h\.?264|h\.?265|hevc|xvid|av1|hdr10\+?|dolby\s*vision|\bdv\b|hdr|proper|repack|v2|rerip|multi(?:audio)?|dual(?:audio)?|aac|dts(?:-?hd)?|truehd|atmos|ac3|eac3|flac|subs?|esub|english|hindi|complete|repack|internal|limited|unrated|extended|theatrical|directors?\.?cut|readnfo|nfo|mkv|mp4|avi)\b/gi;

function normSource(raw: string): string {
  const s = raw.toLowerCase().replace(/-/g, "");
  if (s === "remux") return "remux";
  if (s === "bluray" || s === "bdrip" || s === "brrip") return "bluray";
  if (s === "webdl" || s === "web") return "webdl";
  if (s === "webrip") return "webrip";
  if (s === "hdtv") return "hdtv";
  if (s === "dvd" || s === "dvdrip") return "dvd";
  if (s === "cam" || s === "ts" || s === "telesync" || s === "hdrip") return "cam";
  return s;
}

function normCodec(raw: string): string {
  const c = raw.toLowerCase().replace(/\./g, "");
  if (c === "h264" || c === "x264") return "x264";
  if (c === "h265" || c === "x265" || c === "hevc") return "x265";
  if (c === "xvid") return "xvid";
  if (c === "av1") return "av1";
  return c;
}

function normHdr(raw: string): string {
  const h = raw.toLowerCase().replace(/\s+/g, "");
  if (h.startsWith("hdr10")) return "hdr10";
  if (h === "dolbyvision" || h === "dv") return "dv";
  return "hdr";
}

function normRevision(raw: string): string {
  const r = raw.toLowerCase();
  if (r === "proper") return "proper";
  if (r === "repack" || r === "rerip") return "repack";
  if (r === "v2") return "v2";
  return r;
}

export function parseReleaseName(name: string): ParsedRelease {
  const out: ParsedRelease = {
    resolution: null,
    source: null,
    codec: null,
    hdr: null,
    revision: null,
    year: null,
    season: null,
    episode: null,
  };
  if (!name) return out;

  const res = name.match(RE_RESOLUTION);
  if (res) {
    if (res[1]) out.resolution = Number(res[1]);
    else out.resolution = 2160; // 4K / UHD
  }

  const src = name.match(RE_SOURCE);
  if (src?.[1]) out.source = normSource(src[1]);

  // Remux often appears with BluRay; prefer remux when both present.
  if (/\bremux\b/i.test(name)) out.source = "remux";

  const codec = name.match(RE_CODEC);
  if (codec?.[1]) out.codec = normCodec(codec[1]);

  const hdr = name.match(RE_HDR);
  if (hdr?.[1]) out.hdr = normHdr(hdr[1]);

  const rev = name.match(RE_REVISION);
  if (rev?.[1]) out.revision = normRevision(rev[1]);

  const year = name.match(RE_YEAR);
  if (year?.[1]) out.year = Number(year[1]);

  const se = name.match(RE_SE);
  if (se) {
    if (se[1] != null && se[2] != null) {
      out.season = Number(se[1]);
      out.episode = Number(se[2]);
    } else if (se[3] != null && se[4] != null) {
      out.season = Number(se[3]);
      out.episode = Number(se[4]);
    }
  }

  return out;
}

/**
 * Trash demotion weight (higher = worse). Hard CAM/sample noise = 2;
 * screeners = 1; clean = 0. Used as a cascade key (ascending).
 */
export function trashPenalty(name: string): number {
  if (!name) return 0;
  const parsed = parseReleaseName(name);
  if (parsed.source === "cam") return 2;
  if (RE_TRASH_HARD.test(name)) return 2;
  if (RE_TRASH_SOFT.test(name)) return 1;
  return 0;
}

/** True when the release name looks like known-bad / trash quality. */
export function isTrashRelease(name: string): boolean {
  return trashPenalty(name) > 0;
}

/**
 * Strip scene/quality tags so remaining text approximates the human title.
 * Used for title-similarity scoring against the query.
 */
export function cleanTitle(name: string): string {
  if (!name) return "";
  let s = name;
  // Drop bracketed groups: [SubsPlease], [ABC123]
  s = s.replace(/\[[^\]]*]/g, " ");
  // Drop trailing -GROUP release group
  s = s.replace(/-[A-Za-z0-9]+$/g, " ");
  // Drop SxxEyy / NxNN episode markers
  s = s.replace(/\b[Ss]\d{1,2}[Ee]\d{1,3}\b/g, " ");
  s = s.replace(/\b\d{1,2}x\d{1,3}\b/g, " ");
  // Drop years
  s = s.replace(/(?:^|[^\d])(?:19|20)\d{2}(?=[^\d]|$)/g, " ");
  // Drop known quality/source/codec noise tokens
  s = s.replace(RE_TITLE_NOISE, " ");
  // Normalize separators to spaces
  s = s.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
  return s;
}

/** Source quality weight within a resolution band (higher is better). */
const SOURCE_WEIGHT: Record<string, number> = {
  remux: 50,
  bluray: 40,
  webdl: 30,
  webrip: 20,
  hdtv: 10,
  dvd: 5,
  cam: 0,
};

/**
 * Numeric quality ordering:
 *   2160p Remux > 2160p BluRay > 2160p WEB-DL > 1080p BluRay > 1080p WEB-DL > 720p > SD
 *
 * Resolution dominates; source is a secondary band; small bumps for HDR and
 * PROPER/REPACK so equal-res peers still get a stable preference.
 */
export function qualityRank(parsed: ParsedRelease): number {
  const res = parsed.resolution ?? 0;
  // Map common resolutions onto evenly spaced bands.
  let resScore = 0;
  if (res >= 2160) resScore = 400;
  else if (res >= 1080) resScore = 300;
  else if (res >= 720) resScore = 200;
  else if (res >= 480) resScore = 100;
  else resScore = 0;

  const srcScore = parsed.source ? (SOURCE_WEIGHT[parsed.source] ?? 0) : 0;
  const hdrBonus = parsed.hdr ? (parsed.hdr === "dv" ? 8 : parsed.hdr === "hdr10" ? 6 : 4) : 0;
  const revBonus = parsed.revision ? 2 : 0;
  // Prefer modern codecs slightly when everything else ties.
  const codecBonus =
    parsed.codec === "x265" || parsed.codec === "av1"
      ? 1
      : parsed.codec === "x264"
        ? 0
        : 0;

  return resScore + srcScore + hdrBonus + revBonus + codecBonus;
}
