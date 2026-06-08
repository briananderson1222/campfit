import { expect, test, type Page } from '@playwright/test';

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
  await expect(surveyPanel.locator('.survey-workbench-embed .workbench-shell')).toBeVisible();
  await expect(surveyPanel.getByTestId('review-queue')).toBeVisible();
  await expect(surveyPanel.getByTestId('review-focus')).toBeVisible();
  await expect(surveyPanel.getByTestId('surface-preview')).toContainText('Surface preview');

  await page.getByRole('button', { name: 'Hide Survey' }).click();
  await expect(surveyPanel.locator('.survey-workbench-embed .workbench-shell')).toBeHidden();
  await page.getByRole('button', { name: 'Show Survey' }).click();
  await expect(surveyPanel.locator('.survey-workbench-embed .workbench-shell')).toBeVisible();

  expect(consoleErrors).toEqual([]);
});

test('persists Survey review decisions on a real pending proposal detail page', async ({ page }) => {
  test.skip(test.info().project.name !== 'chromium-desktop', 'single-project persistence check avoids racing on live proposal events');
  const consoleErrors = collectConsoleErrors(page);
  const note = `Persistent Survey review note ${Date.now()}`;

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

  await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes('/survey-events') &&
      response.request().method() === 'PUT' &&
      response.ok(),
    ),
    surveyPanel.locator(".decision-column [data-decision='accept-proposed']").click(),
  ]);

  await Promise.all([
    page.waitForResponse((response) =>
      response.url().includes('/survey-events') &&
      response.request().method() === 'PUT' &&
      response.ok(),
    ),
    surveyPanel.getByTestId('reviewer-note').fill(note),
  ]);

  await expect(surveyPanel.getByTestId('reviewer-note')).toHaveValue(note);
  await page.reload();
  await expect(page.getByTestId('real-proposal-survey-workbench').getByTestId('reviewer-note')).toHaveValue(note);
  await expect(page.getByTestId('real-proposal-survey-workbench').locator(".decision-column [data-decision='accept-proposed']")).toHaveClass(/is-active/);

  expect(consoleErrors).toEqual([]);
});

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
