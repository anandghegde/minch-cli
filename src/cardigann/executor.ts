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
import { disposeResponse, fetchResilient, HttpError, USER_AGENT } from "../util/net";
import { mapPool } from "../util/concurrency";
import type { RequestGovernor } from "./rate-limit";

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
  /** Shared per-source governor for every underlying HTTP request. */
  requestGovernor?: RequestGovernor;
}

const OPTIONAL_FIELDS = new Set([
  "imdb", "imdbid", "tmdbid", "rageid", "tvdbid", "tvmazeid", "traktid",
  "doubanid", "poster", "banner", "description", "genre",
]);

async function governedFetch(
  opts: ExecuteOptions,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  await opts.requestGovernor?.wait(init?.signal as AbortSignal | undefined);
  return (opts.fetchImpl ?? fetch)(url, init);
}

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
        const keys = Object.keys(s.options ?? {}).sort();
        vars[name] = s.default ?? keys[0] ?? "";
        break;
      }
      default:
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

// ---- SelectorEngine strategy ------------------------------------------------

interface SelectorEngine {
  /** Extract a single field value from a row object using the given selector. */
  handleSelector(selector: CardigannSelector, row: unknown, vars: TemplateVars, required: boolean): string | null;
  /** Parse the raw response into an array of row objects. */
  parseRows(search: CardigannDefinition["search"], text: string, vars: TemplateVars): unknown[];
}

const htmlEngine: SelectorEngine = {
  handleSelector(selector, row, vars, required) {
    return handleHtmlSelector(cheerio.load(""), selector, row as cheerio.Cheerio<never>, vars, required);
  },
  parseRows(search, text, vars) {
    let content = text;
    if (search.preprocessingfilters) {
      content = applyFilters(content, search.preprocessingfilters, vars);
    }
    const $ = cheerio.load(content);
    const rowsSelector = applyTemplate(search.rows.selector ?? "", vars);
    return $(rowsSelector).toArray().map((el) => $(el) as unknown as cheerio.Cheerio<never>);
  },
};

const xmlEngine: SelectorEngine = {
  handleSelector(selector, row, vars, required) {
    return handleHtmlSelector(cheerio.load(""), selector, row as cheerio.Cheerio<never>, vars, required);
  },
  parseRows(search, text, vars) {
    let content = text;
    if (search.preprocessingfilters) {
      content = applyFilters(content, search.preprocessingfilters, vars);
    }
    const $ = cheerio.load(content, { xml: { xmlMode: true } });
    const rowsSelector = applyTemplate(search.rows.selector ?? "", vars);
    return $(rowsSelector).toArray().map((el) => $(el) as unknown as cheerio.Cheerio<never>);
  },
};

const jsonEngine: SelectorEngine = {
  handleSelector(selector, row, vars, required) {
    return handleJsonSelector(selector, row, vars, required);
  },
  parseRows(search, text, _vars) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return [];
    }
    const rowsSel = applyTemplate(search.rows.selector ?? "", {}).split(":")[0]!;
    const rowsToken = jsonSelectToken(json, rowsSel);
    if (!Array.isArray(rowsToken)) return [];

    const rows: unknown[] = [];
    for (const rowObj of rowsToken) {
      let selObj: unknown = rowObj;
      if (search.rows.attribute) {
        selObj = jsonSelectToken(rowObj, search.rows.attribute);
        if (selObj == null) continue;
      }
      const mulRows = search.rows.multiple && Array.isArray(selObj) ? selObj : [selObj];
      rows.push(...mulRows);
    }
    return rows;
  },
};

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
      break;
  }
}

// ---- shared row processing --------------------------------------------------

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
  _def: CardigannDefinition,
): ExecutorResult {
  if (!result.magnet && result.infoHash) {
    result.magnet = buildMagnet(result.infoHash, result.title || undefined);
  }
  if (result.magnet && !result.infoHash) {
    result.infoHash = infoHashFromMagnet(result.magnet);
  }
  return result;
}

