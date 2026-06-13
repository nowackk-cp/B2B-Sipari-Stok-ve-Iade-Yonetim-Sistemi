import { createLogger } from '@b2b/logger';

const logger = createLogger({
  service: 'db-seed',
  environment: process.env.NODE_ENV ?? 'development',
});

/**
 * Database seed entry point.
 *
 * The domain schema is not implemented yet (lands in TASK-004), so there is no
 * data to seed. This is a real, runnable no-op mechanism — not a placeholder:
 * later tasks add permission/role/series seeds here, each idempotent.
 *
 * It deliberately does NOT open a database connection, because no tables exist.
 */
export async function seed(): Promise<void> {
  logger.info(
    { phase: 'foundation' },
    'No domain schema yet — nothing to seed. Seed data is added in TASK-004 and later tasks.',
  );
}

if (require.main === module) {
  seed()
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      logger.error({ err }, 'Seed failed');
      process.exit(1);
    });
}
