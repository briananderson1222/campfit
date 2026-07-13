/**
 * Harvester for Camperoni (camperoni.com) — a multi-metro camp directory
 * covering the Denver metro (among others).
 *
 * Camperoni is a Vite single-page app backed by a STATIC JSON API published
 * to a DigitalOcean Spaces CDN (json-api/prod/*.json). We read those
 * pre-generated static files directly rather than driving the SPA — it is
 * the politest possible source (plain CDN reads, zero load on their
 * application servers) and far more robust than scraping client-rendered
 * DOM.
 *
 * Data model (only the fields we need):
 *   metros.json                 -> [{ id, name }]                 (Denver = 6)
 *   camps___metro_id_{id}.json  -> [{ program_provider, corporate_provider, ... }]
 *   providers.json              -> [{ id, name, provider_website, slug, ... }]
 *
 * A "camp" in Camperoni is a single session/program; the crawlable entity in
 * our model is the provider (its own website). So we collect the unique
 * providers referenced by a metro's camps and emit a stub for each provider
 * that advertises a real website — that website is both the dedup key and the
 * seed the standard crawl pipeline later enriches.
 */

import { BaseHarvester, HarvestedListing } from './base-harvester';

const CDN =
  'https://camperoni-com-json.nyc3.cdn.digitaloceanspaces.com/json-api/prod';

interface CamperoniMetro {
  id: number;
  name: string;
}

interface CamperoniCamp {
  program_provider?: number | null;
  corporate_provider?: number | null;
}

interface CamperoniProvider {
  id: number;
  name: string;
  provider_website?: string | null;
  slug?: string | null;
}

export class CamperoniHarvester extends BaseHarvester {
  constructor() {
    super('camperoni.com');
  }

  /** Fetch and parse one static JSON file from the Camperoni CDN. */
  private async fetchJson<T>(fileName: string): Promise<T> {
    const text = await this.fetchHtml(`${CDN}/${fileName}`);
    return JSON.parse(text) as T;
  }

  async fetchListings(
    communitySlug = 'denver',
    limit?: number,
  ): Promise<HarvestedListing[]> {
    const metros = await this.fetchJson<CamperoniMetro[]>('metros.json');
    const target =
      metros.find((m) => m.name.toLowerCase() === communitySlug.toLowerCase()) ??
      metros.find((m) =>
        m.name.toLowerCase().includes(communitySlug.toLowerCase()),
      );
    if (!target) {
      throw new Error(
        `Camperoni has no metro matching community "${communitySlug}". ` +
          `Available: ${metros.map((m) => m.name).join(', ')}`,
      );
    }

    const [camps, providers] = await Promise.all([
      this.fetchJson<CamperoniCamp[]>(`camps___metro_id_${target.id}.json`),
      this.fetchJson<CamperoniProvider[]>('providers.json'),
    ]);
    const providerById = new Map(providers.map((p) => [p.id, p]));

    // Unique providers referenced by this metro's camps (program provider
    // preferred over corporate provider — it's the more specific entity).
    const providerIds = new Set<number>();
    for (const camp of camps) {
      const id = camp.program_provider ?? camp.corporate_provider;
      if (id != null) providerIds.add(id);
    }

    // The camps listing page is the honest "found here" source for every
    // stub; we don't fabricate per-provider page URLs.
    const sourceUrl = 'https://www.camperoni.com/camps';
    const listings: HarvestedListing[] = [];
    for (const id of providerIds) {
      const provider = providerById.get(id);
      if (!provider || !provider.provider_website) continue; // no crawlable seed
      const websiteUrl = normalizeUrl(provider.provider_website);
      if (!websiteUrl) continue;

      listings.push({
        name: provider.name,
        websiteUrl,
        organizationName: provider.name,
        communitySlug,
        city: target.name,
        sourceUrl,
      });
      if (limit && listings.length >= limit) break;
    }

    return listings;
  }
}

/** Coerce a provider website string into a normalized absolute URL, or null. */
function normalizeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}
