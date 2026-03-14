import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { requireAdminAccess } from '@/lib/admin/access';
import { getCampCommunitySlug } from '@/lib/admin/community-access';
import { writeChangeLogs } from '@/lib/admin/changelog-repository';

interface AgeGroupInput {
  label: string;
  minAge: number | null;
  maxAge: number | null;
  minGrade: number | null;
  maxGrade: number | null;
}

/** Replace all age groups for a camp. */
export async function PUT(req: Request, { params }: { params: { campId: string } }) {
  const communitySlug = await getCampCommunitySlug(params.campId);
  const auth = await requireAdminAccess({ communitySlug, allowModerator: true });
  if ('error' in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { ageGroups } = await req.json() as { ageGroups: AgeGroupInput[] };
  if (!Array.isArray(ageGroups)) return NextResponse.json({ error: 'ageGroups array required' }, { status: 400 });

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const previous = await client.query(
      `SELECT label, "minAge", "maxAge", "minGrade", "maxGrade"
       FROM "CampAgeGroup" WHERE "campId" = $1 ORDER BY "minAge" ASC NULLS LAST`,
      [params.campId],
    );
    await client.query(`DELETE FROM "CampAgeGroup" WHERE "campId" = $1`, [params.campId]);
    for (const ag of ageGroups) {
      if (!ag.label?.trim()) continue;
      await client.query(
        `INSERT INTO "CampAgeGroup" (id, "campId", label, "minAge", "maxAge", "minGrade", "maxGrade")
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6)`,
        [params.campId, ag.label.trim(), ag.minAge ?? null, ag.maxAge ?? null, ag.minGrade ?? null, ag.maxGrade ?? null]
      );
    }
    await client.query(`UPDATE "Camp" SET "updatedAt" = now() WHERE id = $1`, [params.campId]);
    await client.query('COMMIT');

    await writeChangeLogs([{
      campId: params.campId,
      proposalId: null,
      changedBy: auth.access.email,
      fieldName: 'ageGroups',
      oldValue: previous.rows,
      newValue: ageGroups.filter((row) => row.label?.trim()),
      changeType: previous.rows.length === 0 ? 'FIELD_POPULATED' : 'UPDATE',
    }]).catch((error) => {
      console.error('[age-groups PUT] writeChangeLogs failed:', error);
    });

    const { rows } = await client.query(
      `SELECT * FROM "CampAgeGroup" WHERE "campId" = $1 ORDER BY "minAge" ASC NULLS LAST`,
      [params.campId]
    );
    return NextResponse.json(rows);
  } catch (err) {
    await client.query('ROLLBACK');
    return NextResponse.json({ error: String(err) }, { status: 500 });
  } finally {
    client.release();
  }
}
