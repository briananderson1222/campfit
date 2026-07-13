/**
 * Nightly notification cron — triggered by Vercel Cron.
 * Configured in vercel.json to run daily at 8am MT.
 *
 * Checks for camps with registration opening in the next 7 days
 * and sends email alerts to users who have saved them.
 */

import { NextResponse } from "next/server";
import { sendRegistrationAlert } from "@/lib/notifications/email";
import {
  getRegistrationAlertRecipients,
  getUpcomingRegistrationCamps,
} from "@/lib/notification-repository";

export async function GET(request: Request) {
  // Verify the request comes from Vercel Cron
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Find camps with registration opening in the next 7 days
  const camps = await getUpcomingRegistrationCamps();

  if (camps.length === 0) {
    return NextResponse.json({ sent: 0, message: "No upcoming registrations" });
  }

  let sent = 0;
  const errors: string[] = [];

  for (const camp of camps) {
    // Find users who have saved this camp and have email notifications on
    const users = await getRegistrationAlertRecipients(camp.id);

    for (const user of users) {
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
    camps: camps.length,
    errors: errors.length > 0 ? errors : undefined,
  });
}
