import { expect, test } from '@playwright/test';

/**
 * tests/browser/aggregator-curation.spec.ts — end-to-end curation
 * walkthrough (campfit#93 R3/AC3, R4/AC4, Wave 4 Task 4.2):
 * register → ToS-approve → run discovery against a fixture-seeded
 * aggregator → select candidates → onboard → follow the `?created=1` link
 * → confirm the existing unmodified `FirstCrawlOffer` card renders.
 *
 * NOT_VERIFIED / accepted gap: this spec is written and checked in per the
 * plan's Task 4.2 acceptance ("the browser spec itself is written and
 * checked in regardless, with its evidence status honestly recorded"), but
 * is currently blocked on the SAME standing gap as campfit#90/#91's own
 * browser walkthroughs — no runnable local admin session exists without
 * the shared remote Supabase project (open campfit#96). `playwright.config.ts`
 * signs in against a real Supabase-backed admin session
 * (`tests/browser/auth.setup.ts`) that this sandbox cannot exercise.
 * Recorded here rather than silently omitted, exactly as
 * `schedule-panel-view.ts`'s header doc and `crawl-runner-button.tsx`
 * record the identical gap for their own interactivity. Once campfit#96
 * lands a local-auth seam, remove the `test.skip` below and this spec runs
 * for real against a fixture-seeded aggregator + fixture `ExtractionProvider`
 * (mirroring `tests/integration/aggregator-extraction.test.ts`'s fixture
 * discipline, not a live third-party site).
 */
test.skip(
  true,
  'campfit#96 (open): no runnable local admin session without the shared remote Supabase project — same accepted gap as campfit#90/#91\'s own browser walkthroughs. See this file\'s header doc.',
);

test('register → ToS-approve → discover → curate → onboard → lands on FirstCrawlOffer', async ({ page }) => {
  const aggregatorName = `Playwright Fixture Aggregator ${Date.now()}`;

  await page.goto('/admin/aggregators');
  await expect(page.getByRole('heading', { name: 'Aggregators' })).toBeVisible();

  await page.getByRole('button', { name: '+ Register aggregator' }).click();
  await page.getByPlaceholder('Aggregator site name').fill(aggregatorName);
  await page.getByPlaceholder('https://...').fill('https://fixture-aggregator.test/');
  await page.getByRole('button', { name: 'Register aggregator' }).last().click();

  await expect(page.getByText('ToS review required before discovery can run')).toBeVisible();
  await page.getByLabel(/Approve/).check();
  await page.getByRole('button', { name: 'Record decision' }).click();
  await expect(page.getByText('ToS Approved')).toBeVisible();

  await page.getByRole('button', { name: 'Run discovery' }).click();
  await expect(page.getByText(/Discovered \d+ candidate/)).toBeVisible({ timeout: 30_000 });

  const firstCandidateCheckbox = page.locator('input[type="checkbox"]').first();
  await firstCandidateCheckbox.check();
  await page.getByRole('button', { name: /Onboard selected/ }).click();

  const createdLink = page.getByRole('link', { name: 'View & run first crawl →' });
  await expect(createdLink).toBeVisible({ timeout: 15_000 });
  await createdLink.click();

  await expect(page.getByText('Run a first crawl?')).toBeVisible();
});
