import { getPool } from '@/lib/db';
import { RepositoryConnectionError } from './repository-errors';

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
export type UpdateAdminPersonInput = {
  fullName?: string;
  bio?: string | null;
  contacts?: Array<{ id?: string; type?: string; value?: string; label?: string | null }>;
};

export async function updateAdminPerson(personId: string, body: UpdateAdminPersonInput) {
  const client = await getPool().connect().catch((error) => {
    throw new RepositoryConnectionError(error);
  });
  try {
    await client.query('BEGIN');
    const [personBefore, contactsBefore] = await Promise.all([
      client.query<AdminPerson>(`SELECT * FROM "Person" WHERE id = $1`, [personId]),
      client.query(`SELECT type, value, label FROM "PersonContactMethod" WHERE "personId" = $1 ORDER BY "createdAt" ASC`, [personId]),
    ]);
    const updates: string[] = [];
    const values: unknown[] = [personId];
    if (body.fullName !== undefined) {
      values.push(body.fullName.trim());
      updates.push(`"fullName" = $${values.length}`);
    }
    if (body.bio !== undefined) {
      values.push(body.bio?.trim() || null);
      updates.push(`bio = $${values.length}`);
    }
    if (updates.length > 0) {
      await client.query(`UPDATE "Person" SET ${updates.join(', ')}, "updatedAt" = now() WHERE id = $1`, values);
    }
    if (Array.isArray(body.contacts)) {
      await client.query(`DELETE FROM "PersonContactMethod" WHERE "personId" = $1`, [personId]);
      for (const contact of body.contacts) {
        if (!contact?.type?.trim() || !contact?.value?.trim()) continue;
        await client.query(
          `INSERT INTO "PersonContactMethod" ("personId", type, value, label) VALUES ($1, $2, $3, $4)`,
          [personId, contact.type.trim(), contact.value.trim(), contact.label?.trim() || null]);
      }
    }
    await client.query('COMMIT');
    return { existingPerson: personBefore.rows[0], contactsBefore: contactsBefore.rows };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

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
