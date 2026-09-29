/**
 * A camp proposal with no reported confidence stores 0 as its ordering key.
 * Provider averages must leave those out (and say how many they averaged),
 * and provider pages must show "Not reported" rather than 0%.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { getPool as getProductionPool } from '@/lib/db';
import { getProvider, getProviders } from '@/lib/admin/provider-repository';
import { formatReportedConfidence, reportedOverallConfidence } from '@/lib/admin/proposal-extraction-status';

import { assertTestDatabase, closeTestPool, getTestPool } from './test-db';

beforeAll(async () => { await assertTestDatabase(); });
afterEach(async () => {
  const pool = getTestPool();
  await pool.query(`TRUNCATE "Camp" RESTART IDENTITY CASCADE;`);
  await pool.query(`TRUNCATE "Provider" RESTART IDENTITY CASCADE;`);
});
afterAll(async () => { await closeTestPool(); await getProductionPool().end(); });

async function seedProvider(proposals: { overall: number; confidence?: number }[]): Promise<string> {
  const pool = getTestPool();
  const providerId = randomUUID();
  await pool.query(`INSERT INTO "Provider" (id, name, slug, domain, "communitySlug") VALUES ($1, $2, $3, $4, 'denver')`,
    [providerId, `Provider ${providerId.slice(0, 6)}`, `provider-${providerId}`, `${providerId}.example.test`]);
  for (const [i, proposal] of proposals.entries()) {
    const campId = randomUUID();
    await pool.query(`INSERT INTO "Camp" (id, slug, name, "campType", category, description, "websiteUrl", "providerId", "communitySlug")
      VALUES ($1, $2, 'Camp', 'SUMMER_DAY', 'SPORTS', '', 'https://example.test', $3, 'denver')`, [campId, `camp-${campId}`, providerId]);
    const diff = { old: 'a', new: `b${i}`, mode: 'update', ...(proposal.confidence === undefined ? {} : { confidence: proposal.confidence }) };
    await pool.query(`INSERT INTO "CampChangeProposal" ("campId", "sourceUrl", "proposedChanges", "overallConfidence", "extractionModel")
      VALUES ($1, 'https://example.test', $2::jsonb, $3, 'test')`, [campId, JSON.stringify({ city: diff }), proposal.overall]);
  }
  return providerId;
}

describe('provider confidence', () => {
  it('averages only proposals that reported a confidence, and counts them', async () => {
    const mixed = await seedProvider([{ overall: 0.8, confidence: 0.8 }, { overall: 0 }, { overall: 0.6, confidence: 0.6 }]);
    const unreported = await seedProvider([{ overall: 0 }, { overall: 0 }]);

    expect(await getProvider(mixed)).toMatchObject({ avgConfidence: 0.7, avgConfidenceCount: 2 });
    expect(await getProvider(unreported)).toMatchObject({ avgConfidence: null, avgConfidenceCount: 0 });
    const listed = new Map((await getProviders('denver')).map((provider) => [provider.id, provider]));
    expect(listed.get(mixed)).toMatchObject({ avgConfidence: 0.7, avgConfidenceCount: 2 });
    expect(listed.get(unreported)).toMatchObject({ avgConfidence: null, avgConfidenceCount: 0 });
  });

  it('shows an unreported provider proposal confidence as Not reported', () => {
    const providerProposal = { overallConfidence: 0, proposedChanges: { name: { old: 'A', new: 'B' } } as Record<string, unknown> };
    expect(formatReportedConfidence(reportedOverallConfidence(providerProposal))).toBe('Not reported');
    expect(formatReportedConfidence(reportedOverallConfidence({ overallConfidence: 0.42, proposedChanges: { name: { confidence: 0.42 } } }))).toBe('42%');
  });
});
