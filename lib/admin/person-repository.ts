import { getPool } from '@/lib/db';

export type AdminPerson = Record<string, unknown> & { id: string; fullName: string };
export type AdminPersonContact = Record<string, unknown> & {
  id: string; personId: string; type: string; value: string; label?: string | null;
};
export type AdminCampPersonRole = Record<string, unknown> & {
  id: string; campId: string; roleType: string; campName: string; campSlug: string; communitySlug: string;
};
export type AdminProviderPersonRole = Record<string, unknown> & {
  id: string; providerId: string; roleType: string; providerName: string; providerSlug: string; communitySlug: string;
};
export type AdminPersonDetail = {
  person: AdminPerson;
  contacts: AdminPersonContact[];
  campRoles: AdminCampPersonRole[];
  providerRoles: AdminProviderPersonRole[];
};
export type AdminPersonRow = {
  id: string; fullName: string; slug: string; campRoles: number; providerRoles: number; contactCount: number;
};

export async function getAdminPersonDetail(personId: string): Promise<AdminPersonDetail | null> {
  const pool = getPool();
  const [personRes, contactsRes, campRolesRes, providerRolesRes] = await Promise.all([
    pool.query<AdminPerson>(`SELECT * FROM "Person" WHERE id = $1`, [personId]),
    pool.query<AdminPersonContact>(`SELECT * FROM "PersonContactMethod" WHERE "personId" = $1 ORDER BY "createdAt" ASC`, [personId]),
    pool.query<AdminCampPersonRole>(
      `SELECT r.*, c.name AS "campName", c.slug AS "campSlug", c."communitySlug"
       FROM "CampPersonRole" r JOIN "Camp" c ON c.id = r."campId"
       WHERE r."personId" = $1 ORDER BY c.name ASC`, [personId]),
    pool.query<AdminProviderPersonRole>(
      `SELECT r.*, p.name AS "providerName", p.slug AS "providerSlug", p."communitySlug"
       FROM "ProviderPersonRole" r JOIN "Provider" p ON p.id = r."providerId"
       WHERE r."personId" = $1 ORDER BY p.name ASC`, [personId]),
  ]);
  const person = personRes.rows[0];
  if (!person) return null;
  return { person, contacts: contactsRes.rows, campRoles: campRolesRes.rows, providerRoles: providerRolesRes.rows };
}

export async function getAdminPeople(): Promise<AdminPersonRow[]> {
  const { rows } = await getPool().query<AdminPersonRow>(`
    SELECT p.id, p."fullName", p.slug,
      COUNT(DISTINCT cpr.id)::int AS "campRoles",
      COUNT(DISTINCT ppr.id)::int AS "providerRoles",
      COUNT(DISTINCT pcm.id)::int AS "contactCount"
    FROM "Person" p
    LEFT JOIN "CampPersonRole" cpr ON cpr."personId" = p.id
    LEFT JOIN "ProviderPersonRole" ppr ON ppr."personId" = p.id
    LEFT JOIN "PersonContactMethod" pcm ON pcm."personId" = p.id
    GROUP BY p.id ORDER BY p."fullName" ASC
  `);
  return rows;
}
