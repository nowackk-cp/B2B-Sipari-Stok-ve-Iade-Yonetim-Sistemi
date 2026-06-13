// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

/**
 * Shared flat ESLint config for the whole monorepo.
 * Type-aware linting is intentionally disabled to keep `pnpm lint` fast and
 * independent of build output; correctness is enforced by `pnpm typecheck`.
 */
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/playwright-report/**',
      '**/test-results/**',
      'packages/database/generated/**',
      '**/*.tsbuildinfo',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'off',
      'no-empty': ['error', { allowEmptyCatch: false }],
    },
  },
  // Boundary rule (Mutlak Kural #1): the frontend must never reach the DB
  // directly. Forbid Prisma / database-package imports inside apps/web.
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@b2b/database',
              message: 'Frontend must not access the database directly. Use @b2b/api-client.',
            },
            {
              name: '@prisma/client',
              message: 'Frontend must not access Prisma directly. Use @b2b/api-client.',
            },
          ],
          patterns: ['@b2b/database/*', '@prisma/*', 'prisma'],
        },
      ],
    },
  },
  // Node-context files (config, scripts, plain JS/MJS) get Node globals.
  {
    files: [
      '**/*.config.{ts,mts,cts,js,mjs,cjs}',
      '**/vitest.setup.ts',
      'scripts/**/*.{ts,mjs,js}',
      '**/*.{mjs,cjs}',
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  prettier,
);
