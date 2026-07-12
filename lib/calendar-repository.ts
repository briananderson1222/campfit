import { getPool } from '@/lib/db';

type CalendarSchedule = { id: string; startDate: string; endDate: string | null; startTime: string | null; endTime: string | null; label: string | null };
export type SavedCampCalendarRow = { id: string; slug: string; name: string; description: string | null; address: string | null; websiteUrl: string | null; schedules: CalendarSchedule[] | null };

export async function getSavedCampCalendarRows(authUserId: string): Promise<SavedCampCalendarRow[]> {
  const { rows } = await getPool().query<SavedCampCalendarRow>(
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
    [authUserId]
  );
  return rows;
}
