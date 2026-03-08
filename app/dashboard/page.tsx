import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getPool } from "@/lib/db";
import { DashboardClient } from "@/components/dashboard-client";
import { SavedCamp } from "@/lib/types";

export default async function DashboardPage() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect("/auth/login");
  }

  // Fetch saved camps with full camp data
  const pool = getPool();
  const result = await pool.query(
    `SELECT
      sc.id,
      sc."campId",
      sc."savedAt"::text,
      sc."notifyEmail",
      sc."notifyPush",
      sc."notifySms",
      sc.notes,
      c.*,
      c."registrationOpenDate"::text AS "registrationOpenDate",
      COALESCE(
        json_agg(DISTINCT jsonb_build_object(
          'id', ag."id", 'label', ag."label",
          'minAge', ag."minAge", 'maxAge', ag."maxAge",
          'minGrade', ag."minGrade", 'maxGrade', ag."maxGrade"
        )) FILTER (WHERE ag."id" IS NOT NULL), '[]'
      ) AS "ageGroups",
      COALESCE(
        json_agg(DISTINCT jsonb_build_object(
          'id', s."id", 'label', s."label",
          'startDate', s."startDate"::text, 'endDate', s."endDate"::text,
          'startTime', s."startTime", 'endTime', s."endTime",
          'earlyDropOff', s."earlyDropOff", 'latePickup', s."latePickup"
        )) FILTER (WHERE s."id" IS NOT NULL), '[]'
      ) AS "schedules",
      COALESCE(
        json_agg(DISTINCT jsonb_build_object(
          'id', p."id", 'label', p."label",
          'amount', p."amount"::float, 'unit', p."unit",
          'durationWeeks', p."durationWeeks", 'ageQualifier', p."ageQualifier",
          'discountNotes', p."discountNotes"
        )) FILTER (WHERE p."id" IS NOT NULL), '[]'
      ) AS "pricing"
    FROM "SavedCamp" sc
    JOIN "Camp" c ON c.id = sc."campId"
    LEFT JOIN "CampAgeGroup" ag ON ag."campId" = c.id
    LEFT JOIN "CampSchedule" s ON s."campId" = c.id
    LEFT JOIN "CampPricing" p ON p."campId" = c.id
    WHERE sc."userId" = $1
    GROUP BY sc.id, c.id
    ORDER BY sc."savedAt" DESC`,
    [user.id]
  );

  const savedCamps: SavedCamp[] = result.rows.map((row) => ({
    id: row.id,
    campId: row.campId,
    savedAt: row.savedAt,
    notifyEmail: row.notifyEmail,
    notifyPush: row.notifyPush,
    notifySms: row.notifySms,
    notes: row.notes,
    camp: {
      id: row.campId,
      slug: row.slug,
      name: row.name,
      description: row.description,
      notes: row.notes,
      campType: row.campType,
      category: row.category,
      websiteUrl: row.websiteUrl,
      interestingDetails: row.interestingDetails,
      city: row.city,
      region: row.region,
      neighborhood: row.neighborhood,
      address: row.address,
      latitude: row.latitude,
      longitude: row.longitude,
      lunchIncluded: row.lunchIncluded,
      registrationOpenDate: row.registrationOpenDate,
      registrationOpenTime: row.registrationOpenTime,
      registrationStatus: row.registrationStatus,
      dataConfidence: row.dataConfidence,
      ageGroups: row.ageGroups,
      schedules: row.schedules,
      pricing: row.pricing,
    },
  }));

  return <DashboardClient initialSaves={savedCamps} userEmail={user.email ?? ""} />;
}
