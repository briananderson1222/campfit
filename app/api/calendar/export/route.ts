/**
 * GET /api/calendar/export — Export all saved camps as a single .ics calendar.
 * Requires auth session.
 */

import { createClient } from "@/lib/supabase/server";
import { getSavedCampCalendarRows } from "@/lib/calendar-repository";

function escapeIcs(str: string) {
  return str.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function toIcsDate(dateStr: string): string {
  return dateStr.replace(/-/g, "");
}

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Get all saved camps with schedules for this user
  const rows = await getSavedCampCalendarRows(user.id);

  const baseUrl = "https://camp.fit";
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//CampFit//CampFit//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:My CampFit Camps",
    "X-WR-TIMEZONE:America/Denver",
  ];

  for (const camp of rows) {
    const schedules = camp.schedules || [];
    const description = [
      camp.description?.slice(0, 200),
      `Details: ${baseUrl}/camps/${camp.slug}`,
    ]
      .filter(Boolean)
      .join("\\n");

    if (schedules.length === 0) continue;

    for (const s of schedules) {
      const dtend = (() => {
        const d = new Date(s.startDate + "T12:00:00");
        d.setDate(d.getDate() + 7);
        return d.toISOString().slice(0, 10).replace(/-/g, "");
      })();

      lines.push(
        "BEGIN:VEVENT",
        `UID:campfit-${camp.id}-${s.id}@camp-scout-pied.vercel.app`,
        `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").split(".")[0]}Z`,
        `DTSTART;VALUE=DATE:${toIcsDate(s.startDate)}`,
        `DTEND;VALUE=DATE:${s.endDate ? toIcsDate(s.endDate) : dtend}`,
        `SUMMARY:${escapeIcs(camp.name)}`,
        `DESCRIPTION:${description}`,
        ...(camp.address ? [`LOCATION:${escapeIcs(camp.address)}`] : []),
        ...(camp.websiteUrl ? [`URL:${camp.websiteUrl}`] : []),
        "END:VEVENT"
      );
    }
  }

  lines.push("END:VCALENDAR");
  const icsContent = lines.join("\r\n") + "\r\n";

  return new Response(icsContent, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="my-campfit-camps.ics"',
      "Cache-Control": "no-store",
    },
  });
}
