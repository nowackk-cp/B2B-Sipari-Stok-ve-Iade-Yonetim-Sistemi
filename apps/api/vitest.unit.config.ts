import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

/**
 * Unit test config — NO database, NO booted app. Pure logic only (password
 * policy, argon2 params, token signing/verification, cookie options, redaction,
 * rate-limiter, lockout decisions). Fast and hermetic.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/unit/**/*.test.ts'],
    setupFiles: ['./test/setup-env.ts'],
    globals: false,
    pool: 'forks',
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
