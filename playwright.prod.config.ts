import { defineConfig, devices } from '@playwright/test';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

export default defineConfig({
  testDir: './tests/browser',
  testMatch: /prod-smoke\.spec\.ts/,
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? [['github'], ['json', { outputFile: 'test-results/prod-smoke-results.json' }]]
    : 'list',
  use: {
    baseURL: requiredEnv('PROD_SMOKE_BASE_URL'),
    ...devices['Desktop Chrome'],
    timezoneId: 'America/Denver',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    {
      name: 'production-smoke',
    },
  ],
});

function requiredEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for production smoke.`);
  return value;
}
