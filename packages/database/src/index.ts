/**
 * @b2b/database — Prisma data-access package.
 *
 * Server-only. The ESLint boundary rules forbid `@b2b/database` (and Prisma)
 * imports from the frontend, `@b2b/contracts` and `@b2b/domain`. Repositories
 * and business services are added in later tasks; this package owns the schema,
 * migrations, the shared client lifecycle, the transaction helper and the seed.
 */
export const DATABASE_PACKAGE_NAME = '@b2b/database';

/** Location of the Prisma schema relative to this package root. */
export const PRISMA_SCHEMA_PATH = 'prisma/schema.prisma';

// Prisma namespace + generated types for server-side consumers (api/worker).
// Never imported by the frontend or contract packages (boundary-enforced).
export { Prisma, PrismaClient } from '@prisma/client';

export { prisma, connectDatabase, disconnectDatabase } from './client';
export { withTransaction } from './transaction';
export type { TransactionClient, TransactionOptions } from './transaction';
export { resolveDatabaseUrl, isProduction } from './env';
export { seed } from './seed';
export type { SeedReport } from './seed';
