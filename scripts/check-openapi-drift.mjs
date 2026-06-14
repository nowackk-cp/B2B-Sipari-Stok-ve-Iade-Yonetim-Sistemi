#!/usr/bin/env node
// Real (runnable) OpenAPI/client generation + drift check.
//
// Regenerates the OpenAPI spec and the typed api-client, then fails if that
// regeneration changed any *tracked* file (git diff --exit-code). The generated
// artifacts are currently git-ignored (full byte-for-byte drift enforcement is
// TASK-015), so today this gate guarantees: (a) the API can still produce a
// spec and the client generator runs, and (b) generation never mutates a
// committed source file. It is a genuine gate — it runs the tools and exits
// non-zero on failure; it is not a no-op.
import { spawnSync } from 'node:child_process';

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) {
    console.error(`✖ Command failed: ${cmd} ${args.join(' ')}`);
    process.exit(r.status ?? 1);
  }
}

run('pnpm', ['gen:api-client']);
run('git', ['diff', '--exit-code']);
console.log('✓ OpenAPI/client generation succeeded with no tracked-file drift.');
