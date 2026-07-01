import { parse as parseYaml } from "yaml";
import type {
  CardigannDefinition,
  CardigannDownloadBlock,
  CardigannDownloadSelector,
  CardigannFilter,
  CardigannRows,
  CardigannSearch,
  CardigannSearchPath,
  CardigannSelector,
} from "./model";

export class UnsupportedDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedDefinitionError";
  }
}

function asFilters(raw: unknown): CardigannFilter[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: CardigannFilter[] = [];
  for (const f of raw) {
    if (f && typeof f === "object" && "name" in f) {
      const obj = f as { name: unknown; args?: unknown };
      out.push({
        name: String(obj.name),
        args: obj.args as string | string[] | null | undefined,
      });
    }
  }
  return out;
}

function asSelector(raw: unknown): CardigannSelector {
  // A field can be a bare string (shorthand for { selector: "..." }) or, when
  // it starts with no selector, just text. Cardigann treats a plain-string
  // field value as the selector.
  if (typeof raw === "string") return { selector: raw };
  if (!raw || typeof raw !== "object") return {};
  const o = raw as Record<string, unknown>;
  return {
    selector: o.selector != null ? String(o.selector) : undefined,
    optional: o.optional === true,
    default: o.default != null ? String(o.default) : undefined,
    text: o.text != null ? String(o.text) : undefined,
    attribute: o.attribute != null ? String(o.attribute) : undefined,
    remove: o.remove != null ? String(o.remove) : undefined,
    filters: asFilters(o.filters),
    case:
      o.case && typeof o.case === "object"
        ? (Object.fromEntries(
            Object.entries(o.case as Record<string, unknown>).map(([k, v]) => [
              k,
              String(v),
            ]),
          ) as Record<string, string>)
        : undefined,
  };
}

function asRows(raw: unknown): CardigannRows {
  const sel = asSelector(raw);
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    ...sel,
    after: typeof o.after === "number" ? o.after : undefined,
    count: o.count ? asSelector(o.count) : undefined,
    multiple: o.multiple === true,
    missingAttributeEqualsNoResults: o.missingAttributeEqualsNoResults === true,
  };
}

function asSearchPaths(search: Record<string, unknown>): CardigannSearchPath[] {
  const out: CardigannSearchPath[] = [];
  if (Array.isArray(search.paths)) {
    for (const p of search.paths as Record<string, unknown>[]) {
      out.push({
        path: String(p.path ?? ""),
        method: p.method != null ? String(p.method) : undefined,
        inputs: (p.inputs as Record<string, string>) ?? undefined,
        categories: Array.isArray(p.categories)
          ? (p.categories as unknown[]).map(String)
          : undefined,
        inheritinputs: p.inheritinputs !== false,
        response:
          p.response && typeof p.response === "object"
            ? {
                type: (p.response as Record<string, unknown>).type as string,
                noResultsMessage: (p.response as Record<string, unknown>)
                  .noResultsMessage as string,
              }
            : undefined,
      });
    }
  } else if (typeof search.path === "string") {
    out.push({ path: search.path, inheritinputs: true });
  }
  return out;
}

function asSearch(raw: unknown): CardigannSearch {
  const o = (raw ?? {}) as Record<string, unknown>;
  // `fields` is an ordered map in YAML; preserve insertion order and allow
  // duplicate-ish keys (e.g. "title|append") by reading entries directly.
  const fields: { key: string; value: CardigannSelector }[] = [];
  if (o.fields && typeof o.fields === "object") {
    for (const [key, value] of Object.entries(o.fields as Record<string, unknown>)) {
      fields.push({ key, value: asSelector(value) });
    }
  }
  if (!o.rows) {
    throw new UnsupportedDefinitionError("definition has no search.rows");
  }
  return {
    path: o.path != null ? String(o.path) : undefined,
    paths: asSearchPaths(o),
    headers: o.headers as Record<string, string[]> | undefined,
    keywordsfilters: asFilters(o.keywordsfilters),
    allowEmptyInputs: o.allowEmptyInputs === true,
    inputs: (o.inputs as Record<string, string>) ?? undefined,
    preprocessingfilters: asFilters(o.preprocessingfilters),
    rows: asRows(o.rows),
    fields,
  };
}

