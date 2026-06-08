import { expect, test, type Page } from '@playwright/test';

const fixturePath = '/admin/review/survey-fixture';

test('renders the embedded Survey workbench and records reviewer decisions', async ({ page }) => {
  const consoleErrors = await loadFixture(page);

  await expect(page.getByRole('heading', { name: 'Survey review workbench' })).toBeVisible();
  await expect(page.locator('.survey-workbench-embed .workbench-shell')).toBeVisible();
  await expect(page.getByTestId('review-queue')).toContainText('ageRange');
  await expect(page.getByTestId('review-queue')).toContainText('registrationStatus');
  await expect(page.getByTestId('review-focus')).toContainText('Ages 7-12');
  await expect(page.getByTestId('surface-preview')).toContainText('Surface preview');

  await page.locator(".decision-column [data-decision='accept-proposed']").click();
  await page.getByTestId('reviewer-note').fill('Fixture accepts the updated age range.');
  await expect(page.getByTestId('surface-preview')).toContainText('Fixture accepts the updated age range.');
  await expect(page.getByTestId('session-event-list')).toContainText('decision-changed');
  await expect(page.getByTestId('session-event-list')).toContainText('note-changed');

  await page.reload();
  await expect(page.getByTestId('reviewer-note')).toHaveValue('Fixture accepts the updated age range.');
  await expect(page.locator(".decision-column [data-decision='accept-proposed']")).toHaveClass(/is-active/);
  expect(consoleErrors).toEqual([]);
});

test('keeps Survey embed styles contained inside the CampFit fixture shell', async ({ page }) => {
  await loadFixture(page);

  const embedBox = await page.locator('.survey-workbench-embed').boundingBox();
  const workbenchBox = await page.locator('.survey-workbench-embed .workbench-shell').boundingBox();
  const position = await page.locator('.survey-workbench-embed').evaluate((element) => {
    const styles = window.getComputedStyle(element, '::before');
    return styles.position;
  });

  expect(embedBox).not.toBeNull();
  expect(workbenchBox).not.toBeNull();
  expect(position).toBe('absolute');
  if (embedBox && workbenchBox) {
    expect(workbenchBox.x).toBeGreaterThanOrEqual(embedBox.x);
    expect(workbenchBox.x + workbenchBox.width).toBeLessThanOrEqual(embedBox.x + embedBox.width + 1);
  }
});

test('keeps the CampFit Survey fixture usable at mobile width', async ({ page }) => {
  test.skip(test.info().project.name !== 'chromium-mobile', 'mobile-only layout check');
  await loadFixture(page);

  await expect(page.locator('.survey-workbench-embed .workbench-shell')).toBeVisible();
  await expect(page.getByTestId('active-review-strip')).toBeVisible();
  await expect(page.getByTestId('session-audit')).toBeVisible();

  const viewport = page.viewportSize();
  const workbenchBox = await page.locator('.survey-workbench-embed .workbench-shell').boundingBox();
  const activeStripBox = await page.getByTestId('active-review-strip').boundingBox();
  expect(viewport).not.toBeNull();
  expect(workbenchBox).not.toBeNull();
  expect(activeStripBox).not.toBeNull();

  if (viewport && workbenchBox && activeStripBox) {
    expect(workbenchBox.x).toBeGreaterThanOrEqual(0);
    expect(activeStripBox.x).toBeGreaterThanOrEqual(0);
    expect(workbenchBox.x + workbenchBox.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(activeStripBox.x + activeStripBox.width).toBeLessThanOrEqual(viewport.width + 1);
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
