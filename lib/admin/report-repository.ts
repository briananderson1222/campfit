import { getPool } from '@/lib/db';

export async function updateCampReportReview(
  reportId: string,
  status: 'REVIEWED' | 'DISMISSED',
  adminNotes: string | null,
): Promise<number | null> {
  const { rowCount } = await getPool().query(
    `UPDATE "CampReport" SET status = $1, "adminNotes" = $2, "updatedAt" = now() WHERE id = $3`,
    [status, adminNotes, reportId]
  );
  return rowCount;
}
