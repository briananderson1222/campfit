import { getPool } from '@/lib/db';

export type UpcomingRegistrationCamp = {
  id: string;
  slug: string;
  name: string;
  websiteUrl: string | null;
  registrationOpenDate: string;
};

export type RegistrationAlertRecipient = {
  email: string;
};

export async function getUpcomingRegistrationCamps(): Promise<UpcomingRegistrationCamp[]> {
  const { rows } = await getPool().query<UpcomingRegistrationCamp>(
    `SELECT id, slug, name, "websiteUrl", "registrationOpenDate"
     FROM "Camp"
     WHERE "registrationOpenDate" BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'
     AND "registrationStatus" IN ('COMING_SOON', 'UNKNOWN')`
  );
  return rows;
}

export async function getRegistrationAlertRecipients(
  campId: string,
): Promise<RegistrationAlertRecipient[]> {
  const { rows } = await getPool().query<RegistrationAlertRecipient>(
    `SELECT u.email
     FROM "SavedCamp" sc
     JOIN "User" u ON u.id = sc."userId"
     WHERE sc."campId" = $1
     AND sc."notifyEmail" = true
     AND u.email != ''`,
    [campId]
  );
  return rows;
}
