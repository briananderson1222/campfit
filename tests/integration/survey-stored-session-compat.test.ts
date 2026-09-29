/**
 * Stored review rounds written by the previous Survey (2.4.0) must load, stay
 * fresh, and apply identically under the current Survey. The fixture is the
 * verbatim `SurveyReviewSession` + `SurveyReviewEvent` rows campfit main wrote
 * through `getOrCreateSurveyReviewSessionForProposal` and
 * `replaceSurveyReviewEvents` with Survey 2.4.0.
 *
 * The failure this guards against is silent: a stored session the new Survey
 * no longer considers fresh (a changed snapshot hash, a binding it no longer
 * validates) is DELETED and recreated when the review page opens, and the
 * delete cascades to every recorded decision event.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { getPool as getProductionPool } from '@/lib/db';
import { applyProposalReview } from '@/lib/admin/review-apply';
import { getProposal } from '@/lib/admin/review-repository';
import { getSurveyReviewEvents } from '@/lib/admin/survey-review-events';
import { getOrCreateSurveyReviewSessionForProposal } from '@/lib/admin/survey-review-sessions';

import { assertTestDatabase, closeTestPool, getTestPool } from './test-db';

type Row = Record<string, unknown>;
const fixture = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), 'tests/fixtures/survey-2.4-stored-review-rows.json'), 'utf8'),
) as { camp: Row; proposal: Row; sessions: Row[]; events: Row[] };

const JSON_COLUMNS = new Set(['rawExtraction', 'proposedChanges', 'snapshot', 'binding', 'event']);

async function insertRow(pool: Pool, table: string, row: Row): Promise<void> {
  const columns = Object.keys(row);
  const values = columns.map((column) => (JSON_COLUMNS.has(column) && row[column] !== null ? JSON.stringify(row[column]) : row[column]));
  await pool.query(
    `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
    values,
  );
}

async function loadStoredRound(pool: Pool): Promise<void> {
  const camp = fixture.camp;
  await pool.query(
    `INSERT INTO "Camp" (id, slug, name, "campType", category, description, "contactPhone", "websiteUrl")
     VALUES ($1, $2, $3, 'SUMMER_DAY', 'SPORTS', $4, $5, $6)`,
    [camp.id, camp.slug, camp.name, camp.description, camp.contactPhone, camp.websiteUrl],
  );
  await insertRow(pool, 'CampChangeProposal', fixture.proposal);
  for (const session of fixture.sessions) await insertRow(pool, 'SurveyReviewSession', session);
  for (const event of fixture.events) await insertRow(pool, 'SurveyReviewEvent', event);
}

beforeAll(async () => {
  await assertTestDatabase();
});

afterEach(async () => {
  const pool = getTestPool();
  await pool.query(`TRUNCATE "Camp" RESTART IDENTITY CASCADE;`);
  await pool.query(`TRUNCATE "SurfaceClaimDefinition", "SurfaceVerificationPolicy", "SurfaceClaimGroup" RESTART IDENTITY CASCADE;`);
});

afterAll(async () => {
  await closeTestPool();
  await getProductionPool().end();
});

describe('review rounds stored by Survey 2.4', () => {
  it('reopen as the same session with every recorded decision, and apply as recorded', async () => {
    const pool = getTestPool();
    await loadStoredRound(pool);
    const storedSession = fixture.sessions[0]!;

    const proposal = (await getProposal(String(fixture.proposal.id)))!;
    const reopened = await getOrCreateSurveyReviewSessionForProposal(proposal, { actorId: 'reviewer@campfit.test' });
    // Same row: not judged stale, so not deleted and recreated.
    expect(reopened.id).toBe(storedSession.id);
    expect(reopened.snapshotHash).toBe(storedSession.snapshotHash);

    const events = await getSurveyReviewEvents({ proposalId: proposal.id, reviewSessionId: reopened.id });
    expect(events).toHaveLength(fixture.events.length);

    const result = await applyProposalReview({
      proposalId: proposal.id,
      reviewSessionId: reopened.id,
      reviewer: 'reviewer@campfit.test',
      keepPending: false,
    });
    expect(result.appliedFields).toEqual(['description']);
    expect(result.rejectedFields.slice().sort()).toEqual(['contactPhone', 'websiteUrl']);

    const camp = await pool.query(`SELECT description, "websiteUrl" FROM "Camp" WHERE id = $1`, [fixture.camp.id]);
    expect(camp.rows[0]).toEqual({ description: 'Outdoor day camp for ages 7-12.', websiteUrl: 'https://old.example.test' });
  });
});
