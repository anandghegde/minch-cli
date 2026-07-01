// The scoped Cardigann executor. Given a parsed definition + a base URL, it
// builds the search request (Go-template substitution of paths/inputs), fetches
// it, parses rows/fields (HTML via cheerio, XML/JSON natively), runs field
// filters, and maps the standard Cardigann field names to a TorrentResult.
//
// Scope: public, no-login only. No cookies, no captcha, no login/landing pages.

import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import { XMLParser } from "fast-xml-parser";
import { applyTemplate, type TemplateVars } from "./template";
import { applyFilters } from "./filters";
import { buildCategoryMap, mapCategory, type CategoryMap } from "./categories";
import { fromUnknown } from "./dates";
import type {
  CardigannDefinition,
  CardigannRows,
  CardigannSelector,
  CardigannSearchPath,
} from "./model";
import { parseSize } from "../util/format";
import { buildMagnet, infoHashFromMagnet, normalizeInfoHash } from "../sources/magnet";
import { fetchResilient, HttpError, USER_AGENT } from "../util/net";

export interface ExecutorResult {
  infoHash: string | null;
  magnet: string | null;
  downloadUrl: string | null;
  detailsUrl: string | null;
  title: string;
  sizeBytes: number;
  seeders: number;
  leechers: number;
  added?: number;
  category?: string;
}

export interface ExecuteOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

const OPTIONAL_FIELDS = new Set([
  "imdb", "imdbid", "tmdbid", "rageid", "tvdbid", "tvmazeid", "traktid",
  "doubanid", "poster", "banner", "description", "genre",
]);

/** Build the base template variables (config defaults + .True/.False/Today). */
function baseVariables(def: CardigannDefinition, siteLink: string): TemplateVars {
  const vars: TemplateVars = {
    ".Config.sitelink": siteLink,
    ".True": "True",
    ".False": null,
    ".Today.Year": String(new Date().getFullYear()),
  };
  for (const s of def.settings ?? []) {
    const name = ".Config." + s.name;
    switch (s.type) {
      case "text":
      case "password":
        vars[name] = s.default ?? "";
        break;
      case "checkbox":
        vars[name] = s.default === "true" ? ".True" : null;
        break;
      case "select": {
        // Default to the configured default option key, else the first.
        const keys = Object.keys(s.options ?? {}).sort();
        vars[name] = s.default ?? keys[0] ?? "";
        break;
      }
      default:
        // info* and unknown setting types contribute no variable.
        break;
    }
  }
  return vars;
}

function queryVariables(query: string): TemplateVars {
  const q = query.trim();
  return {
    ".Query.Type": "search",
    ".Query.Q": q,
    ".Query.Keywords": q,
    ".Keywords": q,
    ".Query.Categories": null,
    ".Query.Limit": "100",
    ".Query.Offset": "0",
    ".Query.Series": null,
    ".Query.Movie": null,
    ".Query.Year": null,
    ".Query.Episode": null,
    ".Query.Season": null,
    ".Query.Album": null,
    ".Query.Artist": null,
    ".Query.Author": null,
    ".Query.Title": null,
    ".Categories": [],
  };
}

function uriVariables(vars: TemplateVars, url: string): void {
  try {
    const u = new URL(url);
    vars[".AbsoluteUri"] = u.href;
    vars[".AbsolutePath"] = u.pathname;
    vars[".Scheme"] = u.protocol.replace(":", "");
    vars[".Host"] = u.host;
    vars[".PathAndQuery"] = u.pathname + u.search;
    vars[".Query"] = u.search;
    for (const [k, v] of u.searchParams) vars[".Query." + k] = v;
  } catch {
    /* non-fatal */
  }
}

function resolveUrl(path: string, base: string): string {
  try {
    return new URL(path, base).href;
  } catch {
    return path;
  }
}

