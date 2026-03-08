/**
 * Nightly notification cron — triggered by Vercel Cron.
 * Configured in vercel.json to run daily at 8am MT.
 *
 * Checks for camps with registration opening in the next 7 days
 * and sends email alerts to users who have saved them.
 */

import { NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { sendRegistrationAlert } from "@/lib/notifications/email";

export async function GET(request: Request) {
  // Verify the request comes from Vercel Cron
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const pool = getPool();

  // Find camps with registration opening in the next 7 days
  const campsResult = await pool.query(
    `SELECT id, slug, name, "websiteUrl", "registrationOpenDate"
     FROM "Camp"
     WHERE "registrationOpenDate" BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
     AND "registrationStatus" IN ('COMING_SOON', 'UNKNOWN')`
  );

  if (campsResult.rows.length === 0) {
    return NextResponse.json({ sent: 0, message: "No upcoming registrations" });
  }

  let sent = 0;
  const errors: string[] = [];

  for (const camp of campsResult.rows) {
    // Find users who have saved this camp and have email notifications on
    const usersResult = await pool.query(
      `SELECT u.email
       FROM "SavedCamp" sc
       JOIN "User" u ON u.id = sc."userId"
       WHERE sc."campId" = $1
       AND sc."notifyEmail" = true
       AND u.email != ''`,
      [camp.id]
    );

    for (const user of usersResult.rows) {
      try {
        await sendRegistrationAlert({
          to: user.email,
          campName: camp.name,
          campSlug: camp.slug,
          registrationDate: camp.registrationOpenDate,
          websiteUrl: camp.websiteUrl ?? "",
        });
        sent++;
      } catch (e) {
        errors.push(`${camp.name} → ${user.email}: ${e}`);
      }
    }
  }

  return NextResponse.json({
    sent,
    camps: campsResult.rows.length,
    errors: errors.length > 0 ? errors : undefined,
  });
}
