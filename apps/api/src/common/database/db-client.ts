import type { Prisma, PrismaClient } from '@b2b/database';

/**
 * Executor accepted by repositories: either the root client or an interactive
 * transaction handle. Repositories never open their own transaction — the
 * top-level service passes `tx` down (MODULE_BOUNDARIES §1, DATABASE_DESIGN §18).
 */
export type DbClient = PrismaClient | Prisma.TransactionClient;