/** Build the full search request URL + method + form body for a search path. */
export function buildRequest(
  def: CardigannDefinition,
  searchPath: CardigannSearchPath,
  vars: TemplateVars,
  siteLink: string,
): { url: string; method: string; form?: Record<string, string> } {
  const search = def.search;
  const pathStr = applyTemplate(searchPath.path, vars, encodeURIComponent).replace(
    /\+/g,
    "%20",
  );
  let url = resolveUrl(pathStr, siteLink);
  const method = (searchPath.method ?? "get").toLowerCase();

  const query: [string, string][] = [];
  const inputsList: (Record<string, string> | undefined)[] = [];
  if (searchPath.inheritinputs !== false) inputsList.push(search.inputs);
  inputsList.push(searchPath.inputs);

  for (const inputs of inputsList) {
    if (!inputs) continue;
    for (const [key, raw] of Object.entries(inputs)) {
      if (key === "$raw") {
        const rawStr = applyTemplate(raw, vars, encodeURIComponent);
        for (const part of rawStr.split("&")) {
          const [k, ...rest] = part.split("=");
          if (!k) continue;
          query.push([k, rest.join("=")]);
        }
      } else {
        const value = applyTemplate(raw, vars);
        if (value !== "" || search.allowEmptyInputs) query.push([key, value]);
      }
    }
  }

  if (method === "get" && query.length > 0) {
    const qs = query
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    url += (url.includes("?") ? "&" : "?") + qs;
    return { url, method };
  }
  if (method === "post") {
    return { url, method, form: Object.fromEntries(query) };
  }
  return { url, method };
}

// ---- selector handling ------------------------------------------------------

function querySelector(
  $: CheerioAPI,
  el: cheerio.Cheerio<never>,
  selector: string,
): cheerio.Cheerio<never> | null {
  let scope = el;
  let sel = selector;
  if (sel.startsWith(":root")) {
    sel = sel.slice(5).trim();
    scope = $.root() as unknown as cheerio.Cheerio<never>;
    if (!sel) return scope;
  }
  // self-match (like AngleSharp dom.Matches) then descendant search.
  if (el.is(sel)) return el;
  const found = scope.find(sel);
  return found.length ? (found.first() as unknown as cheerio.Cheerio<never>) : null;
}

function handleHtmlSelector(
  $: CheerioAPI,
  selector: CardigannSelector,
  row: cheerio.Cheerio<never>,
  vars: TemplateVars,
  required: boolean,
): string | null {
  if (selector.text != null) {
    return applyFilters(applyTemplate(selector.text, vars), selector.filters, vars);
  }

  let selection = row;
  let value: string | null = null;

  if (selector.selector) {
    const sel = applyTemplate(selector.selector, vars);
    const found = querySelector($, row, sel);
    if (!found) {
      if (required) throw new Error(`selector "${sel}" did not match`);
      return null;
    }
    selection = found;
  }

  if (selector.remove) {
    selection.find(selector.remove).remove();
  }

  if (selector.case) {
    for (const [k, v] of Object.entries(selector.case)) {
      if (selection.is(k) || selection.find(k).length > 0) {
        value = applyTemplate(v, vars);
        break;
      }
    }
    if (value == null) {
      if (required) throw new Error("no case selector matched");
      return null;
    }
  } else if (selector.attribute) {
    const attr = selection.attr(selector.attribute);
    if (attr == null) {
      if (required) throw new Error(`attribute "${selector.attribute}" not set`);
      return null;
    }
    value = attr;
  } else {
    value = selection.text();
  }

  return applyFilters((value ?? "").trim(), selector.filters, vars);
}

// ---- JSON selector handling -------------------------------------------------

