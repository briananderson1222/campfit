/**
 * Harvester for ActivitiesForKids.com — a regional camp directory
 * listing Denver-area summer programs.
 *
 * Target: https://www.activitieskids.com/camps/colorado/denver
 *
 * The site lists camps in paginated card grids. Each card has:
 *   - Camp name (link)
 *   - Organization name
 *   - Short description snippet
 *   - Category tags (Sports, Arts, STEM, etc.)
 *   - Camp website URL (or link to their listing page)
 */

import * as cheerio from 'cheerio';
import { BaseHarvester, HarvestedListing } from './base-harvester';
import type { CampCategory } from '@/lib/types';

// Map aggregator tags → our CampCategory enum
const CATEGORY_MAP: Record<string, CampCategory> = {
  sports: 'SPORTS',
  athletic: 'SPORTS',
  art: 'ARTS',
  arts: 'ARTS',
  creative: 'ARTS',
  music: 'MUSIC',
  stem: 'STEM',
  science: 'STEM',
  technology: 'STEM',
  coding: 'STEM',
  nature: 'NATURE',
  outdoor: 'NATURE',
  environment: 'NATURE',
  academic: 'ACADEMIC',
  theater: 'THEATER',
  drama: 'THEATER',
  cooking: 'COOKING',
  culinary: 'COOKING',
  multi: 'MULTI_ACTIVITY',
  general: 'MULTI_ACTIVITY',
};

function mapCategory(tags: string[]): CampCategory | null {
  for (const tag of tags) {
    const key = tag.toLowerCase().trim();
    for (const [k, v] of Object.entries(CATEGORY_MAP)) {
      if (key.includes(k)) return v;
    }
  }
  return null;
}

const BASE_URL = 'https://www.activitieskids.com';

export class ActivitiesKidsHarvester extends BaseHarvester {
  constructor() {
    super('activitieskids.com');
  }

  async fetchListings(communitySlug = 'denver', limit?: number): Promise<HarvestedListing[]> {
    const listings: HarvestedListing[] = [];
    let page = 1;
    const maxPages = limit ? Math.ceil(limit / 20) : 20; // ~20 results per page, cap at 20 pages

    while (listings.length < (limit ?? Infinity) && page <= maxPages) {
      const url = `${BASE_URL}/camps/colorado/denver${page > 1 ? `?page=${page}` : ''}`;
      let html: string;
      try {
        html = await this.fetchHtml(url);
      } catch (err) {
        console.warn(`  [activitieskids] Failed to fetch page ${page}: ${err}`);
        break;
      }

      const extracted = this.parsePage(html, url);
      if (extracted.length === 0) break; // no more results

      for (const listing of extracted) {
        if (limit && listings.length >= limit) break;
        listings.push({ ...listing, communitySlug });
      }

      page++;
      // Politeness delay between pages
      await new Promise(r => setTimeout(r, 1500));
    }

    return listings;
  }

  private parsePage(html: string, sourceUrl: string): Omit<HarvestedListing, 'communitySlug'>[] {
    const $ = cheerio.load(html);
    const results: Omit<HarvestedListing, 'communitySlug'>[] = [];

    // ActivitiesForKids uses .listing-card or similar — adapt selectors to actual page structure
    // These are best-effort selectors; they'll need tuning after a real fetch.
    const cardSelectors = [
      '.camp-card', '.listing-card', '.result-card',
      'article.camp', '[data-type="camp"]',
    ];
    let cards = $('body').find(cardSelectors.join(', '));

    // Fallback: any article or li with a heading + link
    if (cards.length === 0) {
      cards = $('article, .listing').filter((_, el) => $(el).find('h2, h3').length > 0);
    }

    cards.each((_, el) => {
      const $el = $(el);
      const name = $el.find('h2, h3, .camp-name, .listing-name').first().text().trim();
      if (!name) return;

      // Try to get the camp's own website URL (preferred) vs the aggregator listing URL
      const orgLink = $el.find('a[href*="http"]:not([href*="activitieskids"])').first().attr('href');
      const listingLink = $el.find('a[href]').first().attr('href');
      const websiteUrl = orgLink || (listingLink?.startsWith('/') ? `${BASE_URL}${listingLink}` : listingLink) || '';

      const description = $el.find('p, .description, .excerpt').first().text().trim().slice(0, 500) || null;
      const orgName = $el.find('.org-name, .organization, .provider-name').first().text().trim() || null;

      const tagTexts: string[] = [];
      $el.find('.tag, .category, .badge, [class*="tag"], [class*="category"]').each((_, tag) => {
        tagTexts.push($(tag).text().trim());
      });
      const category = mapCategory(tagTexts);

      results.push({ name, websiteUrl, description, organizationName: orgName, category, sourceUrl });
    });

    return results;
  }
}
