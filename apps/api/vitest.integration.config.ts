import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Integration test config — booted Nest app against REAL PostgreSQL.
 *
 * Runs strictly serially in a single fork: the suites share one database and
 * reset it between cases, so file/test parallelism would be unsafe (the
 * concurrency tests fire their own parallel requests against that single DB).
 * The fail-closed runner (scripts/api-test-gate.mjs) guarantees a reachable DB
 * before vitest starts, so suites never self-skip into a false green.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/integration/**/*.test.ts'],
    setupFiles: ['./test/setup-integration.ts'],
    globals: false,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    sequence: { concurrent: false },
    hookTimeout: 60_000,
    testTimeout: 60_000,
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