function jsonSelectToken(obj: unknown, selector: string): unknown {
  // Support dotted paths and [index] access; a leading "." is stripped.
  let cur: unknown = obj;
  const path = selector.replace(/^\./, "");
  if (path === "") return cur;
  const parts = path.split(".");
  for (const part of parts) {
    if (cur == null) return undefined;
    const m = part.match(/^(.*?)\[(\d+)\]$/);
    if (m) {
      const key = m[1];
      if (key) cur = (cur as Record<string, unknown>)[key];
      if (Array.isArray(cur)) cur = cur[Number(m[2])];
      else return undefined;
    } else {
      cur = (cur as Record<string, unknown>)[part];
    }
  }
  return cur;
}

function handleJsonSelector(
  selector: CardigannSelector,
  parent: unknown,
  vars: TemplateVars,
  required: boolean,
): string | null {
  if (selector.text != null) {
    return applyFilters(applyTemplate(selector.text, vars), selector.filters, vars);
  }
  let value: string | null = null;
  if (selector.selector) {
    const sel = applyTemplate(selector.selector.replace(/^\./, ""), vars);
    // strip cardigann :filter(...) suffixes for plain field access
    const baseSel = sel.split(":")[0]!;
    const token = jsonSelectToken(parent, baseSel);
    if (token == null) {
      if (required) throw new Error(`json selector "${sel}" did not match`);
      return null;
    }
    value = Array.isArray(token) ? token.join(",") : String(token);
  }
  if (selector.case) {
    let matched: string | null = null;
    for (const [k, v] of Object.entries(selector.case)) {
      if ((value != null && value === k) || k === "*") {
        matched = applyTemplate(v, vars);
        break;
      }
    }
    if (matched == null) {
      if (required) throw new Error("no json case selector matched");
      return null;
    }
    value = matched;
  }
  return applyFilters((value ?? "").trim(), selector.filters, vars);
}

// ---- field mapping ----------------------------------------------------------

function applyField(
  result: ExecutorResult,
  fieldName: string,
  value: string,
  modifiers: string[],
  catMap: CategoryMap,
  siteLink: string,
  searchUrl: string,
): void {
  switch (fieldName) {
    case "download":
      if (!value) break;
      if (value.startsWith("magnet:")) result.magnet = value;
      else result.downloadUrl = resolveUrl(value, searchUrl || siteLink);
      break;
    case "magnet":
      result.magnet = value;
      break;
    case "infohash":
      result.infoHash = normalizeInfoHash(value);
      break;
    case "details":
    case "comments":
      result.detailsUrl = resolveUrl(value, searchUrl || siteLink);
      break;
    case "title":
      result.title = modifiers.includes("append")
        ? result.title + value
        : value;
      break;
    case "size":
      result.sizeBytes = parseSize(value);
      break;
    case "seeders": {
      const n = parseInt(value.replace(/[^\d]/g, ""), 10);
      result.seeders = Number.isFinite(n) && n < 5_000_000 ? n : 0;
      break;
    }
    case "leechers": {
      const n = parseInt(value.replace(/[^\d]/g, ""), 10);
      result.leechers = Number.isFinite(n) && n < 5_000_000 ? n : 0;
      break;
    }
    case "date": {
      const unix = fromUnknown(value);
      if (unix != null) result.added = unix;
      break;
    }
    case "category":
    case "categorydesc": {
      const label = mapCategory(catMap, value);
      if (label && !result.category) result.category = label;
      break;
    }
    default:
      // imdb/tmdb/grabs/files/poster/etc. — not surfaced in the TUI; ignore.
      break;
  }
}

// ---- row parsing ------------------------------------------------------------

function parseField(
  fieldKey: string,
): { name: string; modifiers: string[]; optional: boolean } {
  const parts = fieldKey.split("|");
  const name = parts[0]!;
  const modifiers = parts.slice(1);
  return {
    name,
    modifiers,
    optional: OPTIONAL_FIELDS.has(name) || modifiers.includes("optional"),
  };
}

function blankResult(): ExecutorResult {
  return {
    infoHash: null,
    magnet: null,
    downloadUrl: null,
    detailsUrl: null,
    title: "",
    sizeBytes: 0,
    seeders: 0,
    leechers: 0,
  };
}

