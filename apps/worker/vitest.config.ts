import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

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
