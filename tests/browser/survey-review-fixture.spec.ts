import { expect, test, type Page } from '@playwright/test';

const fixturePath = '/admin/review/survey-fixture';

// The embedded Survey workbench (Survey 1.12.0 field-diff surface) is the single
// review UI. Fields render as diff cards; a decision is a per-field "Use proposed"
// / "Keep current"; the reviewer note lives inside each card's collapsed
// "Audit details". These specs need a live dev server + .env.local, so they run
// in campfit CI (not in an offline checkout).

test('renders the embedded Survey workbench and records reviewer decisions', async ({ page }) => {
  const consoleErrors = await loadFixture(page);

  await expect(page.locator('.survey-workbench-embed .workbench-shell')).toBeVisible();
  await expect(page.getByTestId('review-fields')).toBeVisible();
  // Both proposal fields render as diff cards, with the proposed value shown.
  await expect(page.getByTestId('review-fields')).toContainText('Ages 7-12');

  // Decide the first field: "Use proposed" → the card shows the Accepted chip.
  const field = page.getByTestId('review-field').first();
  await field.getByTestId('use-proposed').click();
  await expect(field.getByTestId('decided-chip')).toHaveText('Accepted');

  // The reviewer note lives inside the card's collapsed Audit details.
  await field.getByTestId('audit-details').locator('summary').first().click();
  await field.getByTestId('reviewer-note').fill('Fixture accepts the updated age range.');

  // The decision + note survive a reload (persisted via the fixture event store).
  await page.reload();
  await expect(page.locator('.survey-workbench-embed .workbench-shell')).toBeVisible();
  const reloaded = page.getByTestId('review-field').first();
  await expect(reloaded.getByTestId('decided-chip')).toHaveText('Accepted');
  await reloaded.getByTestId('audit-details').locator('summary').first().click();
  await expect(reloaded.getByTestId('reviewer-note')).toHaveValue('Fixture accepts the updated age range.');

  expect(consoleErrors).toEqual([]);
});

test('gates a non-conforming typed field until the value is corrected', async ({ page }) => {
  // TYPED-VALUE GATING (survey 1.13.0): the fixture's registrationStatus field
  // carries a typed enum descriptor (OPEN/FULL/WAITLIST/...) but a deliberately
  // non-canonical crawl value ('Waitlist'), so its editor renders a <select> and
  // `use-proposed` must be BLOCKED until the value is corrected to a declared
  // enumValue. This is the deterministic (controlled-data) counterpart to the
  // live-proposal robustness in survey-review-real-proposal.spec.ts.
  await loadFixture(page);

  // Pin the field by its STABLE `data-field` (registrationStatus). The workbench
  // removes the proposed-value editor once a field is decided, so a
  // `filter({ has: select })` locator would stop matching after acceptance and
  // the post-decision assertions would find nothing.
  const typedField = page.locator('[data-testid="review-field"][data-field="registrationStatus"]');
  await expect(typedField).toBeVisible();
  // While undecided it renders the typed enum editor (a <select>), not free-text.
  await expect(typedField.locator('select[data-testid="edit-proposed-value"]')).toBeVisible();

  // Accepting the non-conforming value is blocked: the error un-hides and the
  // field stays undecided (no decision persisted).
  await typedField.getByTestId('use-proposed').click();
  await expect(typedField.getByTestId('value-error')).toBeVisible();
  await expect(typedField).toHaveAttribute('data-state', 'review');

  // Correct to a declared enum value, then accept — the decision goes through.
  await typedField.getByTestId('edit-proposed-value').selectOption('WAITLIST');
  await typedField.getByTestId('use-proposed').click();
  await expect(typedField).toHaveAttribute('data-state', 'accepted');
  await expect(typedField.getByTestId('decided-chip')).toHaveText('Accepted');
});

test('keeps Survey embed styles contained inside the CampFit fixture shell', async ({ page }) => {
  await loadFixture(page);

  const embedBox = await page.locator('.survey-workbench-embed').boundingBox();
  const workbenchBox = await page.locator('.survey-workbench-embed .workbench-shell').boundingBox();

  expect(embedBox).not.toBeNull();
  expect(workbenchBox).not.toBeNull();
  if (embedBox && workbenchBox) {
    // The workbench never spills horizontally outside its CampFit host container.
    expect(workbenchBox.x).toBeGreaterThanOrEqual(embedBox.x - 1);
    expect(workbenchBox.x + workbenchBox.width).toBeLessThanOrEqual(embedBox.x + embedBox.width + 1);
  }
});

test('keeps the CampFit Survey fixture usable at mobile width', async ({ page }) => {
  test.skip(test.info().project.name !== 'chromium-mobile', 'mobile-only layout check');
  await loadFixture(page);

  await expect(page.locator('.survey-workbench-embed .workbench-shell')).toBeVisible();
  await expect(page.getByTestId('review-fields')).toBeVisible();

  const viewport = page.viewportSize();
  const fieldsBox = await page.getByTestId('review-fields').boundingBox();
  const fieldBox = await page.getByTestId('review-field').first().boundingBox();
  expect(viewport).not.toBeNull();
  expect(fieldsBox).not.toBeNull();
  expect(fieldBox).not.toBeNull();

  if (viewport && fieldsBox && fieldBox) {
    // Nothing forces a horizontal scroll at mobile width.
    expect(fieldsBox.x).toBeGreaterThanOrEqual(0);
    expect(fieldBox.x).toBeGreaterThanOrEqual(0);
    expect(fieldsBox.x + fieldsBox.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(fieldBox.x + fieldBox.width).toBeLessThanOrEqual(viewport.width + 1);
  }
});

async function loadFixture(page: Page): Promise<string[]> {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    consoleErrors.push(error.message);
  });

  await page.goto(fixturePath);
  await expect(page.locator('.survey-workbench-embed .workbench-shell')).toBeVisible();
  return consoleErrors;
}
