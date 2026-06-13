import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC compiles decorators with metadata so NestJS DI works under Vitest.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    setupFiles: ['./test/setup-env.ts'],
    globals: false,
    pool: 'forks',
  },
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
