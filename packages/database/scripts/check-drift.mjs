#!/usr/bin/env node
// Migration ⇄ schema drift gate (allowlist-aware).
//
// Replays the committed migrations onto a shadow database and asks Prisma for
// the forward SQL needed to make that migrated shape match schema.prisma
// (`prisma migrate diff --script`). On a drift-clean repo this script is NOT
// empty: Prisma cannot model an index *predicate*, so each soft-delete partial
// unique index (`… WHERE deleted_at IS NULL`) created by the init migration
// looks, to the structural diff, like a missing plain unique index.
//
// Rather than blindly ignore "noise", we hold an EXACT allowlist of those known
// statements (scripts/drift-eval.mjs). Every diff statement must match an
// allowlisted fingerprint; ANY other statement — a missing column, missing or
// renamed FK, changed onDelete, an unexpected index, etc. — is real drift and
// fails the gate (exit 1). Triggers, CHECK constraints and the partial
// predicates themselves are invisible to this structural diff and are instead
// asserted by scripts/verify-catalog.mjs + the integration tests.
import { spawnSync } from 'node:child_process';
import { findUnexpected } from './drift-eval.mjs';

const shadow = process.env.SHADOW_DATABASE_URL;
if (!shadow) {
  console.error(
    '✖ SHADOW_DATABASE_URL is not set. The drift gate needs an empty shadow database to replay migrations.',
  );
  process.exit(1);
}

const result = spawnSync(
  'pnpm',
  [
    'exec',
    'prisma',
    'migrate',
    'diff',
    '--from-migrations',
    './prisma/migrations',
    '--to-schema-datamodel',
    './prisma/schema.prisma',
    '--shadow-database-url',
    shadow,
    '--script',
  ],
  { encoding: 'utf8', shell: process.platform === 'win32' },
);

if (result.status !== 0) {
  console.error(`✖ Drift check failed to run (exit ${result.status}).`);
  if (result.stderr) console.error(result.stderr);
  process.exit(result.status ?? 1);
}

const { statements, unexpected } = findUnexpected(result.stdout ?? '');

if (unexpected.length > 0) {
  console.error('✖ Schema/migration drift detected (unexpected statements):');
  for (const s of unexpected) console.error(`  • ${s};`);
  console.error(
    '\nIf this is an intentional custom-DDL change, add its exact fingerprint to\n' +
      'ALLOWED_DRIFT_STATEMENTS in scripts/drift-eval.mjs (and verify it in verify-catalog.mjs).',
  );
  process.exit(1);
}

console.log(
  `✓ No schema/migration drift (${statements.length} allowlisted partial-unique statement(s), 0 unexpected).`,
);
