import { defineConfig } from 'vitest/config';

/**
 * Unit test config — NO database required.
 *
 * Covers the fail-closed gate runner's behaviour (scripts/db-test-gate.mjs):
 * how it reacts to a missing/unreachable DATABASE_URL, explicit local skips and
 * CI skip-bypass variables. These tests spawn the wrapper as a child process
 * with crafted environments, so they never touch PostgreSQL themselves.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
