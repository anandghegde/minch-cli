import type { CatalogTitle } from "./types";
import { cleanText } from "../util/format";

/**
 * Build the only query that Discover may hand to torrent search.
 *
 * Discovery event metadata is deliberately not accepted here: providers,
 * formats, languages, and source labels are evidence about availability, not
 * part of a title search.
 */
export function buildDiscoverySearchQuery(
  title: Pick<CatalogTitle, "title" | "year"> | undefined,
): string | undefined {
  if (!title) return undefined;
  const cleanTitle = cleanText(title.title);
  if (!cleanTitle) return undefined;
  return `${cleanTitle}${title.year ? ` ${title.year}` : ""}`;
}
