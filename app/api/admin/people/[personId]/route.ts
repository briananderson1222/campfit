import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { requireAdminAccess } from '@/lib/admin/access';

export async function GET(
  _request: Request,
  { params }: { params: { personId: string } },
) {
  const auth = await requireAdminAccess();
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const pool = getPool();
  const [personRes, contactsRes, campRolesRes, providerRolesRes] = await Promise.all([
    pool.query(
      `SELECT * FROM "Person" WHERE id = $1`,
      [params.personId],
    ),
    pool.query(
      `SELECT * FROM "PersonContactMethod" WHERE "personId" = $1 ORDER BY "createdAt" ASC`,
      [params.personId],
    ),
    pool.query(
      `SELECT r.*, c.name AS "campName", c.slug AS "campSlug", c."communitySlug"
       FROM "CampPersonRole" r
       JOIN "Camp" c ON c.id = r."campId"
       WHERE r."personId" = $1
       ORDER BY c.name ASC`,
      [params.personId],
    ),
    pool.query(
      `SELECT r.*, p.name AS "providerName", p.slug AS "providerSlug", p."communitySlug"
       FROM "ProviderPersonRole" r
       JOIN "Provider" p ON p.id = r."providerId"
       WHERE r."personId" = $1
       ORDER BY p.name ASC`,
      [params.personId],
    ),
  ]);

  const person = personRes.rows[0];
  if (!person) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  return NextResponse.json({
    person,
    contacts: contactsRes.rows,
    campRoles: campRolesRes.rows,
    providerRoles: providerRolesRes.rows,
  });
}

export async function PATCH(
  request: Request,
  { params }: { params: { personId: string } },
) {
  const auth = await requireAdminAccess();
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const body = await request.json().catch(() => ({})) as {
    fullName?: string;
    bio?: string | null;
    contacts?: Array<{ id?: string; type?: string; value?: string; label?: string | null }>;
  };

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const updates: string[] = [];
    const values: unknown[] = [params.personId];
    if (body.fullName !== undefined) {
      values.push(body.fullName.trim());
      updates.push(`"fullName" = $${values.length}`);
    }
    if (body.bio !== undefined) {
      values.push(body.bio?.trim() || null);
      updates.push(`bio = $${values.length}`);
    }
    if (updates.length > 0) {
      await client.query(
        `UPDATE "Person" SET ${updates.join(', ')}, "updatedAt" = now() WHERE id = $1`,
        values,
      );
    }

    if (Array.isArray(body.contacts)) {
      await client.query(`DELETE FROM "PersonContactMethod" WHERE "personId" = $1`, [params.personId]);
      for (const contact of body.contacts) {
        if (!contact?.type?.trim() || !contact?.value?.trim()) continue;
        await client.query(
          `INSERT INTO "PersonContactMethod" ("personId", type, value, label)
           VALUES ($1, $2, $3, $4)`,
          [params.personId, contact.type.trim(), contact.value.trim(), contact.label?.trim() || null],
        );
      }
    }

    await client.query('COMMIT');
    return GET(request, { params });
  } catch (error) {
    await client.query('ROLLBACK');
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Request failed' }, { status: 500 });
  } finally {
    client.release();
  }
}
