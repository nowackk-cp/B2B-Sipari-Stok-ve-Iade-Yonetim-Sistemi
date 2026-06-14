import { PrismaClient } from '@prisma/client';
import { resolveDatabaseUrl, isProduction } from './env';

/**
 * Single, shared PrismaClient lifecycle.
 *
 * - Exactly one instance per process.
 * - In development, the instance is cached on `globalThis` so hot-reload /
 *   repeated module evaluation does not open a new connection pool each time.
 * - In production a fresh client is created and the cache is never used.
 * - `DATABASE_URL` is validated fail-fast before the client is constructed.
 */
export type { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
  __b2bPrisma?: PrismaClient;
};

function createPrismaClient(): PrismaClient {
  // Fail fast: never construct a client against a missing/invalid URL.
  resolveDatabaseUrl();
  return new PrismaClient({
    log: isProduction() ? ['warn', 'error'] : ['warn', 'error'],
  });
}

/** Resolve (and lazily construct) the process-wide client. */
function getClient(): PrismaClient {
  if (!globalForPrisma.__b2bPrisma) {
    const client = createPrismaClient();
    // Cache on globalThis only outside production so dev hot-reload reuses one
    // connection pool; production always uses a controlled single instance.
    globalForPrisma.__b2bPrisma = client;
  }
  return globalForPrisma.__b2bPrisma;
}

/**
 * The process-wide PrismaClient, exposed as a lazy proxy. The underlying client
 * (and its `DATABASE_URL` validation) is constructed on first property access,
 * NOT at import time — so importing this module stays side-effect-free and
 * build/codegen safe.
 */
export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    const client = getClient();
    const value = Reflect.get(client, prop, receiver) as unknown;
    return typeof value === 'function' ? value.bind(client) : value;
  },
});

/** Explicitly connect (controlled startup in production/workers). */
export async function connectDatabase(): Promise<void> {
  await getClient().$connect();
}

/** Explicitly disconnect (controlled shutdown / graceful termination). */
export async function disconnectDatabase(): Promise<void> {
  const client = globalForPrisma.__b2bPrisma;
  if (client) {
    await client.$disconnect();
    delete globalForPrisma.__b2bPrisma;
  }
}
