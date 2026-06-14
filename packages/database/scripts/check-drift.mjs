#!/usr/bin/env node
// Migration ⇄ schema drift gate.
//
// Replays the committed migrations onto a shadow database and compares the
// resulting (Prisma-modelable) shape with schema.prisma. Exit code 2 from
// `prisma migrate diff --exit-code` means drift exists → this script fails.
//
// Prisma cannot model CHECK constraints, triggers or index predicates, so those
// migration-only objects are intentionally invisible to this structural diff;
// they are verified by the constraint/trigger integration tests instead.
import { spawnSync } from 'node:child_process';

const shadow = process.env.SHADOW_DATABASE_URL;
if (!shadow) {
  console.error(
    '✖ SHADOW_DATABASE_URL is not set. The drift gate needs an empty shadow database to replay migrations.',
  );
  process.exit(1);
}

const args = [
  'prisma',
  'migrate',
  'diff',
  '--from-migrations',
  './prisma/migrations',
  '--to-schema-datamodel',
  './prisma/schema.prisma',
  '--shadow-database-url',
  shadow,
  '--exit-code',
];

const result = spawnSync('pnpm', ['exec', ...args], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.status === 0) {
  console.log('✓ No schema/migration drift.');
  process.exit(0);
}
if (result.status === 2) {
  console.error('✖ Schema/migration drift detected (see diff above).');
  process.exit(1);
}
console.error(`✖ Drift check failed to run (exit ${result.status}).`);
process.exit(result.status ?? 1);
