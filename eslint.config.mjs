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
  // Boundary rule (Mutlak Kural #1): the frontend must never reach the DB or
  // the server-side domain directly. Allowed flow: web → api-client → contracts.
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
              name: '@b2b/domain',
              message:
                'Frontend must not import the server domain. Use @b2b/api-client / @b2b/contracts.',
            },
            {
              name: '@prisma/client',
              message: 'Frontend must not access Prisma directly. Use @b2b/api-client.',
            },
          ],
          patterns: ['@b2b/database/*', '@b2b/domain/*', '@prisma/*', 'prisma'],
        },
      ],
    },
  },
  // Boundary rule: @b2b/domain is pure. No persistence, framework or logging
  // deps may leak into it (Mutlak Kural #2 / MODULE_BOUNDARIES).
  {
    files: ['packages/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@prisma/*', 'prisma', '@b2b/database', '@b2b/database/*'],
              message: 'Domain must not depend on Prisma/database.',
            },
            {
              group: ['@nestjs/*', 'next', 'next/*', 'pino', '@b2b/logger'],
              message: 'Domain must stay framework- and logger-independent.',
            },
          ],
        },
      ],
    },
  },
  // Boundary rule: @b2b/contracts is the public HTTP contract surface. It must
  // never export Prisma types or depend on a framework.
  {
    files: ['packages/contracts/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@prisma/*', 'prisma', '@b2b/database', '@b2b/database/*'],
              message: 'Contracts must not depend on or re-export Prisma.',
            },
            {
              group: ['@nestjs/*', 'next', 'next/*'],
              message: 'Contracts must stay framework-independent.',
            },
          ],
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
