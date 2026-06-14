#!/usr/bin/env node
// Seed a deterministic user for the web E2E suite.
//
// Lives in the API package (which legitimately depends on the database + the
// password hasher); the web E2E global-setup invokes it as a child process so
// the frontend package never imports the database (boundary rule).
import { randomBytes } from 'node:crypto';
import { PrismaClient } from '@b2b/database';
import { argon2id } from 'hash-wasm';

const EMAIL = process.env.E2E_USER_EMAIL ?? 'e2e@test.local';
const PASSWORD = process.env.E2E_USER_PASSWORD ?? 'e2e correct horse staple';

async function main() {
  const dbName = new URL(process.env.DATABASE_URL ?? '').pathname.replace(/^\//, '');
  if (!/test/i.test(dbName)) {
    throw new Error(`Refusing to seed E2E user into non-test database "${dbName}".`);
  }
  const prisma = new PrismaClient();
  const passwordHash = await argon2id({
    password: PASSWORD.normalize('NFKC'),
    salt: randomBytes(16),
    memorySize: 8192,
    iterations: 2,
    parallelism: 1,
    hashLength: 32,
    outputType: 'encoded',
  });
  // find-then-write (avoid ON CONFLICT against the citext unique index).
  const existing = await prisma.user.findUnique({ where: { email: EMAIL }, select: { id: true } });
  if (existing) {
    await prisma.user.update({
      where: { id: existing.id },
      data: {
        passwordHash,
        status: 'ACTIVE',
        deletedAt: null,
        lockedUntil: null,
        failedLoginCount: 0,
      },
    });
  } else {
    await prisma.user.create({
      data: { email: EMAIL, passwordHash, fullName: 'E2E User', status: 'ACTIVE' },
    });
  }
  await prisma.$disconnect();
  console.log(`E2E user ready: ${EMAIL}`);
}

main().catch((err) => {
  console.error('Failed to seed E2E user', err);
  process.exit(1);
});
