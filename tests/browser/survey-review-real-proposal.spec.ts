import { expect, test, type Page } from '@playwright/test';

// These specs drive a real pending proposal, so they need a live dev server + DB
// (.env.local) and run in campfit CI. The review surface is the single embedded
// Survey workbench (1.12.0 field-diff cards + per-card audit); the saved-decision
// trail remains as the audit ledger.

test('renders Survey workbench on a real pending proposal detail page', async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);

  await page.goto('/admin/review');
  await expect(page.getByRole('heading', { name: 'Review Queue' })).toBeVisible();

  const firstProposal = page.locator('a[href^="/admin/review/"]').first();
  if (await firstProposal.count() === 0) {
    test.skip(true, 'No pending proposals are available in this environment.');
  }

  await firstProposal.click();
  await expect(page).toHaveURL(/\/admin\/review\/[^?]+/);

  const surveyPanel = page.getByTestId('real-proposal-survey-workbench');
  await expect(surveyPanel).toBeVisible();
  await expect(surveyPanel).toContainText('Apply source');
  await expect(surveyPanel).toContainText('Apply actions below replay saved Survey decisions on the server');
  await expect(surveyPanel.getByTestId('survey-review-trail')).toBeVisible();
  await expect(surveyPanel.getByTestId('survey-review-trail')).toContainText('Saved Survey decisions');
  await expect(surveyPanel.getByTestId('survey-review-trail')).toContainText('Replay checked');
  // The single review surface: the embedded field-diff workbench.
  await expect(surveyPanel.locator('.survey-workbench-embed .workbench-shell')).toBeVisible();
  await expect(surveyPanel.getByTestId('review-fields')).toBeVisible();
  await expect(surveyPanel.getByTestId('review-field').first()).toBeVisible();

  await page.getByRole('button', { name: 'Hide Survey' }).click();
  await expect(surveyPanel.locator('.survey-workbench-embed .workbench-shell')).toBeHidden();
  await page.getByRole('button', { name: 'Show Survey' }).click();
  await expect(surveyPanel.locator('.survey-workbench-embed .workbench-shell')).toBeVisible();

  expect(consoleErrors).toEqual([]);
});

test('persists Survey review decisions on a real pending proposal detail page', async ({ page }) => {
  test.skip(test.info().project.name !== 'chromium-desktop', 'single-project persistence check avoids racing on live proposal events');
  const consoleErrors = collectConsoleErrors(page);

  await page.goto('/admin/review');
  await expect(page.getByRole('heading', { name: 'Review Queue' })).toBeVisible();

  const firstProposal = page.locator('a[href^="/admin/review/"]').first();
  if (await firstProposal.count() === 0) {
    test.skip(true, 'No pending proposals are available in this environment.');
  }

  await firstProposal.click();
  await expect(page).toHaveURL(/\/admin\/review\/[^?]+/);

  const surveyPanel = page.getByTestId('real-proposal-survey-workbench');
  await expect(surveyPanel.locator('.survey-workbench-embed .workbench-shell')).toBeVisible();

  // Accept the first field's proposed value via the workbench decision control.
  await Promise.all([
    waitForSurveyEventsPut(page),
    surveyPanel.getByTestId('use-proposed').first().click(),
  ]);
  await expect(surveyPanel.getByTestId('survey-review-trail-result').first()).toBeVisible();
  await expect(surveyPanel.getByTestId('survey-review-trail')).toContainText('Saved decision applies proposed value');

  await page.reload();
  const reloadedSurveyPanel = page.getByTestId('real-proposal-survey-workbench');
  await expect(reloadedSurveyPanel.getByTestId('survey-review-trail')).toContainText('Snapshot matched');
  await expect(reloadedSurveyPanel.getByTestId('survey-review-trail')).toContainText('Saved decision applies proposed value');

  expect(consoleErrors).toEqual([]);
});

async function waitForSurveyEventsPut(page: Page) {
  const response = await page.waitForResponse((candidate) =>
    candidate.url().includes('/survey-events') && candidate.request().method() === 'PUT',
  );
  const body = response.request().postDataJSON() as { reviewSessionId?: unknown } | null;
  expect(typeof body?.reviewSessionId).toBe('string');
  expect(response.ok(), await response.text()).toBe(true);
  return response;
}

function collectConsoleErrors(page: Page): string[] {
  const consoleErrors: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    consoleErrors.push(error.message);
  });

  return consoleErrors;
}
