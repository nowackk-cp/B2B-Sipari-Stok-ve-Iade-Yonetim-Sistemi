#!/usr/bin/env node
// Fail-closed database integration test runner.
//
// The database gate is only green when real PostgreSQL tests actually execute.
// A previous design let `vitest` exit 0 while every DB test self-skipped (no
// DATABASE_URL) — a silent fake-pass. This wrapper makes that impossible:
//
//   • No DATABASE_URL / unreachable database  → exit 1 ("DB TESTS NOT EXECUTED")
//   • Zero DB tests collected                 → exit 1 ("DB TESTS NOT EXECUTED")
//   • Any DB test skipped/pending             → exit 1 ("DB TESTS NOT EXECUTED")
//   • In CI, any skip-bypass env var present  → exit 1 (bypass rejected)
//
// Modes:
//   (default / used by test:integration:db, test:database-gate) — never skip.
//   --allow-local-skip (used by the plain `test` script) — permits a local-only
//   skip ONLY when ALLOW_DB_TEST_SKIP=true, NOT in CI, and the DB is unreachable;
//   it still prints "DB TESTS NOT EXECUTED" so a skip can never read as success.
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateGate } from './gate-eval.mjs';

const allowLocalSkip = process.argv.includes('--allow-local-skip');
const isCI = String(process.env.CI ?? '').toLowerCase() === 'true';

// Skip-bypass env vars are categorically rejected in CI: a required gate must
// never be silenced by configuration.
const BYPASS_VARS = ['ALLOW_DB_TEST_SKIP', 'CI_SKIP_DB_TESTS', 'SKIP_DB_TESTS', 'NO_DB_TESTS'];
if (isCI) {
  const present = BYPASS_VARS.filter((v) => process.env[v] !== undefined && process.env[v] !== '');
  if (present.length > 0) {
    console.error(
      `✖ DB TESTS NOT EXECUTED: skip-bypass variable(s) ${present.join(', ')} are not allowed in CI.`,
    );
    process.exit(1);
  }
}

function fail(msg) {
  console.error(`✖ DB TESTS NOT EXECUTED: ${msg}`);
  process.exit(1);
}

function maybeLocalSkip(reason) {
  if (allowLocalSkip && !isCI && String(process.env.ALLOW_DB_TEST_SKIP) === 'true') {
    // Loud, unmistakable, and a non-error exit ONLY for the local convenience
    // suite. The database gate commands never pass this flag.
    console.warn(
      `⚠ DB TESTS NOT EXECUTED: ${reason} (skipped locally via ALLOW_DB_TEST_SKIP=true).`,
    );
    console.warn('  This skip is NOT a database-gate pass.');
    process.exit(0);
  }
  fail(reason);
}

const url = process.env.DATABASE_URL;
if (!url) {
  maybeLocalSkip('DATABASE_URL is not set');
}

let host;
let port;
try {
  const u = new URL(url);
  host = u.hostname;
  port = Number(u.port || 5432);
} catch {
  fail('DATABASE_URL is not a valid connection URL');
}

/** Fast TCP reachability probe (no extra deps). */
function probe(h, p, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(p, h);
  });
}

const reachable = await probe(host, port);
if (!reachable) {
  maybeLocalSkip(`cannot reach PostgreSQL at ${host}:${port}`);
}

// Database is reachable — run the suite and require real, non-skipped tests.
const outFile = join(tmpdir(), `db-gate-${process.pid}-${Date.now()}.json`);
const run = spawnSync(
  'pnpm',
  [
    'exec',
    'vitest',
    'run',
    '--config',
    'vitest.integration.config.ts',
    '--reporter=default',
    '--reporter=json',
    '--outputFile',
    outFile,
  ],
  { stdio: 'inherit', shell: process.platform === 'win32' },
);

let report = null;
try {
  report = JSON.parse(readFileSync(outFile, 'utf8'));
} catch {
  report = null;
}
rmSync(outFile, { force: true });

const { code, message } = evaluateGate({ status: run.status ?? 1, report });
if (code === 0) {
  console.log(`✓ ${message}`);
} else {
  console.error(`✖ ${message}`);
}
process.exit(code);
