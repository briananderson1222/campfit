import { getPool } from '@/lib/db';

export interface FieldTimeline {
  lastUpdatedAt: string | null;
  lastAttestedAt: string | null;
}

export type FieldTimelineMap = Record<string, FieldTimeline>;

type EntityType = 'CAMP' | 'PROVIDER' | 'PERSON';

export async function getCampFieldTimeline(campId: string): Promise<FieldTimelineMap> {
  const pool = getPool();
  const [changeLogRes, campRes] = await Promise.all([
    pool.query<{ field: string; lastUpdatedAt: string }>(
      `SELECT "fieldName" AS field, MAX("changedAt")::text AS "lastUpdatedAt"
       FROM "CampChangeLog"
       WHERE "campId" = $1
       GROUP BY "fieldName"`,
      [campId],
    ),
    pool.query<{ fieldSources: Record<string, { approvedAt?: string | null }> | null }>(
      `SELECT COALESCE("fieldSources", '{}'::jsonb) AS "fieldSources"
       FROM "Camp"
       WHERE id = $1`,
      [campId],
    ),
  ]);

  const timeline = fromChangeLogRows(changeLogRes.rows);
  const fieldSources = campRes.rows[0]?.fieldSources ?? {};
  for (const [field, source] of Object.entries(fieldSources)) {
    timeline[field] = {
      lastUpdatedAt: timeline[field]?.lastUpdatedAt ?? null,
      lastAttestedAt: source?.approvedAt ?? null,
    };
  }
  return timeline;
}

export async function getProviderFieldTimeline(providerId: string): Promise<FieldTimelineMap> {
  return getEntityFieldTimeline({
    entityType: 'PROVIDER',
    entityId: providerId,
    changeLogTable: '"ProviderChangeLog"',
    changeEntityColumn: '"providerId"',
  });
}

export async function getPersonFieldTimeline(personId: string): Promise<FieldTimelineMap> {
  return getEntityFieldTimeline({
    entityType: 'PERSON',
    entityId: personId,
    changeLogTable: '"PersonChangeLog"',
    changeEntityColumn: '"personId"',
  });
}

async function getEntityFieldTimeline(opts: {
  entityType: EntityType;
  entityId: string;
  changeLogTable: string;
  changeEntityColumn: string;
}): Promise<FieldTimelineMap> {
  const pool = getPool();
  const [changeLogRes, attestationRes] = await Promise.all([
    pool.query<{ field: string; lastUpdatedAt: string }>(
      `SELECT "fieldName" AS field, MAX("changedAt")::text AS "lastUpdatedAt"
       FROM ${opts.changeLogTable}
       WHERE ${opts.changeEntityColumn} = $1
       GROUP BY "fieldName"`,
      [opts.entityId],
    ),
    pool.query<{ field: string; lastAttestedAt: string }>(
      `SELECT "fieldKey" AS field, MAX("approvedAt")::text AS "lastAttestedAt"
       FROM "FieldAttestation"
       WHERE "entityType" = $1 AND "entityId" = $2 AND "approvedAt" IS NOT NULL
       GROUP BY "fieldKey"`,
      [opts.entityType, opts.entityId],
    ),
  ]);

  const timeline = fromChangeLogRows(changeLogRes.rows);
  for (const row of attestationRes.rows) {
    timeline[row.field] = {
      lastUpdatedAt: timeline[row.field]?.lastUpdatedAt ?? null,
      lastAttestedAt: row.lastAttestedAt ?? null,
    };
  }
  return timeline;
}

function fromChangeLogRows(rows: Array<{ field: string; lastUpdatedAt: string }>): FieldTimelineMap {
  const timeline: FieldTimelineMap = {};
  for (const row of rows) {
    timeline[row.field] = {
      lastUpdatedAt: row.lastUpdatedAt ?? null,
      lastAttestedAt: null,
    };
  }
  return timeline;
}
