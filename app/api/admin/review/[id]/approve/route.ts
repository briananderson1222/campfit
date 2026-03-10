import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getProposal, updateProposalStatus, partialApprove } from '@/lib/admin/review-repository';
import { writeChangeLogs } from '@/lib/admin/changelog-repository';
import { recordReviewDecision } from '@/lib/admin/metrics-repository';
import { isFullyVerified } from '@/lib/admin/verification';
import { getPool } from '@/lib/db';

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { approvedFields = [], reviewerNotes, feedbackTags, overrides, keepPending = false }: {
    approvedFields: string[];
    reviewerNotes?: string;
    feedbackTags?: string[];
    overrides?: Record<string, import('@/lib/admin/types').FieldDiff>;
    keepPending?: boolean; // if true: apply selected fields but leave proposal in queue
  } = await request.json();

  const proposal = await getProposal(params.id);
  if (!proposal) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (proposal.status !== 'PENDING') return NextResponse.json({ error: 'Already reviewed' }, { status: 409 });

  // Merge reviewer overrides into proposal changes (reviewer may have edited values)
  const effectiveChanges = overrides
    ? { ...proposal.proposedChanges, ...overrides }
    : proposal.proposedChanges;

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const allFields = Object.keys(effectiveChanges);
    const rejectedFields = allFields.filter(f => !approvedFields.includes(f));

    const SCALAR = [
      'name', 'description', 'campType', 'category', 'registrationStatus',
      'registrationOpenDate', 'lunchIncluded', 'address', 'neighborhood', 'city',
      'websiteUrl', 'interestingDetails',
    ];
    const RELATIONS: Record<string, string> = {
      ageGroups: 'CampAgeGroup',
      schedules: 'CampSchedule',
      pricing: 'CampPricing',
    };

    type ChangeLogEntry = Parameters<typeof writeChangeLogs>[0][number];
    const changeLogs: ChangeLogEntry[] = [];

    for (const field of approvedFields) {
      const diff = effectiveChanges[field];
      if (!diff) continue;

      if (SCALAR.includes(field)) {
        const fieldSource = {
          excerpt: diff.excerpt ?? null,
          sourceUrl: diff.sourceUrl ?? proposal.sourceUrl,
          approvedAt: new Date().toISOString(),
        };
        await client.query(
          `UPDATE "Camp" SET "${field}" = $1, "fieldSources" = COALESCE("fieldSources", '{}') || $2::jsonb WHERE id = $3`,
          [diff.new, JSON.stringify({ [field]: fieldSource }), proposal.campId]
        );
        changeLogs.push({
          campId: proposal.campId,
          proposalId: proposal.id,
          changedBy: user.email!,
          fieldName: field,
          oldValue: diff.old,
          newValue: diff.new,
          changeType: (diff.old === null || diff.old === '') ? 'FIELD_POPULATED' : 'UPDATE',
        });
      } else if (field in RELATIONS && Array.isArray(diff.new)) {
        const table = RELATIONS[field];
        await client.query(`DELETE FROM "${table}" WHERE "campId" = $1`, [proposal.campId]);

        if (field === 'ageGroups') {
          for (const ag of diff.new as { label: string; minAge: number | null; maxAge: number | null; minGrade: number | null; maxGrade: number | null }[]) {
            await client.query(
              `INSERT INTO "CampAgeGroup" (id, "campId", label, "minAge", "maxAge", "minGrade", "maxGrade")
               VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6)`,
              [proposal.campId, ag.label, ag.minAge, ag.maxAge, ag.minGrade, ag.maxGrade]
            );
          }
        } else if (field === 'schedules') {
          for (const s of diff.new as { label: string; startDate: string | null; endDate: string | null; startTime: string | null; endTime: string | null; earlyDropOff: string | null; latePickup: string | null }[]) {
            await client.query(
              `INSERT INTO "CampSchedule" (id, "campId", label, "startDate", "endDate", "startTime", "endTime", "earlyDropOff", "latePickup")
               VALUES (gen_random_uuid()::text, $1, $2, $3::date, $4::date, $5, $6, $7, $8)`,
              [proposal.campId, s.label, s.startDate, s.endDate, s.startTime, s.endTime, s.earlyDropOff, s.latePickup]
            );
          }
        } else if (field === 'pricing') {
          for (const p of diff.new as { label: string; amount: number; unit: string; durationWeeks: number | null; ageQualifier: string | null; discountNotes: string | null }[]) {
            await client.query(
              `INSERT INTO "CampPricing" (id, "campId", label, amount, unit, "durationWeeks", "ageQualifier", "discountNotes")
               VALUES (gen_random_uuid()::text, $1, $2, $3, $4::"PricingUnit", $5, $6, $7)`,
              [proposal.campId, p.label, p.amount, p.unit, p.durationWeeks, p.ageQualifier, p.discountNotes]
            );
          }
        }

        changeLogs.push({
          campId: proposal.campId,
          proposalId: proposal.id,
          changedBy: user.email!,
          fieldName: field,
          oldValue: diff.old,
          newValue: diff.new,
          changeType: 'UPDATE',
        });
      }
    }

    // Update lastVerifiedAt whenever any fields are approved.
    // Auto-set VERIFIED when ALL required fields on the camp now have fieldSources coverage.
    // This is field-coverage-based, not proposal-based — partial approvals can still
    // eventually trigger VERIFIED once the last required field gets its citation.
    if (approvedFields.length > 0) {
      // Fetch the current camp state (including freshly-written fieldSources) to check coverage
      const { rows: [updatedCamp] } = await client.query(
        `SELECT description, "campType", category, "registrationStatus", city, "websiteUrl",
                "ageGroups", pricing, schedules, "fieldSources"
         FROM "Camp"
         LEFT JOIN LATERAL (
           SELECT COALESCE(json_agg(ag), '[]'::json) AS "ageGroups"
           FROM "CampAgeGroup" ag WHERE ag."campId" = "Camp".id
         ) ag ON true
         LEFT JOIN LATERAL (
           SELECT COALESCE(json_agg(s), '[]'::json) AS schedules
           FROM "CampSchedule" s WHERE s."campId" = "Camp".id
         ) s ON true
         LEFT JOIN LATERAL (
           SELECT COALESCE(json_agg(p), '[]'::json) AS pricing
           FROM "CampPricing" p WHERE p."campId" = "Camp".id
         ) p ON true
         WHERE "Camp".id = $1`,
        [proposal.campId]
      );

      const campNowVerified = !keepPending && updatedCamp &&
        isFullyVerified(updatedCamp, updatedCamp.fieldSources);

      await client.query(
        `UPDATE "Camp"
         SET "lastVerifiedAt" = now(),
             "sourceType"     = 'SCRAPER',
             "dataConfidence" = CASE WHEN $2 THEN 'VERIFIED'::"DataConfidence" ELSE "dataConfidence" END
         WHERE id = $1`,
        [proposal.campId, campNowVerified ?? false]
      );
    }

    await client.query('COMMIT');

    // Write logs and metrics outside transaction — failures here are non-fatal
    try {
      await writeChangeLogs(changeLogs);
    } catch (logErr) {
      console.error('writeChangeLogs failed (non-fatal):', logErr);
    }
    if (keepPending) {
      // Partial approval: apply fields, keep proposal in queue at lower priority
      try {
        await partialApprove(params.id, approvedFields, user.email, reviewerNotes);
      } catch (err) {
        console.error('partialApprove failed:', err);
        return NextResponse.json({ error: String(err) }, { status: 500 });
      }
    } else {
      try {
        await updateProposalStatus(params.id, 'APPROVED', user.email, reviewerNotes, feedbackTags);
      } catch (statusErr) {
        console.error('updateProposalStatus failed:', statusErr);
        return NextResponse.json({ error: String(statusErr) }, { status: 500 });
      }
    }
    try {
      await recordReviewDecision({
        proposalId: params.id,
        runId: proposal.crawlRunId,
        approvedFields,
        rejectedFields,
      });
    } catch (metricsErr) {
      console.error('recordReviewDecision failed (non-fatal):', metricsErr);
    }

    return NextResponse.json({ success: true, kept: keepPending, appliedFields: approvedFields.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Approve error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  } finally {
    client.release();
  }
}
