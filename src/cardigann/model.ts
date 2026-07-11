// Typed model for the subset of the Cardigann definition format that minch-cli
// supports. Mirrors Prowlarr's CardigannDefinition.cs, but only the fields the
// scoped (public, no-login) interpreter actually reads. Anything related to
// login/auth/captcha/ratio is intentionally omitted.

export interface CardigannFilter {
  name: string;
  // args may be a single string, a list, or absent depending on the filter.
  args?: string | string[] | null;
}

export interface CardigannSelector {
  selector?: string;
  optional?: boolean;
  default?: string;
  text?: string;
  attribute?: string;
  remove?: string;
  filters?: CardigannFilter[];
  case?: Record<string, string>;
}

export interface CardigannRows extends CardigannSelector {
  after?: number;
  count?: CardigannSelector;
  multiple?: boolean;
  missingAttributeEqualsNoResults?: boolean;
}

export interface CardigannSearchPath {
  path: string;
  method?: string;
  inputs?: Record<string, string>;
  categories?: string[];
  inheritinputs?: boolean;
  response?: { type?: string; noResultsMessage?: string };
}

export interface CardigannCategoryMapping {
  id: string;
  cat?: string;
  desc?: string;
  default?: boolean;
}

export interface CardigannCaps {
  categories?: Record<string, string>;
  categorymappings?: CardigannCategoryMapping[];
  modes?: Record<string, string[]>;
  allowrawsearch?: boolean;
}

export interface CardigannSettingsField {
  name: string;
  type: string;
  label?: string;
  default?: string;
  options?: Record<string, string>;
}

export interface CardigannSearch {
  path?: string;
  paths?: CardigannSearchPath[];
  headers?: Record<string, string[]>;
  keywordsfilters?: CardigannFilter[];
  allowEmptyInputs?: boolean;
  inputs?: Record<string, string>;
  preprocessingfilters?: CardigannFilter[];
  rows: CardigannRows;
  // Ordered list of fields. Keys can carry modifiers like "title|append".
  fields: { key: string; value: CardigannSelector }[];
}

export interface CardigannDownloadSelector {
  selector?: string;
  attribute?: string;
  filters?: CardigannFilter[];
}

export interface CardigannDownloadBlock {
  // The infohash block resolves a magnet via a second fetch to the details
  // page when the row itself doesn't expose one. Public-scope only: no
  // before-request, no cookies.
  infohash?: {
    hash?: CardigannDownloadSelector;
    title?: CardigannDownloadSelector;
  };
}

export interface CardigannDefinition {
  id: string;
  name: string;
  description?: string;
  type: string;
  language?: string;
  encoding?: string;
  /** Upstream Cardigann request rate, in requests per second. */
  requestDelay?: number;
  links: string[];
  legacylinks?: string[];
  settings?: CardigannSettingsField[];
  caps: CardigannCaps;
  search: CardigannSearch;
  // The download block (infohash resolution) is supported; login/ratio are
  // parsed only to reject unsupported defs.
  download?: CardigannDownloadBlock;
  login?: unknown;
}
