import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getProposal, updateProposalStatus } from '@/lib/admin/review-repository';
import { writeChangeLogs } from '@/lib/admin/changelog-repository';
import { recordReviewDecision } from '@/lib/admin/metrics-repository';
import { getPool } from '@/lib/db';

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user?.email) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { approvedFields = [], reviewerNotes, feedbackTags }: {
    approvedFields: string[];
    reviewerNotes?: string;
    feedbackTags?: string[];
  } = await request.json();

  const proposal = await getProposal(params.id);
  if (!proposal) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  if (proposal.status !== 'PENDING') return NextResponse.json({ error: 'Already reviewed' }, { status: 409 });

  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const allFields = Object.keys(proposal.proposedChanges);
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
      const diff = proposal.proposedChanges[field];
      if (!diff) continue;

      if (SCALAR.includes(field)) {
        await client.query(
          `UPDATE "Camp" SET "${field}" = $1 WHERE id = $2`,
          [diff.new, proposal.campId]
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

    // Update camp verified timestamp
    if (approvedFields.length > 0) {
      await client.query(
        `UPDATE "Camp" SET "lastVerifiedAt" = now(), "dataConfidence" = 'VERIFIED', "sourceType" = 'SCRAPER' WHERE id = $1`,
        [proposal.campId]
      );
    }

    await client.query('COMMIT');

    // Write logs and metrics outside transaction — failures here are non-fatal
    try {
      await writeChangeLogs(changeLogs);
    } catch (logErr) {
      console.error('writeChangeLogs failed (non-fatal):', logErr);
    }
    try {
      await updateProposalStatus(params.id, 'APPROVED', user.email, reviewerNotes, feedbackTags);
    } catch (statusErr) {
      console.error('updateProposalStatus failed:', statusErr);
      return NextResponse.json({ error: String(statusErr) }, { status: 500 });
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

    return NextResponse.json({ success: true, appliedFields: approvedFields.length });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Approve error:', err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  } finally {
    client.release();
  }
}
