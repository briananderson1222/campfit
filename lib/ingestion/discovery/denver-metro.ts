/**
 * lib/ingestion/discovery/denver-metro.ts — the Denver-metro boundary (R1/AC1).
 *
 * "Denver metro only" is a hard scope boundary for I22 (#52); new metros are an
 * explicit owner non-goal. Membership here is a curated allowlist of the
 * municipalities in the Denver-Aurora-Lakewood MSA (Adams, Arapahoe, Broomfield,
 * Clear Creek, Denver, Douglas, Elbert, Gilpin, Jefferson, Park counties).
 * Boulder County (Boulder/Louisville/Lafayette/Erie/Superior) is a separate MSA
 * and is intentionally NOT included, matching a conservative "Denver metro"
 * reading. A candidate whose city is not on this list is out-of-metro and is
 * excluded from the queue (the runner records the exclusion count for evidence).
 *
 * This is a curated list, not a geocoder — the thinnest slice. A future source
 * with lat/long can add a geometric check behind the same isDenverMetro() gate.
 */

const DENVER_METRO_CITIES = new Set(
  [
    // Denver County
    "denver",
    // Arapahoe County
    "aurora", "centennial", "littleton", "englewood", "greenwood village",
    "sheridan", "glendale", "cherry hills village", "columbine valley", "bow mar",
    "foxfield", "deer trail",
    // Jefferson County
    "lakewood", "arvada", "wheat ridge", "golden", "edgewater", "morrison",
    "westminster", "ken caryl", "columbine",
    // Adams County
    "thornton", "northglenn", "commerce city", "brighton", "federal heights",
    "bennett",
    // Broomfield County
    "broomfield",
    // Douglas County
    "highlands ranch", "parker", "castle rock", "castle pines", "lone tree",
    "roxborough park", "the pinery",
    // Clear Creek / Gilpin / Park (mountain fringe of the MSA)
    "idaho springs", "georgetown", "black hawk", "central city",
  ].map((c) => c.trim()),
);

/** Normalize a city string for allowlist comparison. */
export function normalizeCity(city: string | null | undefined): string {
  return (city ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** True when `city` is a municipality in the Denver-Aurora-Lakewood metro. */
export function isDenverMetro(city: string | null | undefined): boolean {
  const normalized = normalizeCity(city);
  if (!normalized) return false;
  return DENVER_METRO_CITIES.has(normalized);
}
