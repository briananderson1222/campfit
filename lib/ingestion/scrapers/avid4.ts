/**
 * Avid4 Adventure scraper — avid4.com/programs
 *
 * Avid4 Adventure runs outdoor/nature day camps across Colorado.
 * Their site lists programs with age ranges, dates, and pricing.
 *
 * Scrape strategy:
 * 1. Fetch the programs/camps listing page
 * 2. Extract each camp card's name, dates, ages, price, description
 * 3. Optionally follow detail links for full descriptions
 *
 * ⚠️  HTML selectors are based on the site structure as of early 2026.
 *     Run `npm run scrape -- --dry-run` to verify before a full run.
 */

import { BaseScraper, ScrapeContext } from "../scraper-base";
import { CampInput } from "../adapter";
import { slugify, parseDate, parseTime, extractAgeGroups, extractPrices } from "../scraper-utils";

export class Avid4Scraper extends BaseScraper {
  readonly scraperName = "Avid4 Adventure";
  readonly entryUrl = "https://avid4.com/day-camps/colorado/";

  async scrape(ctx: ScrapeContext): Promise<CampInput[]> {
    const { $ } = ctx;
    const camps: CampInput[] = [];

    // Avid4 lists programs in cards — adapt selectors to match actual HTML
    const programCards = $(".program-card, .camp-listing-item, article.program");

    if (programCards.length === 0) {
      console.warn(`[${this.scraperName}] No program cards found — check selectors`);
      return [];
    }

    programCards.each((_, el) => {
      try {
        const $el = $(el);

        const name = $el.find("h2, h3, .program-title, .camp-name").first().text().trim();
        if (!name) return;

        const description = $el.find(".program-description, .description, p").first().text().trim();
        const rawAges = $el.find(".ages, .age-range, [data-ages]").first().text().trim();
        const rawPrice = $el.find(".price, .cost, .program-price").first().text().trim();
        const rawDates = $el.find(".dates, .session-dates, .program-dates").first().text().trim();
        const detailUrl = $el.find("a").first().attr("href") ?? "";
        const websiteUrl = detailUrl.startsWith("http")
          ? detailUrl
          : `https://avid4.com${detailUrl}`;

        // Parse a date range like "June 9 – June 13, 2026"
        const dateRangeMatch = rawDates.match(
          /([A-Za-z]+ \d+)[,\s–-]+([A-Za-z]+ \d+,?\s+\d{4})/
        );
        const startDate = dateRangeMatch
          ? parseDate(dateRangeMatch[1] + " 2026")
          : null;
        const endDate = dateRangeMatch
          ? parseDate(dateRangeMatch[2])
          : null;

        const ageGroups = extractAgeGroups(rawAges);
        const pricing = extractPrices(rawPrice);

        const camp: CampInput = {
          slug: slugify(name),
          name,
          description,
          notes: null,
          campType: "SUMMER_DAY",
          category: "NATURE",
          websiteUrl,
          interestingDetails: null,
          city: "Denver",
          region: null,
          neighborhood: "",
          address: "",
          latitude: null,
          longitude: null,
          lunchIncluded: false,
          registrationOpenDate: null,
          registrationOpenTime: null,
          registrationStatus: "UNKNOWN",
          sourceType: "SCRAPER",
          sourceUrl: websiteUrl,
          dataConfidence: "VERIFIED",
          ageGroups: ageGroups.length > 0 ? ageGroups : [{ label: rawAges || "Ages 6-17", minAge: 6, maxAge: 17, minGrade: null, maxGrade: null }],
          schedules: startDate && endDate
            ? [{ label: rawDates, startDate, endDate, startTime: "9:00 AM", endTime: "3:00 PM", earlyDropOff: null, latePickup: null }]
            : [],
          pricing: pricing.length > 0 ? pricing : [],
        };

        camps.push(camp);
      } catch (err) {
        console.error(`[${this.scraperName}] Error parsing card:`, err);
      }
    });

    return camps;
  }
}
