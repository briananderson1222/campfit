import { getPool } from '@/lib/db';
import type { CampChangeLog, ChangeType } from './types';

type BaseChangeLogEntry = {
  changedBy: string;
  fieldName: string;
  oldValue: unknown;
  newValue: unknown;
  changeType: ChangeType;
};

function serialize(value: unknown) {
  return value !== null && value !== undefined ? JSON.stringify(value) : null;
}

export async function writeChangeLogs(
  entries: ({
    campId: string;
    proposalId: string | null;
  } & BaseChangeLogEntry)[],
): Promise<void> {
  if (entries.length === 0) return;
  const pool = getPool();
  for (const entry of entries) {
    await pool.query(
      `INSERT INTO "CampChangeLog" ("campId", "proposalId", "changedBy", "fieldName", "oldValue", "newValue", "changeType")
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.campId,
        entry.proposalId,
        entry.changedBy,
        entry.fieldName,
        serialize(entry.oldValue),
        serialize(entry.newValue),
        entry.changeType,
      ],
    );
  }
}

export async function writeProviderChangeLogs(
  entries: ({
    providerId: string;
  } & BaseChangeLogEntry)[],
): Promise<void> {
  if (entries.length === 0) return;
  const pool = getPool();
  for (const entry of entries) {
    await pool.query(
      `INSERT INTO "ProviderChangeLog" ("providerId", "changedBy", "fieldName", "oldValue", "newValue", "changeType")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        entry.providerId,
        entry.changedBy,
        entry.fieldName,
        serialize(entry.oldValue),
        serialize(entry.newValue),
        entry.changeType,
      ],
    );
  }
}

export async function writePersonChangeLogs(
  entries: ({
    personId: string;
  } & BaseChangeLogEntry)[],
): Promise<void> {
  if (entries.length === 0) return;
  const pool = getPool();
  for (const entry of entries) {
    await pool.query(
      `INSERT INTO "PersonChangeLog" ("personId", "changedBy", "fieldName", "oldValue", "newValue", "changeType")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        entry.personId,
        entry.changedBy,
        entry.fieldName,
        serialize(entry.oldValue),
        serialize(entry.newValue),
        entry.changeType,
      ],
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
