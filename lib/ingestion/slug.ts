/**
 * slug.ts — the one piece of lib/ingestion/scraper-utils.ts (deleted with the
 * legacy CSS-selector scrapers in the traverse full cutover) still needed:
 * turning a camp/program name into a stable, URL-safe slug for anchoring a
 * traverse-extracted item to a Camp row.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}
