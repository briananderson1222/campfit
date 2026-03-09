/**
 * GET /llms-full.txt — Complete CampFit camp data as markdown.
 * https://llmstxt.org/
 *
 * All camps inlined with full details — pricing, ages, schedules, registration.
 * Use this when an LLM needs to answer questions about camps without fetching
 * individual pages (e.g. "which STEM camps are under $400/week for ages 8-10?")
 */

export const dynamic = "force-dynamic";
export const revalidate = 3600;

import { getAllCamps } from "@/lib/camp-repository";
import {
  CATEGORY_LABELS,
  CAMP_TYPE_LABELS,
  Camp,
} from "@/lib/types";
import { formatCurrency } from "@/lib/utils";

const BASE = "https://camp.fit";

function campToMarkdown(camp: Camp): string {
  const lines: string[] = [];

  lines.push(`### [${camp.name}](${BASE}/camps/${camp.slug})`);
  lines.push(``);

  const meta: string[] = [
    `**Category:** ${CATEGORY_LABELS[camp.category]}`,
    `**Type:** ${CAMP_TYPE_LABELS[camp.campType]}`,
  ];
  if (camp.neighborhood) meta.push(`**Neighborhood:** ${camp.neighborhood}`);
  if (camp.registrationStatus) meta.push(`**Registration:** ${camp.registrationStatus}`);
  lines.push(meta.join(" · "));
  lines.push(``);

  if (camp.description) {
    lines.push(camp.description);
    lines.push(``);
  }

  // Ages
  if (camp.ageGroups.length > 0) {
    const ageStr = camp.ageGroups.map((ag) => {
      if (ag.minAge !== null && ag.maxAge !== null) {
        return `${ag.label} (ages ${ag.minAge}–${ag.maxAge})`;
      }
      return ag.label;
    }).join(", ");
    lines.push(`**Ages:** ${ageStr}`);
    lines.push(``);
  }

  // Pricing
  if (camp.pricing.length > 0) {
    const priceStr = camp.pricing.map((p) => {
      const unit = p.unit === "PER_WEEK" ? "/week" : p.unit === "PER_DAY" ? "/day" : p.unit === "FLAT" ? " total" : "/session";
      const discount = p.discountNotes ? ` (${p.discountNotes})` : "";
      return `${p.label}: ${formatCurrency(p.amount)}${unit}${discount}`;
    }).join("; ");
    lines.push(`**Pricing:** ${priceStr}`);
    lines.push(``);
  }

  // Schedule / hours
  if (camp.schedules.length > 0) {
    const first = camp.schedules[0];
    if (first.startTime) {
      lines.push(`**Hours:** ${first.startTime}–${first.endTime}`);
    }
    if (first.earlyDropOff) lines.push(`**Early drop-off:** ${first.earlyDropOff}`);
    if (first.latePickup) lines.push(`**Late pickup:** until ${first.latePickup}`);

    if (camp.campType === "SUMMER_DAY") {
      const weekDates = camp.schedules
        .map((s) => s.startDate)
        .sort()
        .join(", ");
      lines.push(`**Available weeks (start dates):** ${weekDates}`);
    }
    lines.push(``);
  }

  if (camp.lunchIncluded) {
    lines.push(`**Lunch:** Included`);
    lines.push(``);
  }

  if (camp.registrationOpenDate) {
    lines.push(`**Registration opens:** ${camp.registrationOpenDate}`);
    lines.push(``);
  }

  if (camp.websiteUrl) {
    lines.push(`**Register:** ${camp.websiteUrl}`);
    lines.push(``);
  }

  if (camp.interestingDetails) {
    lines.push(`> ${camp.interestingDetails}`);
    lines.push(``);
  }

  return lines.join("\n");
}

export async function GET() {
  const camps = await getAllCamps();

  // Group camps by category
  const byCategory = new Map<string, Camp[]>();
  for (const camp of camps) {
    const cat = camp.category;
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(camp);
  }

  const lines: string[] = [
    `# CampFit — Complete Camp Directory`,
    ``,
    `> CampFit lists ${camps.length} kids' camps in Denver, Colorado. Data includes pricing, age groups, weekly schedule availability, registration status, and direct registration links. All prices are in USD.`,
    ``,
    `**Base URL:** ${BASE}`,
    `**Data freshness:** Updated hourly (ISR). Registration status and dates reflect the 2025–2026 season.`,
    ``,
    `**How to use this file:** Search for camp names, filter by category headers, or scan pricing and age data to answer parent questions about Denver kids' camps.`,
    ``,
    `---`,
    ``,
  ];

  for (const [category, categoryCamps] of Array.from(byCategory.entries())) {
    lines.push(`## ${CATEGORY_LABELS[category as keyof typeof CATEGORY_LABELS] ?? category} (${categoryCamps.length} camps)`);
    lines.push(``);
    for (const camp of categoryCamps) {
      lines.push(campToMarkdown(camp));
      lines.push(`---`);
      lines.push(``);
    }
  }

  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
    },
  });
}
