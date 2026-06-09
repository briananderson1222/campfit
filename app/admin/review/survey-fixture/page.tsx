import { SurveyReviewWorkbench } from '@/components/admin/survey-review-workbench';
import { SurveyReviewTrail } from '@/components/admin/survey-review-trail';
import { buildCampSurveyReviewQueueSession } from '@/lib/admin/survey-review-items';
import { surveyReviewFixtureProposal } from '@/lib/admin/survey-review-fixture';

export const dynamic = 'force-dynamic';

export default function SurveyReviewFixturePage() {
  const session = buildCampSurveyReviewQueueSession(surveyReviewFixtureProposal, {
    actorId: 'campfit-fixture-reviewer',
    includeAppliedFields: true,
    reviewedAt: '2026-06-08T15:30:00.000Z',
  });

  return (
    <div className="space-y-4">
      <header className="rounded-xl border border-cream-300/70 bg-white/80 p-4 dark:border-pine-700/60 dark:bg-pine-950/40">
        <p className="text-[11px] font-semibold uppercase tracking-wide text-pine-700 dark:text-pine-200">
          Browser fixture
        </p>
        <h1 className="mt-1 text-xl font-semibold text-bark-700 dark:text-cream-100">
          Survey review workbench
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-bark-400 dark:text-cream-300">
          Protected admin fixture for verifying the CampFit integration with published Survey review primitives.
        </p>
      </header>

      <SurveyReviewTrail session={session} events={[]} />
      <SurveyReviewWorkbench session={session} />
    </div>
  );
}
