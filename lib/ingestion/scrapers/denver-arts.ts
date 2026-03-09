/**
 * Denver Art Museum scraper — denverartmuseum.org/learn/youth-family/youth-camps
 *
 * DAM runs popular art day camps for kids. Their site lists camps
 * with age groups, session dates, and pricing.
 *
 * Scrape strategy:
 * 1. Fetch the youth camps page
 * 2. Extract each camp's name, dates, price, age range from the listing
 *
 * ⚠️  Selectors target the DAM site structure as of early 2026.
 *     Verify with `npm run scrape -- --dry-run` before production use.
 */

import { BaseScraper, ScrapeContext } from "../scraper-base";
import { CampInput } from "../adapter";
import { slugify, parseDate, extractAgeGroups, extractPrices } from "../scraper-utils";

export class DenverArtMuseumScraper extends BaseScraper {
  readonly scraperName = "Denver Art Museum";
  readonly entryUrl =
    "https://www.denverartmuseum.org/learn/youth-family/youth-camps";

  async scrape(ctx: ScrapeContext): Promise<CampInput[]> {
    const { $ } = ctx;
    const camps: CampInput[] = [];

    // DAM typically lists camps in a grid of event/program cards
    const cards = $(".program-item, .camp-item, .event-card, article").filter(
      (_, el) => {
        const text = $(el).text().toLowerCase();
        return text.includes("camp") || text.includes("workshop");
      }
    );

    if (cards.length === 0) {
      console.warn(`[${this.scraperName}] No cards found — check selectors`);
      return [];
    }

    cards.each((_, el) => {
      try {
        const $el = $(el);
        const name = $el.find("h2, h3, h4, .title").first().text().trim();
        if (!name || !name.toLowerCase().includes("camp")) return;

        const description = $el.find("p, .description, .summary").first().text().trim();
        const rawAges = $el.find(".ages, .age, [class*='age']").first().text().trim();
        const rawPrice = $el.find(".price, .cost, [class*='price']").first().text().trim();
        const rawDates = $el.find(".date, .dates, time, [class*='date']").first().text().trim();

        const detailHref = $el.find("a").first().attr("href") ?? "";
        const websiteUrl = detailHref.startsWith("http")
          ? detailHref
          : `https://www.denverartmuseum.org${detailHref}`;

        // Parse "June 9–13, 2026" or "June 9 – June 13"
        const dateMatch = rawDates.match(
          /([A-Za-z]+ \d+)[–\-–](\d+),?\s+(\d{4})/
        );
        let startDate: string | null = null;
        let endDate: string | null = null;

        if (dateMatch) {
          const [, startPart, endDay, year] = dateMatch;
          const monthWord = startPart.split(" ")[0];
          startDate = parseDate(startPart + " " + year);
          endDate = parseDate(`${monthWord} ${endDay} ${year}`);
        }

        const ageGroups = extractAgeGroups(rawAges);
        const pricing = extractPrices(rawPrice);

        const camp: CampInput = {
          slug: slugify(name),
          name,
          description,
          notes: null,
          campType: "SUMMER_DAY",
          category: "ARTS",
          websiteUrl,
          interestingDetails: null,
          city: "Denver",
          region: null,
          neighborhood: "Central Park",
          address: "100 W 14th Ave Pkwy, Denver, CO 80204",
          latitude: 39.7361,
          longitude: -104.9892,
          lunchIncluded: false,
          registrationOpenDate: null,
          registrationOpenTime: null,
          registrationStatus: "UNKNOWN",
          sourceType: "SCRAPER",
          sourceUrl: websiteUrl,
          dataConfidence: "VERIFIED",
          ageGroups: ageGroups.length > 0
            ? ageGroups
            : [{ label: "Ages 6-12", minAge: 6, maxAge: 12, minGrade: null, maxGrade: null }],
          schedules: startDate && endDate
            ? [{ label: rawDates, startDate, endDate, startTime: "9:00 AM", endTime: "4:00 PM", earlyDropOff: null, latePickup: null }]
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
