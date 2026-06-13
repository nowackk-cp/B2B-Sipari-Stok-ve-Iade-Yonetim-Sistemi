/**
 * @b2b/database — Prisma data-access package.
 *
 * Foundation skeleton: exposes package metadata and the seed entry point.
 * The generated `PrismaClient` singleton (`client.ts`) and repositories are
 * introduced in TASK-004 once the domain schema exists.
 */
export const DATABASE_PACKAGE_NAME = '@b2b/database';

/** Location of the Prisma schema relative to this package root. */
export const PRISMA_SCHEMA_PATH = 'prisma/schema.prisma';

export { seed } from './seed';