function processRow(
  engine: SelectorEngine,
  row: unknown,
  fields: CardigannDefinition["search"]["fields"],
  vars: TemplateVars,
  catMap: CategoryMap,
  siteLink: string,
  searchUrl: string,
  def: CardigannDefinition,
): ExecutorResult | null {
  const result = blankResult();
  let fatal = false;
  for (const { key, value } of fields) {
    const { name, modifiers, optional } = parseField(key);
    try {
      let v = engine.handleSelector(value, row, vars, !optional);
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
  if (fatal) return null;
  const finished = finalize(result, def);
  if ((finished.magnet || finished.downloadUrl) && finished.title) {
    return finished;
  }
  return null;
}

// ---- response parsing -------------------------------------------------------

/**
 * Parse a response body (HTML, XML, or JSON) into results, using a selector
 * engine strategy so the row-loop lives once.
 */
export function parseResults(
  text: string,
  def: CardigannDefinition,
  catMap: CategoryMap,
  vars: TemplateVars,
  siteLink: string,
  searchUrl: string,
  engine: SelectorEngine,
): ExecutorResult[] {
  const rows = engine.parseRows(def.search, text, vars);
  const out: ExecutorResult[] = [];
  for (const row of rows) {
    // `.Result.*` values are row-local template state. Sharing `vars` here
    // lets an optional field missing in this row resolve from a previous row.
    const rowVars = { ...vars };
    const result = processRow(
      engine,
      row,
      def.search.fields,
      rowVars,
      catMap,
      siteLink,
      searchUrl,
      def,
    );
    if (result) out.push(result);
  }
  return out;
}

/** @deprecated Use parseResults with htmlEngine instead. */
export function parseHtmlResults(
  html: string,
  def: CardigannDefinition,
  catMap: CategoryMap,
  vars: TemplateVars,
  siteLink: string,
  searchUrl: string,
  isXml: boolean,
): ExecutorResult[] {
  return parseResults(html, def, catMap, vars, siteLink, searchUrl, isXml ? xmlEngine : htmlEngine);
}

/** @deprecated Use parseResults with jsonEngine instead. */
export function parseJsonResults(
  text: string,
  def: CardigannDefinition,
  catMap: CategoryMap,
  vars: TemplateVars,
  siteLink: string,
  searchUrl: string,
): ExecutorResult[] {
  return parseResults(text, def, catMap, vars, siteLink, searchUrl, jsonEngine);
}

export { type SelectorEngine, htmlEngine, xmlEngine, jsonEngine };

function responseType(searchPath: CardigannSearchPath | undefined): string {
  return (searchPath?.response?.type ?? "html").toLowerCase();
}

function buildSearchHeaders(
  def: CardigannDefinition,
  vars: TemplateVars,
): Record<string, string> {
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (def.search.headers) {
    for (const [k, v] of Object.entries(def.search.headers)) {
      if (Array.isArray(v) && v[0] != null) {
        headers[k] = applyTemplate(v[0], vars);
      }
    }
  }
  return headers;
}

async function fetchSearchPage(
  req: { url: string; method: string; form?: Record<string, string> },
  headers: Record<string, string>,
  opts: ExecuteOptions,
): Promise<string> {
  const body =
    req.method === "post" && req.form
      ? new URLSearchParams(req.form).toString()
      : undefined;
  const requestHeaders = { ...headers };
  if (
    body !== undefined &&
    !Object.keys(requestHeaders).some((key) => key.toLowerCase() === "content-type")
  ) {
    requestHeaders["Content-Type"] =
      "application/x-www-form-urlencoded;charset=UTF-8";
  }

  const res = await fetchResilient(req.url, {
    method: req.method.toUpperCase(),
    headers: requestHeaders,
    body,
    signal: opts.signal,
    fetchImpl: (url, init) => governedFetch(opts, url, init),
    retries: 1,
  });
  if (!res.ok) {
    await disposeResponse(res);
    throw new HttpError(res.status, `request returned ${res.status}`);
  }
  return res.text();
}

function selectEngine(searchPath: CardigannSearchPath): SelectorEngine {
  const type = responseType(searchPath);
  if (type === "json") return jsonEngine;
  if (type === "xml") return xmlEngine;
  return htmlEngine;
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
  const targets = pending.slice(0, 20);

  await mapPool(targets, 6, async (r) => {
    try {
      const html = await fetchResilient(r.detailsUrl!, {
        headers: { "User-Agent": USER_AGENT },
        signal: opts.signal,
        fetchImpl: (url, init) => governedFetch(opts, url, init),
        retries: 0,
      });
      if (!html.ok) {
        await disposeResponse(html);
        return;
      }
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
  });
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

    const headers = buildSearchHeaders(def, vars);
    const text = await fetchSearchPage(req, headers, opts);

    const nrm = searchPath.response?.noResultsMessage;
    if (nrm && text.includes(nrm)) continue;

    const engine = selectEngine(searchPath);
    collected.push(
      ...parseResults(text, def, catMap, vars, siteLink, req.url, engine),
    );
  }
  await resolveDownloadInfohashes(def, collected, vars, opts);
  return collected;
}

export { type CardigannRows };
