import { defineConfig, devices } from '@playwright/test';

/**
 * Web E2E config. Boots the REAL API (built) and the web app, then runs Chromium
 * against the real stack. A deterministic E2E user is seeded by global-setup via
 * the API package's seed script (the web package never imports the database).
 *
 * DATABASE_URL must point at a real PostgreSQL *test* database. Redis is not
 * required — the rate limiter fails open and the durable lockout (Postgres)
 * remains authoritative.
 */
const API_PORT = 3001;
const WEB_PORT = 3000;
const API_BASE_URL = `http://localhost:${API_PORT}/api/v1`;

const sharedApiEnv = {
  ...process.env,
  NODE_ENV: 'development',
  LOG_LEVEL: 'warn',
  JWT_ACCESS_SECRET:
    process.env.JWT_ACCESS_SECRET ?? 'e2e-only-access-secret-at-least-32-characters-long',
  REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
  S3_ENDPOINT: process.env.S3_ENDPOINT ?? 'http://localhost:9000',
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID ?? 'test',
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY ?? 'test-secret',
  S3_BUCKET: process.env.S3_BUCKET ?? 'b2b-test',
  SMTP_HOST: process.env.SMTP_HOST ?? 'localhost',
  API_PORT: String(API_PORT),
  ARGON2_MEMORY_KIB: '8192',
  ARGON2_ITERATIONS: '2',
} as Record<string, string>;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  globalSetup: './e2e/global-setup.ts',
  timeout: 30_000,
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node dist/main.js',
      cwd: '../api',
      port: API_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: sharedApiEnv,
    },
    {
      command: `node node_modules/next/dist/bin/next start -p ${WEB_PORT}`,
      cwd: '.',
      port: WEB_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: { ...process.env, NEXT_PUBLIC_API_BASE_URL: API_BASE_URL } as Record<string, string>,
    },
  ],
});
