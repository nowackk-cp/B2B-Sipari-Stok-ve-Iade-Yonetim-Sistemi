import { defineConfig } from '@playwright/test';

/**
 * E2E configuration for the foundation milestone.
 *
 * Full browser-driven flows (login → dashboard → order → ship → invoice) are
 * added in Phase 7 once the web app and auth exist (TEST_STRATEGY.md §7). For
 * now this runs contract-level smokes that need neither a browser nor a running
 * server, so `pnpm test:e2e` is green and meaningful in CI without extra setup.
 */
export default defineConfig({
  testDir: './specs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? 'list' : 'line',
});
