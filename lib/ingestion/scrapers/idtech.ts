/**
 * iD Tech scraper — idtech.com/courses
 *
 * iD Tech runs STEM day/overnight camps (coding, game design, robotics, AI)
 * nationally, including Colorado locations. Their /courses listing embeds a
 * schema.org `CollectionPage` → `ItemList` of `Course` items in a
 * `<script type="application/ld+json">` block, each with a name, description,
 * and `typicalAgeRange` (e.g. "7-9").
 *
 * WHY JSON-LD, NOT CSS SELECTORS (Slice 2b): this is the FIRST source added
 * to the pilot whose legacy scraper is HEALTHY live, so it exists to make the
 * "field agreement on a healthy source" promotion bar (criterion 4) measurable
 * against traverse. Parsing the site's own structured data (rather than the
 * brittle `.card`/`h3` selectors that rotted on avid4 + DAM) is deliberate:
 * it is the robust legacy baseline the parity harness compares traverse to,
 * and it degrades honestly (0 camps + a logged reason) if the JSON-LD shape
 * ever changes, exactly like the other scrapers.
 */

import { BaseScraper, ScrapeContext } from "../scraper-base";
import { CampInput } from "../adapter";
import { slugify } from "../scraper-utils";

interface JsonLdCourse {
  "@type"?: string;
  name?: string;
  url?: string;
  description?: string;
  typicalAgeRange?: string;
}

/** Parse a "7-9" / "7 - 12" / "7+" age range into {minAge, maxAge}. */
function parseAgeRange(raw: string | undefined): { minAge: number | null; maxAge: number | null } {
  if (!raw) return { minAge: null, maxAge: null };
  const range = raw.match(/(\d{1,2})\s*[-–]\s*(\d{1,2})/);
  if (range) return { minAge: Number(range[1]), maxAge: Number(range[2]) };
  const single = raw.match(/(\d{1,2})/);
  if (single) return { minAge: Number(single[1]), maxAge: null };
  return { minAge: null, maxAge: null };
}

/** Depth-first collect every object with `@type` including "Course" from a JSON-LD value. */
function collectCourses(node: unknown, out: JsonLdCourse[]): void {
  if (Array.isArray(node)) {
    for (const n of node) collectCourses(n, out);
    return;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const type = obj["@type"];
    if (typeof type === "string" && type.toLowerCase() === "course" && typeof obj.name === "string") {
      out.push(obj as JsonLdCourse);
    }
    for (const key of Object.keys(obj)) collectCourses(obj[key], out);
  }
}

export class IdTechScraper extends BaseScraper {
  readonly scraperName = "iD Tech";
  readonly sourceKey = "idtech";
  readonly entryUrl = "https://www.idtech.com/courses";

  async scrape(ctx: ScrapeContext): Promise<CampInput[]> {
    const { $ } = ctx;
    const courses: JsonLdCourse[] = [];

    $('script[type="application/ld+json"]').each((_, el) => {
      const raw = $(el).contents().text().trim();
      if (!raw) return;
      try {
        collectCourses(JSON.parse(raw), courses);
      } catch {
        // A single malformed JSON-LD block must not abort the others.
      }
    });

    if (courses.length === 0) {
      console.warn(`[${this.scraperName}] No JSON-LD Course items found — check the /courses markup`);
      return [];
    }

    // De-dupe by name (the listing can repeat a course across sub-lists).
    const seen = new Set<string>();
    const camps: CampInput[] = [];
    for (const c of courses) {
      const name = (c.name ?? "").trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);

      const { minAge, maxAge } = parseAgeRange(c.typicalAgeRange);
      const detailUrl = c.url && c.url.startsWith("http") ? c.url : this.entryUrl;

      camps.push({
        slug: slugify(name),
        name,
        description: (c.description ?? "").trim(),
        notes: null,
        campType: "SUMMER_DAY",
        category: "STEM",
        websiteUrl: detailUrl,
        interestingDetails: null,
        city: "",
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
        sourceUrl: detailUrl,
        dataConfidence: "VERIFIED",
        ageGroups:
          minAge !== null || maxAge !== null
            ? [{ label: c.typicalAgeRange ?? "", minAge, maxAge, minGrade: null, maxGrade: null }]
            : [],
        schedules: [],
        pricing: [],
      });
    }

    return camps;
  }
}
