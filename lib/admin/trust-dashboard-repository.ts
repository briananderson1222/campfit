import { getPool } from '@/lib/db';

export type TrustDashboardRow = Record<string, unknown> & { id: string };

export async function getTrustDashboard(): Promise<{
  flags: TrustDashboardRow[];
  attestations: TrustDashboardRow[];
  aiActions: TrustDashboardRow[];
}> {
  const pool = getPool();
  const [flags, attestations, aiActions] = await Promise.all([
    pool.query<TrustDashboardRow>(`SELECT * FROM "ReviewFlag" ORDER BY CASE status WHEN 'OPEN' THEN 0 ELSE 1 END, "createdAt" DESC LIMIT 50`),
    pool.query<TrustDashboardRow>(`SELECT * FROM "FieldAttestation" ORDER BY "createdAt" DESC LIMIT 50`),
    pool.query<TrustDashboardRow>(`SELECT * FROM "AiActionLog" ORDER BY "createdAt" DESC LIMIT 50`),
  ]);
  return { flags: flags.rows, attestations: attestations.rows, aiActions: aiActions.rows };
}
