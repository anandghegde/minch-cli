// Scoped port of Cardigann's ApplyFilters (CardigannBase.cs). Only the filters
// public definitions actually use are implemented (verified against the 81
// public, no-login v11 defs): regexp, re_replace, replace, split, querystring,
// dateparse/timeparse/timeago/reltime/fuzzytime, append/prepend, trim, tolower,
// toupper, urldecode, urlencode, htmldecode, validate, diacritics.

import { decode as decodeEntities } from "./entities";
import { fromTimeAgo, fromUnknown, parseGoLayout } from "./dates";
import { applyTemplate, type TemplateVars } from "./template";
import type { CardigannFilter } from "./model";

function arg(args: CardigannFilter["args"], i = 0): string {
  if (args == null) return "";
  if (Array.isArray(args)) return args[i] != null ? String(args[i]) : "";
  return i === 0 ? String(args) : "";
}

function dateToString(unix: number | null): string {
  return unix != null ? new Date(unix * 1000).toISOString() : "";
}

/**
 * A single filter is a pure function: (current value, args, template vars) →
 * next value. Throwing is reserved for genuine errors; expected "no match"
 * outcomes are returned as empty string. Each entry is independently testable.
 */
type FilterFn = (
  data: string,
  args: CardigannFilter["args"],
  vars: TemplateVars,
) => string;

const fQueryString: FilterFn = (data, args) => {
  const param = arg(args);
  try {
    const u = new URL(data, "http://x/");
    return u.searchParams.get(param) ?? "";
  } catch {
    const m = data.match(new RegExp(`[?&]${param}=([^&]*)`));
    return m ? decodeURIComponent(m[1]!) : "";
  }
};

const fDateParse: FilterFn = (data, args) => {
  const layout = arg(args);
  const unix = parseGoLayout(data, layout);
  return dateToString(unix ?? fromUnknown(data));
};

const fRegexp: FilterFn = (data, args) => {
  const pattern = arg(args);
  try {
    const m = new RegExp(pattern).exec(data);
    return m ? (m[1] ?? "") : "";
  } catch {
    return "";
  }
};

const fReReplace: FilterFn = (data, args, vars) => {
  const pattern = arg(args, 0);
  const repl = applyTemplate(arg(args, 1), vars);
  try {
    return data.replace(new RegExp(pattern, "g"), repl);
  } catch {
    return data;
  }
};

const fSplit: FilterFn = (data, args) => {
  const sep = arg(args, 0);
  let pos = parseInt(arg(args, 1), 10);
  const parts = data.split(sep.charAt(0) || sep);
  if (pos < 0) pos += parts.length;
  return parts[pos] ?? "";
};

const fReplace: FilterFn = (data, args, vars) => {
  const from = arg(args, 0);
  const to = applyTemplate(arg(args, 1), vars);
  return data.split(from).join(to);
};

const fTrim: FilterFn = (data, args) => {
  const cutset = arg(args);
  if (cutset) {
    const c = cutset.charAt(0);
    let out = data;
    while (out.startsWith(c)) out = out.slice(1);
    while (out.endsWith(c)) out = out.slice(0, -1);
    return out;
  }
  return data.trim();
};

const fPrepend: FilterFn = (data, args, vars) =>
  applyTemplate(arg(args), vars) + data;

const fAppend: FilterFn = (data, args, vars) =>
  data + applyTemplate(arg(args), vars);

const fToLower: FilterFn = (data) => data.toLowerCase();
const fToUpper: FilterFn = (data) => data.toUpperCase();

const fUrlDecode: FilterFn = (data) => {
  try {
    return decodeURIComponent(data.replace(/\+/g, " "));
  } catch {
    return data;
  }
};

const fUrlEncode: FilterFn = (data) => encodeURIComponent(data);
const fHtmlDecode: FilterFn = (data) => decodeEntities(data);

const fHtmlEncode: FilterFn = (data) =>
  data
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const fTimeAgo: FilterFn = (data) => dateToString(fromTimeAgo(data));
const fFuzzyTime: FilterFn = (data) => dateToString(fromUnknown(data));

const fDiacritics: FilterFn = (data, args) => {
  if (arg(args) === "replace") {
    return data.normalize("NFD").replace(/[\u0300-\u036f]/g, "").normalize("NFC");
  }
  return data;
};

const VALIDATE_DELIMS = /[,\s/)(.;[\]"|:]+/;
const fValidate: FilterFn = (data, args) => {
  const valid = arg(args).toLowerCase().split(VALIDATE_DELIMS).filter(Boolean);
  const have = data.toLowerCase().split(VALIDATE_DELIMS).filter(Boolean);
  return valid.filter((v) => have.includes(v)).join(", ");
};

const fNoop: FilterFn = (data) => data;

/**
 * Filter registry: name → implementation. Aliases (dateparse/timeparse,
 * timeago/reltime, hexdump/strdump/validfilename) map to the same fn. Lookup is
 * O(1); unknown names fall through to the identity (matches Prowlarr's
 * "log and continue"). Exposed so tests can exercise individual filters.
 */
export const FILTERS: Record<string, FilterFn> = {
  querystring: fQueryString,
  dateparse: fDateParse,
  timeparse: fDateParse,
  regexp: fRegexp,
  re_replace: fReReplace,
  split: fSplit,
  replace: fReplace,
  trim: fTrim,
  prepend: fPrepend,
  append: fAppend,
  tolower: fToLower,
  toupper: fToUpper,
  urldecode: fUrlDecode,
  urlencode: fUrlEncode,
  htmldecode: fHtmlDecode,
  htmlencode: fHtmlEncode,
  timeago: fTimeAgo,
  reltime: fTimeAgo,
  fuzzytime: fFuzzyTime,
  diacritics: fDiacritics,
  validate: fValidate,
  hexdump: fNoop,
  strdump: fNoop,
  validfilename: fNoop,
};

/**
 * Apply a pipeline of filters in order. Each filter receives the previous one's
 * output, so the composition is left-to-right as in Cardigann. Returns the
 * input unchanged when there are no filters.
 */
export function applyFilters(
  input: string,
  filters: CardigannFilter[] | undefined,
  vars: TemplateVars,
): string {
  if (!filters || filters.length === 0) return input;
  let data = input;
  for (const filter of filters) {
    const fn = FILTERS[filter.name];
    if (fn) data = fn(data, filter.args, vars);
  }
  return data;
}