function finalize(
  result: ExecutorResult,
  def: CardigannDefinition,
): ExecutorResult {
  // Derive magnet from info hash (public) and vice versa.
  if (!result.magnet && result.infoHash) {
    result.magnet = buildMagnet(result.infoHash, result.title || undefined);
  }
  if (result.magnet && !result.infoHash) {
    result.infoHash = infoHashFromMagnet(result.magnet);
  }
  return result;
}

export function parseHtmlResults(
  html: string,
  def: CardigannDefinition,
  catMap: CategoryMap,
  vars: TemplateVars,
  siteLink: string,
  searchUrl: string,
  isXml: boolean,
): ExecutorResult[] {
  const search = def.search;
  let content = html;
  if (search.preprocessingfilters) {
    content = applyFilters(content, search.preprocessingfilters, vars);
  }
  const $ = isXml
    ? cheerio.load(content, { xml: { xmlMode: true } })
    : cheerio.load(content);

  const rowsSelector = applyTemplate(search.rows.selector ?? "", vars);
  const rowEls = $(rowsSelector).toArray();
  const out: ExecutorResult[] = [];

  // "after" row merging is rare in public defs; handle the common no-merge path.
  for (const rowEl of rowEls) {
    const row = $(rowEl) as unknown as cheerio.Cheerio<never>;
    const result = blankResult();
    let fatal = false;
    for (const { key, value } of search.fields) {
      const { name, modifiers, optional } = parseField(key);
      try {
        let v = handleHtmlSelector($, value, row, vars, !optional);
        if (optional && (v == null || v.trim() === "")) {
          const def2 = applyTemplate(value.default ?? "", vars);
          if (!def2) continue;
          v = def2;
        }
        if (v != null) {
          vars[".Result." + name] = v;
          applyField(result, name, v, modifiers, catMap, siteLink, searchUrl);
        }
      } catch {
        if (!optional) {
          fatal = true;
          break;
        }
      }
    }
    if (fatal) continue;
    const finished = finalize(result, def);
    if ((finished.magnet || finished.downloadUrl) && finished.title) {
      out.push(finished);
    }
  }
  return out;
}

export function parseJsonResults(
  text: string,
  def: CardigannDefinition,
  catMap: CategoryMap,
  vars: TemplateVars,
  siteLink: string,
  searchUrl: string,
): ExecutorResult[] {
  const search = def.search;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return [];
  }
  const rowsSel = applyTemplate(search.rows.selector ?? "", vars).split(":")[0]!;
  const rowsToken = jsonSelectToken(json, rowsSel);
  if (!Array.isArray(rowsToken)) return [];

  const out: ExecutorResult[] = [];
  for (const rowObj of rowsToken) {
    let selObj: unknown = rowObj;
    if (search.rows.attribute) {
      selObj = jsonSelectToken(rowObj, search.rows.attribute);
      if (selObj == null) continue;
    }
    const mulRows = search.rows.multiple && Array.isArray(selObj) ? selObj : [selObj];
    for (const mulRow of mulRows) {
      const result = blankResult();
      let fatal = false;
      for (const { key, value } of search.fields) {
        const { name, modifiers, optional } = parseField(key);
        try {
          let v = handleJsonSelector(value, mulRow, vars, !optional);
          if (optional && (v == null || v.trim() === "")) {
            const d = applyTemplate(value.default ?? "", vars);
            if (!d) continue;
            v = d;
          }
          if (v != null) {
            vars[".Result." + name] = v;
            applyField(result, name, v, modifiers, catMap, siteLink, searchUrl);
          }
        } catch {
          if (!optional) {
            fatal = true;
            break;
          }
        }
      }
      if (fatal) continue;
      const finished = finalize(result, def);
      if ((finished.magnet || finished.downloadUrl) && finished.title) {
        out.push(finished);
      }
    }
  }
  return out;
}