function asDownloadSelector(raw: unknown): CardigannDownloadSelector | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  return {
    selector: o.selector != null ? String(o.selector) : undefined,
    attribute: o.attribute != null ? String(o.attribute) : undefined,
    filters: asFilters(o.filters),
  };
}

function asDownloadBlock(raw: unknown): CardigannDownloadBlock | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Record<string, unknown>;
  if (!o.infohash || typeof o.infohash !== "object") return undefined;
  const ih = o.infohash as Record<string, unknown>;
  return {
    infohash: {
      hash: asDownloadSelector(ih.hash),
      title: asDownloadSelector(ih.title),
    },
  };
}

/**
 * Reject definitions that require features outside the public, no-auth subset.
 * Throws the first UnsupportedDefinitionError encountered; returns the parsed
 * record otherwise so the caller can continue building the typed model.
 */
function assertSupported(raw: Record<string, unknown>): {
  type: string;
  links: string[];
} {
  const type = String(raw.type ?? "");
  if (type !== "public") {
    throw new UnsupportedDefinitionError(
      `unsupported indexer type "${type || "unknown"}" (public only)`,
    );
  }
  if (raw.login) {
    throw new UnsupportedDefinitionError("definition requires login (unsupported)");
  }

  const links = Array.isArray(raw.links)
    ? (raw.links as unknown[]).map(String).filter(Boolean)
    : [];
  if (links.length === 0) {
    throw new UnsupportedDefinitionError("definition has no links");
  }

  if (!raw.search) {
    throw new UnsupportedDefinitionError("definition has no search block");
  }
  return { type, links };
}

/**
 * Build the typed CardigannDefinition from an already-validated raw record.
 * Pure mapping: no further validation throws here.
 */
function buildDefinition(
  raw: Record<string, unknown>,
  type: string,
  links: string[],
): CardigannDefinition {
  return {
    id: String(raw.id ?? ""),
    name: String(raw.name ?? raw.id ?? "Unknown"),
    description: raw.description != null ? String(raw.description) : undefined,
    type,
    language: raw.language != null ? String(raw.language) : undefined,
    encoding: raw.encoding != null ? String(raw.encoding) : "UTF-8",
    requestDelay: typeof raw.requestDelay === "number" ? raw.requestDelay : undefined,
    links,
    legacylinks: Array.isArray(raw.legacylinks)
      ? (raw.legacylinks as unknown[]).map(String)
      : undefined,
    settings: Array.isArray(raw.settings)
      ? (raw.settings as Record<string, unknown>[]).map((s) => ({
          name: String(s.name ?? ""),
          type: String(s.type ?? "text"),
          label: s.label != null ? String(s.label) : undefined,
          default: s.default != null ? String(s.default) : undefined,
          options: s.options as Record<string, string> | undefined,
        }))
      : undefined,
    caps: {
      categories: (raw.caps as Record<string, unknown>)?.categories as
        | Record<string, string>
        | undefined,
      categorymappings: Array.isArray(
        (raw.caps as Record<string, unknown>)?.categorymappings,
      )
        ? ((raw.caps as Record<string, unknown>).categorymappings as Record<
            string,
            unknown
          >[]).map((c) => ({
            id: String(c.id),
            cat: c.cat != null ? String(c.cat) : undefined,
            desc: c.desc != null ? String(c.desc) : undefined,
            default: c.default === true,
          }))
        : undefined,
      modes: (raw.caps as Record<string, unknown>)?.modes as
        | Record<string, string[]>
        | undefined,
      allowrawsearch:
        (raw.caps as Record<string, unknown>)?.allowrawsearch === true,
    },
    search: asSearch(raw.search),
    download: asDownloadBlock(raw.download),
  };
}

/**
 * Parse a Cardigann YAML string into the typed model, rejecting definitions
 * that require features outside the public, no-auth subset.
 */
export function loadDefinition(yaml: string): CardigannDefinition {
  const raw = parseYaml(yaml) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") {
    throw new UnsupportedDefinitionError("empty or invalid YAML");
  }
  const { type, links } = assertSupported(raw);
  return buildDefinition(raw, type, links);
}

/** True if a setting field implies the source needs user-provided secrets. */
export function definitionRequiresConfig(def: CardigannDefinition): boolean {
  return (def.settings ?? []).some((s) =>
    ["password", "cookie"].includes(s.type) ||
    ["apikey", "rsskey", "cookie", "passkey"].includes(s.name.toLowerCase()),
  );
}
