/**
 * Prisma `db seed` entry point.
 *
 * The seed logic lives in `src/seed.ts` (single, central, testable source).
 * This thin runner exists so `prisma db seed` and the `db:seed` script share
 * exactly the same implementation.
 */
import { PrismaClient } from '@prisma/client';
import { seed } from '../src/seed';

const prisma = new PrismaClient();

seed(prisma)
  .then(async () => {
    await prisma.$disconnect();
    process.exit(0);
  })
  .catch(async (err: unknown) => {
    await prisma.$disconnect();
    console.error('Seed failed:', err);
    process.exit(1);
  });
