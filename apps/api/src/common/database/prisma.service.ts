import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import {
  prisma,
  disconnectDatabase,
  withTransaction,
  type PrismaClient,
  type TransactionClient,
  type TransactionOptions,
} from '@b2b/database';

/**
 * Thin Nest provider over the process-wide Prisma client and the single
 * `withTransaction` unit-of-work helper (DATABASE_DESIGN §18: the top-level
 * service opens the transaction; callees receive `tx`).
 *
 * No eager `$connect` at module init — Prisma connects lazily on first query so
 * importing the API (e.g. for OpenAPI generation or non-DB tests) never forces a
 * live database. The pool is closed on graceful shutdown.
 */
@Injectable()
export class PrismaService implements OnModuleDestroy {
  /** The shared Prisma client. Repositories own their tables; see MODULE_BOUNDARIES. */
  readonly client: PrismaClient = prisma;

  /** Run a callback inside one interactive transaction. */
  transaction<T>(
    fn: (tx: TransactionClient) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> {
    return withTransaction(fn, options);
  }

  async onModuleDestroy(): Promise<void> {
    await disconnectDatabase();
  }
}
