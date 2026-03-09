/**
 * GET /api/calendar/export — Export all saved camps as a single .ics calendar.
 * Requires auth session.
 */

import { createClient } from "@/lib/supabase/server";
import { getPool } from "@/lib/db";

function escapeIcs(str: string) {
  return str.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

function toIcsDate(dateStr: string): string {
  return dateStr.replace(/-/g, "");
}

export async function GET() {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const pool = getPool();

  // Get all saved camps with schedules for this user
  const result = await pool.query(
    `SELECT
       c.id, c.slug, c.name, c.description, c.address, c."websiteUrl",
       json_agg(
         json_build_object(
           'id', cs.id,
           'startDate', cs."startDate"::text,
           'endDate', cs."endDate"::text,
           'startTime', cs."startTime",
           'endTime', cs."endTime",
           'label', cs.label
         ) ORDER BY cs."startDate"
       ) FILTER (WHERE cs.id IS NOT NULL) AS schedules
     FROM "UserSave" us
     JOIN "User" u ON u.id = us."userId"
     JOIN "Camp" c ON c.id = us."campId"
     LEFT JOIN "CampSchedule" cs ON cs."campId" = c.id
     WHERE u."authId" = $1
     GROUP BY c.id`,
    [user.id]
  );

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

  for (const camp of result.rows) {
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
