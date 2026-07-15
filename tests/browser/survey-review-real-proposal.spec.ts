import { expect, test, type Locator, type Page } from '@playwright/test';

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

  // A live proposal may already carry persisted decisions, so target a field that
  // is still in the undecided "review" state — deciding an already-decided field
  // is idempotent and would persist no new event.
  const undecided = surveyPanel.locator('[data-testid="review-field"][data-state="review"]').first();
  if (await undecided.count() === 0) {
    test.skip(true, 'Every field on this live proposal is already decided.');
  }

  // Accept it; the persistent event store PUTs the decision to /survey-events.
  //
  // TYPED-VALUE GATING (survey 1.13.0): fields that carry a typed valueDescriptor
  // (number/date/boolean/enum) BLOCK `use-proposed` when the crawl value doesn't
  // conform — e.g. a mixed-case 'Waitlist' against an uppercase enum, or a
  // non-YYYY-MM-DD date. On a live proposal the chosen undecided field's value
  // may be non-conforming, so a naive click can be blocked (the field stays
  // `data-state="review"` and `value-error` un-hides) and no event is persisted.
  // Faithfully model the new reviewer behavior: try to accept, and if the field
  // is gated, correct the typed editor to a guaranteed-valid value and retry.
  const surveyEventsPut = waitForSurveyEventsPut(page);
  await acceptProposedCorrectingIfGated(undecided);
  await expect(undecided.getByTestId('decided-chip')).toBeVisible();
  await surveyEventsPut;

  await expect(surveyPanel.getByTestId('survey-review-trail-result').first()).toBeVisible();
  await expect(surveyPanel.getByTestId('survey-review-trail')).toContainText('Saved decision applies proposed value');

  await page.reload();
  const reloadedSurveyPanel = page.getByTestId('real-proposal-survey-workbench');
  await expect(reloadedSurveyPanel.getByTestId('survey-review-trail')).toContainText('Snapshot matched');
  await expect(reloadedSurveyPanel.getByTestId('survey-review-trail')).toContainText('Saved decision applies proposed value');

  expect(consoleErrors).toEqual([]);
});

/**
 * Click `use-proposed` on a field; if typed-value gating blocks the decision
 * (survey 1.13.0), correct the typed editor to a guaranteed-valid value and
 * retry. The decision stays `accept-proposed` either way — the reviewer is
 * still accepting the proposed candidate, just with a corrected (conforming)
 * value — so the trail still renders "Saved decision applies proposed value".
 */
async function acceptProposedCorrectingIfGated(field: Locator): Promise<void> {
  await field.getByTestId('use-proposed').click();

  // Not gated → the decision already went through; nothing to correct.
  if (!(await field.getByTestId('value-error').isVisible())) return;

  // Gated: the crawl value didn't conform to the field's typed descriptor.
  // Correct the editor by its kind, then re-click `use-proposed`.
  const editor = field.getByTestId('edit-proposed-value');
  const tagName = await editor.evaluate((element) => element.tagName.toLowerCase());

  if (tagName === 'select') {
    // enum / boolean editor. Gating on a <select> means the current value is
    // NOT among the declared options, so the workbench prepended a leading
    // out-of-set <option> at index 0; every option after it is a declared,
    // guaranteed-valid choice (an enumValue, or true/false for boolean). Read
    // the option values, drop the empty/out-of-set leading entry, and pick the
    // last declared one (a real enumValue, or "false" for a boolean field).
    const optionValues = await editor
      .locator('option')
      .evaluateAll((nodes) =>
        nodes
          .map((node) => (node as HTMLOptionElement).value)
          .filter((value) => value !== ''),
      );
    const declaredOptions = optionValues.slice(1);
    const validOption = declaredOptions[declaredOptions.length - 1] ?? optionValues[optionValues.length - 1];
    await editor.selectOption(validOption);
  } else {
    const inputType = await editor.getAttribute('type');
    if (inputType === 'number') {
      await editor.fill('1');
    } else if (inputType === 'date') {
      await editor.fill('2025-01-01');
    }
    // text / other editors belong to untyped fields, which are never gated, so
    // there is nothing to correct — retry as-is.
  }

  await field.getByTestId('use-proposed').click();
}

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