function responseType(searchPath: CardigannSearchPath | undefined): string {
  return (searchPath?.response?.type ?? "html").toLowerCase();
}

/**
 * For results lacking a magnet/infohash, resolve one via the definition's
 * download.infohash block: fetch the details page and extract the hash with the
 * configured selector + filters. Scoped to public defs (no cookies/login).
 * Limited concurrency + a result cap keep this from hammering the site.
 */
async function resolveDownloadInfohashes(
  def: CardigannDefinition,
  results: ExecutorResult[],
  vars: TemplateVars,
  opts: ExecuteOptions,
): Promise<void> {
  const block = def.download?.infohash;
  if (!block?.hash) return;
  const pending = results.filter((r) => !r.magnet && !r.infoHash && r.detailsUrl);
  const targets = pending.slice(0, 20); // cap the extra fetches per search
  let i = 0;
  const worker = async (): Promise<void> => {
    while (i < targets.length) {
      const r = targets[i++]!;
      try {
        const html = await fetchResilient(r.detailsUrl!, {
          headers: { "User-Agent": USER_AGENT },
          signal: opts.signal,
          fetchImpl: opts.fetchImpl as never,
          retries: 0,
        });
        if (!html.ok) continue;
        const $ = cheerio.load(await html.text());
        const root = $.root() as unknown as cheerio.Cheerio<never>;
        const hashSel: CardigannSelector = {
          selector: block.hash!.selector,
          attribute: block.hash!.attribute,
          filters: block.hash!.filters,
        };
        const hashVal = handleHtmlSelector($, hashSel, root, vars, false);
        if (hashVal) {
          r.infoHash = normalizeInfoHash(hashVal);
          r.magnet = buildMagnet(r.infoHash, r.title || undefined);
        }
      } catch {
        /* leave as download-only result */
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, targets.length) }, worker));
}

/** Execute a search against a single base URL, returning parsed results. */
export async function executeSearch(
  def: CardigannDefinition,
  query: string,
  siteLink: string,
  opts: ExecuteOptions = {},
): Promise<ExecutorResult[]> {
  const catMap = buildCategoryMap(def.caps);
  const vars: TemplateVars = {
    ...baseVariables(def, siteLink),
    ...queryVariables(query),
  };

  const paths = def.search.paths ?? [];
  if (paths.length === 0) throw new Error("definition has no search paths");

  const collected: ExecutorResult[] = [];
  for (const searchPath of paths) {
    const req = buildRequest(def, searchPath, vars, siteLink);
    uriVariables(vars, req.url);

    const headers: Record<string, string> = { "User-Agent": USER_AGENT };
    if (def.search.headers) {
      for (const [k, v] of Object.entries(def.search.headers)) {
        if (Array.isArray(v) && v[0] != null) {
          headers[k] = applyTemplate(v[0], vars);
        }
      }
    }

    const res = await fetchResilient(req.url, {
      method: req.method.toUpperCase(),
      headers,
      body:
        req.method === "post" && req.form
          ? new URLSearchParams(req.form).toString()
          : undefined,
      signal: opts.signal,
      fetchImpl: opts.fetchImpl as never,
      retries: 1,
    });
    if (!res.ok) throw new HttpError(res.status, `${def.id} returned ${res.status}`);
    const text = await res.text();

    const type = responseType(searchPath);
    const nrm = searchPath.response?.noResultsMessage;
    if (nrm && text.includes(nrm)) continue;

    if (type === "json") {
      collected.push(
        ...parseJsonResults(text, def, catMap, vars, siteLink, req.url),
      );
    } else {
      collected.push(
        ...parseHtmlResults(
          text,
          def,
          catMap,
          vars,
          siteLink,
          req.url,
          type === "xml",
        ),
      );
    }
  }
  await resolveDownloadInfohashes(def, collected, vars, opts);
  return collected;
}

export { type CardigannRows };
