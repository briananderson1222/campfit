import { getPool } from '@/lib/db';
import type { CampChangeLog, ChangeType } from './types';

export async function writeChangeLogs(
  entries: {
    campId: string;
    proposalId: string;
    changedBy: string;
    fieldName: string;
    oldValue: unknown;
    newValue: unknown;
    changeType: ChangeType;
  }[]
): Promise<void> {
  if (entries.length === 0) return;
  const pool = getPool();
  for (const e of entries) {
    await pool.query(
      `INSERT INTO "CampChangeLog" ("campId", "proposalId", "changedBy", "fieldName", "oldValue", "newValue", "changeType")
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        e.campId, e.proposalId, e.changedBy, e.fieldName,
        e.oldValue !== null && e.oldValue !== undefined ? JSON.stringify(e.oldValue) : null,
        e.newValue !== null && e.newValue !== undefined ? JSON.stringify(e.newValue) : null,
        e.changeType,
      ]
    );
  }
}

export async function getChangeLogs(campId: string, limit = 50): Promise<CampChangeLog[]> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT * FROM "CampChangeLog" WHERE "campId" = $1 ORDER BY "changedAt" DESC LIMIT $2`,
    [campId, limit]
  );
  return result.rows;
}

export async function getMostChangedFields(days = 30, limit = 10): Promise<{ field: string; count: number }[]> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT "fieldName" AS field, COUNT(*)::int AS count
     FROM "CampChangeLog"
     WHERE "changedAt" > now() - ($1 || ' days')::interval
     GROUP BY "fieldName"
     ORDER BY count DESC
     LIMIT $2`,
    [days, limit]
  );
  return result.rows;
}
