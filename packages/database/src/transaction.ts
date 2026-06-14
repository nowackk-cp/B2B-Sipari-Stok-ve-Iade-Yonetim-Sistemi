import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma as defaultClient } from './client';

/**
 * Transaction-scoped client handle passed to a unit-of-work callback. It is the
 * interactive-transaction variant of `PrismaClient` (no nested `$transaction`,
 * no `$connect`/`$disconnect`). Repositories/services (added in later tasks)
 * receive this `tx` and MUST NOT open their own transaction.
 */
export type TransactionClient = Prisma.TransactionClient;

export interface TransactionOptions {
  /** Max time (ms) the interactive transaction may run before rollback. */
  timeout?: number;
  /** Max time (ms) Prisma waits to acquire a connection. */
  maxWait?: number;
  /** Postgres isolation level. Defaults to READ COMMITTED (design default). */
  isolationLevel?: Prisma.TransactionIsolationLevel;
}

/**
 * Run `fn` inside a single interactive database transaction and return its
 * result. Throwing from `fn` rolls the whole unit of work back. This is the one
 * place a transaction is opened (DATABASE_DESIGN §18: the top-level service
 * starts the transaction; callees take `tx`).
 */
export async function withTransaction<T>(
  fn: (tx: TransactionClient) => Promise<T>,
  options: TransactionOptions = {},
  client: PrismaClient = defaultClient,
): Promise<T> {
  return client.$transaction((tx) => fn(tx), {
    timeout: options.timeout,
    maxWait: options.maxWait,
    isolationLevel: options.isolationLevel,
  });
}
