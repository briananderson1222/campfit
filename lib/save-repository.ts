import { getPool } from '@/lib/db';
import type { SavedCamp } from '@/lib/types';

export async function getSavedCamps(userId: string): Promise<SavedCamp[]> {
  const { rows } = await getPool().query(
    `SELECT sc.id, sc."campId", sc."savedAt"::text, sc."notifyEmail", sc."notifyPush", sc."notifySms", sc.notes,
      c.*, c."registrationOpenDate"::text AS "registrationOpenDate",
      c."registrationCloseDate"::text AS "registrationCloseDate",
      COALESCE(json_agg(DISTINCT jsonb_build_object(
        'id', ag."id", 'label', ag."label", 'minAge', ag."minAge", 'maxAge', ag."maxAge",
        'minGrade', ag."minGrade", 'maxGrade', ag."maxGrade"
      )) FILTER (WHERE ag."id" IS NOT NULL), '[]') AS "ageGroups",
      COALESCE(json_agg(DISTINCT jsonb_build_object(
        'id', s."id", 'label', s."label", 'startDate', s."startDate"::text, 'endDate', s."endDate"::text,
        'startTime', s."startTime", 'endTime', s."endTime", 'earlyDropOff', s."earlyDropOff", 'latePickup', s."latePickup"
      )) FILTER (WHERE s."id" IS NOT NULL), '[]') AS "schedules",
      COALESCE(json_agg(DISTINCT jsonb_build_object(
        'id', p."id", 'label', p."label", 'amount', p."amount"::float, 'unit', p."unit",
        'durationWeeks', p."durationWeeks", 'ageQualifier', p."ageQualifier", 'discountNotes', p."discountNotes"
      )) FILTER (WHERE p."id" IS NOT NULL), '[]') AS "pricing"
    FROM "SavedCamp" sc JOIN "Camp" c ON c.id = sc."campId"
    LEFT JOIN "CampAgeGroup" ag ON ag."campId" = c.id
    LEFT JOIN "CampSchedule" s ON s."campId" = c.id
    LEFT JOIN "CampPricing" p ON p."campId" = c.id
    WHERE sc."userId" = $1 GROUP BY sc.id, c.id ORDER BY sc."savedAt" DESC`,
    [userId],
  );
  return rows.map((row) => ({
    id: row.id, campId: row.campId, savedAt: row.savedAt,
    notifyEmail: row.notifyEmail, notifyPush: row.notifyPush, notifySms: row.notifySms, notes: row.notes,
    camp: {
      id: row.campId, slug: row.slug, name: row.name, description: row.description, notes: row.notes,
      campType: row.campType, category: row.category,
      campTypes: row.campTypes ?? (row.campType ? [row.campType] : []),
      categories: row.categories ?? (row.category ? [row.category] : []),
      state: row.state ?? null, zip: row.zip ?? null, websiteUrl: row.websiteUrl,
      interestingDetails: row.interestingDetails, city: row.city, region: row.region,
      neighborhood: row.neighborhood, address: row.address, latitude: row.latitude, longitude: row.longitude,
      lunchIncluded: row.lunchIncluded, registrationOpenDate: row.registrationOpenDate,
      registrationOpenTime: row.registrationOpenTime, registrationStatus: row.registrationStatus,
      communitySlug: row.communitySlug, displayName: row.displayName, dataConfidence: row.dataConfidence,
      lastVerifiedAt: row.lastVerifiedAt ?? null, sourceUrl: row.sourceUrl ?? null,
      ageGroups: row.ageGroups, schedules: row.schedules, pricing: row.pricing,
    },
  }));
}

export async function getSavedCampIds(userId: string): Promise<string[]> {
  const result = await getPool().query<{ campId: string }>(
    `SELECT "campId" FROM "SavedCamp" WHERE "userId" = $1`,
    [userId]
  );
  return result.rows.map((r) => r.campId);
}

export async function upsertSaveUser(user: { id: string; email: string; name: string }): Promise<void> {
  await getPool().query(
    `INSERT INTO "User" (id, email, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET
       email = EXCLUDED.email,
       name = COALESCE(NULLIF(EXCLUDED.name, ''), "User".name)`,
    [user.id, user.email, user.name]
  );
}

export async function countSavedCamps(userId: string): Promise<string> {
  const result = await getPool().query<{ count: string }>(
    `SELECT COUNT(*) FROM "SavedCamp" WHERE "userId" = $1`,
    [userId]
  );
  return result.rows[0].count;
}

export async function saveCamp(userId: string, campId: string): Promise<void> {
  await getPool().query(
    `INSERT INTO "SavedCamp" (id, "userId", "campId")
     VALUES (gen_random_uuid()::text, $1, $2)
     ON CONFLICT ("userId", "campId") DO NOTHING`,
    [userId, campId]
  );
}

export async function deleteSavedCamp(userId: string, campId: string): Promise<void> {
  await getPool().query(
    `DELETE FROM "SavedCamp" WHERE "userId" = $1 AND "campId" = $2`,
    [userId, campId]
  );
}
