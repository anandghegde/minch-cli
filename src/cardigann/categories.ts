import type { CardigannCaps, CardigannCategoryMapping } from "./model";

// Newznab/Torznab standard category ids → coarse label, for display grouping.
// We don't need the full tree; just enough to bucket results.
const STANDARD: Record<number, string> = {
  1000: "Console",
  2000: "Movies",
  3000: "Audio",
  4000: "PC",
  4050: "Games",
  5000: "TV",
  6000: "XXX",
  7000: "Books",
  8000: "Other",
};

function coarseLabel(catName: string | undefined): string | undefined {
  if (!catName) return undefined;
  // Cardigann cat names look like "Movies/HD", "TV/Anime", "PC/Games".
  const head = catName.split("/")[0]!;
  return head;
}

export interface CategoryMap {
  /** site category id → coarse label (e.g. "Movies", "TV", "PC/Games"). */
  byId: Map<string, string>;
  /** site category description → coarse label. */
  byDesc: Map<string, string>;
}

export function buildCategoryMap(caps: CardigannCaps): CategoryMap {
  const byId = new Map<string, string>();
  const byDesc = new Map<string, string>();

  if (caps.categories) {
    for (const [id, cat] of Object.entries(caps.categories)) {
      const label = coarseLabel(cat);
      if (label) byId.set(id, label);
    }
  }
  for (const m of caps.categorymappings ?? []) {
    const label = coarseLabel(m.cat);
    if (label) {
      byId.set(m.id, label);
      if (m.desc) byDesc.set(m.desc, label);
    }
  }
  return { byId, byDesc };
}

export function mapCategory(map: CategoryMap, value: string): string | undefined {
  if (!value) return undefined;
  return map.byId.get(value) ?? map.byDesc.get(value);
}

export { STANDARD as STANDARD_CATEGORIES, type CardigannCategoryMapping };
