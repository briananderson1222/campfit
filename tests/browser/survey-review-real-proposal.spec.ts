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
  await expect(surveyPanel).toContainText('Read-only pilot');
  await expect(surveyPanel).toContainText('legacy Apply and Reject controls');
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
