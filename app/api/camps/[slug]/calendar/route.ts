/**
 * GET /api/camps/[slug]/calendar — Download .ics file for a camp.
 * Returns all sessions as VEVENT entries.
 */

export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getCampBySlug } from "@/lib/camp-repository";

function escapeIcs(str: string) {
  return str.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function toIcsDate(dateStr: string): string {
  // dateStr is "YYYY-MM-DD"
  return dateStr.replace(/-/g, "");
}

function buildIcs(events: { uid: string; summary: string; description: string; location: string; dtstart: string; dtend: string; url: string }[]): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//CampFit//CampFit//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:CampFit",
    "X-WR-TIMEZONE:America/Denver",
  ];

  for (const evt of events) {
    lines.push(
      "BEGIN:VEVENT",
      `UID:${evt.uid}`,
      `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").split(".")[0]}Z`,
      `DTSTART;VALUE=DATE:${evt.dtstart}`,
      `DTEND;VALUE=DATE:${evt.dtend}`,
      `SUMMARY:${escapeIcs(evt.summary)}`,
      `DESCRIPTION:${escapeIcs(evt.description)}`,
      ...(evt.location ? [`LOCATION:${escapeIcs(evt.location)}`] : []),
      ...(evt.url ? [`URL:${evt.url}`] : []),
      "END:VEVENT"
    );
  }

  lines.push("END:VCALENDAR");
  // ICS lines must be CRLF-terminated
  return lines.join("\r\n") + "\r\n";
}

export async function GET(
  _request: Request,
  { params }: { params: { slug: string } }
) {
  const camp = await getCampBySlug(params.slug);
  if (!camp) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const baseUrl = "https://camp.fit";
  const campUrl = `${baseUrl}/camps/${camp.slug}`;
  const description = [
    camp.description?.slice(0, 200),
    camp.pricing.length > 0
      ? `Pricing: ${camp.pricing.map((p) => `${p.label} $${p.amount}`).join(", ")}`
      : null,
    `Details: ${campUrl}`,
  ]
    .filter(Boolean)
    .join("\n");

  const events = camp.schedules.map((s) => ({
    uid: `campfit-${camp.id}-${s.id}@camp-scout-pied.vercel.app`,
    summary: camp.name,
    description,
    location: camp.address || "Denver, CO",
    dtstart: toIcsDate(s.startDate),
    // ICS all-day DTEND is exclusive (day after end)
    dtend: (() => {
      const d = new Date(s.endDate + "T12:00:00");
      d.setDate(d.getDate() + 1);
      return d.toISOString().slice(0, 10).replace(/-/g, "");
    })(),
    url: camp.websiteUrl || campUrl,
  }));

  if (events.length === 0) {
    // Create a single placeholder event if no schedule
    const today = new Date();
    events.push({
      uid: `campfit-${camp.id}@camp-scout-pied.vercel.app`,
      summary: camp.name,
      description,
      location: camp.address || "Denver, CO",
      dtstart: today.toISOString().slice(0, 10).replace(/-/g, ""),
      dtend: today.toISOString().slice(0, 10).replace(/-/g, ""),
      url: camp.websiteUrl || campUrl,
    });
  }

  const icsContent = buildIcs(events);
  const filename = `${camp.slug}-camp.ics`;

  return new Response(icsContent, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "public, max-age=3600",
    },
  });
}
