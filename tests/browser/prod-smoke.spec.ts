import { expect, test, type Page, type Request } from '@playwright/test';

const appOrigin = new URL(requiredEnv('PROD_SMOKE_BASE_URL')).origin;
const mutatingMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

test('production smoke keeps public, auth, and admin review surfaces healthy', async ({ page }) => {
  const errors = collectBrowserErrors(page);
  const adminReviewPath = requiredEnv('PROD_SMOKE_ADMIN_REVIEW_PATH');

  await expectOkNavigation(page, '/');
  await expect(page.getByRole('heading', { name: /find camps in/i })).toBeVisible();

  await expectOkNavigation(page, '/c/denver');
  await expect(page.getByRole('heading').first()).toBeVisible();

  await expectOkNavigation(page, '/auth/forgot-password');
  await expect(page.getByRole('heading', { name: /reset your password/i })).toBeVisible();

  await signIn(page);
  const blockedMutations = await blockFirstPartyMutations(page);
  await expectOkNavigation(page, adminReviewPath);

  await expect(page.getByRole('heading', { name: 'Survey review workbench' })).toBeVisible();
  await expect(page.getByText('Browser fixture')).toBeVisible();
  await expect(page.locator('.survey-workbench-embed .workbench-shell')).toBeVisible();
  await expect(page.getByTestId('survey-review-trail')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Saved Survey decisions' })).toBeVisible();

  await page.waitForTimeout(3_000);
  expect(errors.consoleErrors, 'console.error output').toEqual([]);
  expect(errors.pageErrors, 'page errors').toEqual([]);
  expect(errors.requestFailures, 'unexpected request failures').toEqual([]);
  expect(blockedMutations, 'blocked first-party mutating requests').toEqual([]);
});

async function signIn(page: Page) {
  const email = process.env.PLAYWRIGHT_ADMIN_EMAIL;
  const password = process.env.PLAYWRIGHT_ADMIN_PASSWORD;

  if (!email || !password) {
    throw new Error('PLAYWRIGHT_ADMIN_EMAIL and PLAYWRIGHT_ADMIN_PASSWORD are required for production smoke.');
  }

  await expectOkNavigation(page, '/auth/login');
  await page.getByPlaceholder('you@example.com').fill(email);
  await page.getByPlaceholder('••••••••').fill(password);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/dashboard(?:\?|$)/);
}

async function expectOkNavigation(page: Page, path: string) {
  const response = await page.goto(path, { waitUntil: 'domcontentloaded' });
  expect(response, `navigation response for ${path}`).not.toBeNull();
  expect(response?.ok(), `navigation status for ${path}: ${response?.status()}`).toBe(true);
}

function collectBrowserErrors(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error' && !isIgnorableConsoleError(message.text())) {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });
  page.on('requestfailed', (request) => {
    if (!isIgnorableRequestFailure(request)) {
      requestFailures.push(`${request.method()} ${request.url()} :: ${request.failure()?.errorText ?? 'unknown failure'}`);
    }
  });

  return { consoleErrors, pageErrors, requestFailures };
}

async function blockFirstPartyMutations(page: Page) {
  const blocked: string[] = [];
  await page.route('**/*', async (route) => {
    const request = route.request();
    if (isFirstPartyRequest(request) && mutatingMethods.has(request.method().toUpperCase())) {
      blocked.push(`${request.method()} ${request.url()}`);
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  return blocked;
}

function isIgnorableRequestFailure(request: Request) {
  const failure = request.failure()?.errorText ?? '';
  const url = request.url();
  if (!isFirstPartyRequest(request)) return true;
  return failure.includes('ERR_ABORTED') && (url.includes('_rsc=') || request.resourceType() === 'fetch');
}

function isIgnorableConsoleError(text: string) {
  return text.includes('net::ERR_ABORTED') && text.includes('_rsc=');
}

function isFirstPartyRequest(request: Request) {
  return new URL(request.url()).origin === appOrigin;
}

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for production smoke.`);
  return value;
}
