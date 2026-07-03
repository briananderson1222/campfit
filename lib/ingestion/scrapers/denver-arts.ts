/**
 * Denver Art Museum scraper — denverartmuseum.org/en/summer-camps
 *
 * DAM runs popular art day camps for kids. Their site lists camps
 * with age groups, session dates, and pricing.
 *
 * Scrape strategy:
 * 1. Fetch the youth camps page
 * 2. Extract each camp's name, dates, price, age range from the listing
 *
 * ⚠️  NEEDS REVIEW (2026-07): the original entryUrl
 *     (denverartmuseum.org/learn/youth-family/youth-camps) started
 *     returning HTTP 404 the week of 2026-06-15, failing the weekly
 *     scrape workflow (see scrape.yml run history). The site's
 *     sitemap.xml shows the camps page moved to
 *     denverartmuseum.org/en/summer-camps (confirmed 200 OK,
 *     <title>Summer Camps | Denver Art Museum</title>), so the entryUrl
 *     below has been updated to that URL. HOWEVER the page markup has
 *     changed substantially (no `.program-item` / `.camp-item` /
 *     `.event-card` / `<article>` cards were found in a manual check),
 *     so the selectors in `scrape()` below are almost certainly stale
 *     and this scraper likely now returns 0 camps. Owner: please
 *     re-verify selectors against the live page with
 *     `npm run scrape -- --scraper "denver art" --dry-run` and update
 *     `scrape()` accordingly. Left in the registry (not disabled) so
 *     the 0-camps-found case stays visible in the scrape report rather
 *     than silently disappearing.
 *
 * ⚠️  Selectors target the DAM site structure as of early 2026.
 *     Verify with `npm run scrape -- --dry-run` before production use.
 */

import { BaseScraper, ScrapeContext } from "../scraper-base";
import { CampInput } from "../adapter";
import { slugify, parseDate, extractAgeGroups, extractPrices } from "../scraper-utils";

export class DenverArtMuseumScraper extends BaseScraper {
  readonly scraperName = "Denver Art Museum";
  readonly sourceKey = "denver-art-museum";
  readonly entryUrl =
    "https://www.denverartmuseum.org/en/summer-camps"; // NEEDS REVIEW — see file header, URL changed 2026-06-15+, selectors unverified against new markup

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
