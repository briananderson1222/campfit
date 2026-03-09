/**
 * GET /llms.txt — LLM-friendly site guide following the llms.txt standard.
 * https://llmstxt.org/
 *
 * Curated index of CampScout: what it is, key pages, and links to all camps.
 * For full inlined camp data, see /llms-full.txt
 */

export const dynamic = "force-dynamic";
export const revalidate = 3600;

import { getCampSlugs } from "@/lib/camp-repository";
import { CATEGORY_LABELS, CAMP_TYPE_LABELS } from "@/lib/types";

const BASE = "https://camp-scout-pied.vercel.app";

export async function GET() {
  const camps = await getCampSlugs();

  // Group by first letter for readability
  const lines: string[] = [
    `# CampScout`,
    ``,
    `> CampScout is a directory of kids' camps in Denver, Colorado. Parents can search, filter, save, and compare camps by age group, category (sports, arts, STEM, nature, theater, cooking, music, academic), camp type (summer day, sleepaway, winter break, school break), neighborhood, weekly availability, and cost. The site currently lists ${camps.length} camps.`,
    ``,
    `CampScout is built for Denver-area parents planning summer and school-break activities for children. All camp data includes pricing tiers, age ranges, weekly schedules, registration status, and direct links to camp registration pages.`,
    ``,
    `## Key Pages`,
    ``,
    `- [Home / Search](${BASE}/): Search and filter all ${camps.length} Denver camps by age, category, type, neighborhood, cost, and week`,
    `- [Weekly Calendar](${BASE}/calendar): Interactive Gantt-style calendar showing which camps run each week of summer`,
    `- [Compare Camps](${BASE}/compare): Side-by-side comparison of up to 3 camps (pricing, hours, ages, weekly availability, lunch)`,
    `- [sitemap.xml](${BASE}/sitemap.xml): Full site map`,
    ``,
    `## Camp Categories`,
    ``,
    Object.entries(CATEGORY_LABELS)
      .map(([key, label]) => `- **${label}**: \`category=${key}\``)
      .join("\n"),
    ``,
    `## Camp Types`,
    ``,
    Object.entries(CAMP_TYPE_LABELS)
      .map(([key, label]) => `- **${label}**: \`campType=${key}\``)
      .join("\n"),
    ``,
    `## All Camps (${camps.length} total)`,
    ``,
    `Each camp page includes: full description, pricing tiers, age groups, weekly schedule availability, registration status and opening date, location/neighborhood, lunch/extended care info, and a direct link to the camp's registration website.`,
    ``,
    ...camps.map(
      (c) => `- [${c.name}](${BASE}/camps/${c.slug})`
    ),
    ``,
    `## Optional`,
    ``,
    `- [llms-full.txt](${BASE}/llms-full.txt): All camp data inlined as markdown — use this when you need to answer questions about specific camps without fetching individual pages`,
    `- [robots.txt](${BASE}/robots.txt): Crawler access rules`,
  ];

  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    },
  });
}
