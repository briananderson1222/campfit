import { expect, test } from '@playwright/test';

/**
 * tests/browser/review-batch-accept.spec.ts — end-to-end two-lane
 * review-queue + batch-accept walkthrough (campfit#51, R1/R2/AC1/AC2, Wave 3
 * Task 3.2): open `/admin/review` → see two lanes (Batch-ready,
 * confidence-descending; Needs individual review, confidence-ascending) →
 * select 2 batch-ready field chips across 2 proposals → batch accept → see
 * applied outcomes → confirm a non-selected chip in the same proposal is
 * still pending (partial-accept semantics preserved).
 *
 * NOT_VERIFIED / accepted gap: this spec is written and checked in per the
 * plan's Task 3.2 acceptance ("written and checked in regardless, with its
 * evidence status honestly recorded"), but is currently blocked on the SAME
 * standing gap as campfit#90/#91/#93's own browser walkthroughs
 * (`tests/browser/aggregator-curation.spec.ts`) — no runnable local admin
 * session exists without the shared remote Supabase project (open
 * campfit#96). `playwright.config.ts` signs in against a real
 * Supabase-backed admin session (`tests/browser/auth.setup.ts`) that this
 * sandbox cannot exercise. Recorded here rather than silently omitted. Once
 * campfit#96 lands a local-auth seam, remove the `test.skip` below and this
 * spec runs for real against fixture-seeded Camps/Proposals (mirroring
 * `tests/integration/ranked-review-queue.test.ts`'s seeding discipline, not
 * a live third-party site).
 */
test.skip(
  true,
  'campfit#96 (open): no runnable local admin session without the shared remote Supabase project — same accepted gap as campfit#90/#91/#93\'s own browser walkthroughs. See this file\'s header doc.',
);

test('two-lane review queue → select batch-ready chips across 2 proposals → batch accept → outcomes render, non-selected chip stays pending', async ({ page }) => {
  await page.goto('/admin/review');
  await expect(page.getByRole('heading', { name: 'Review Queue' })).toBeVisible();

  await expect(page.getByText(/Batch-ready/)).toBeVisible();
  await expect(page.getByText(/Needs individual review/)).toBeVisible();

  const checkboxes = page.locator('input[type="checkbox"]');
  await checkboxes.nth(0).check();
  await checkboxes.nth(1).check();

  await page.getByRole('button', { name: /Batch accept \(2 selected\)/ }).click();

  await expect(page.getByText('Applied.').first()).toBeVisible({ timeout: 15_000 });

  // A field that was NOT selected in the same proposal (if any) remains an
  // unchecked, still-selectable chip — the partial-accept invariant.
  const remainingSelectable = page.locator('input[type="checkbox"]:not(:checked)');
  await expect(remainingSelectable.first()).toBeVisible();
});
