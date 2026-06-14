import { defineConfig } from 'vitest/config';

/**
 * Integration test config — real PostgreSQL only.
 *
 * The DB suite runs strictly serially (single fork, no file parallelism) because
 * tests share one database and reset it between cases; parallel execution would
 * not be safe. Tests self-skip (via `describe.skipIf`) when no test database is
 * configured, so they never report a false green without a real database.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    sequence: { concurrent: false },
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
});
