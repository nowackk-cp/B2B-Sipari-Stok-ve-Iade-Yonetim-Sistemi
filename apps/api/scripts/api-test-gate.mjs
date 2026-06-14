#!/usr/bin/env node
// Fail-closed API integration test runner (mirrors the database gate).
//
// The auth integration suite must execute against REAL PostgreSQL. This wrapper
// makes a silent fake-pass impossible:
//   • No DATABASE_URL / unreachable database  → exit 1 ("API TESTS NOT EXECUTED")
//   • Zero tests collected                    → exit 1
//   • Any test skipped/pending                → exit 1
//   • In CI, any skip-bypass env var present  → exit 1
//
// --allow-local-skip (used by the plain `test` script) permits a local-only skip
// ONLY when ALLOW_DB_TEST_SKIP=true, not in CI, and the DB is unreachable.
import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const allowLocalSkip = process.argv.includes('--allow-local-skip');
const isCI = String(process.env.CI ?? '').toLowerCase() === 'true';
const BYPASS_VARS = ['ALLOW_DB_TEST_SKIP', 'CI_SKIP_DB_TESTS', 'SKIP_DB_TESTS', 'NO_DB_TESTS'];

if (isCI) {
  const present = BYPASS_VARS.filter((v) => process.env[v] !== undefined && process.env[v] !== '');
  if (present.length > 0) {
    console.error(
      `✖ API TESTS NOT EXECUTED: skip-bypass variable(s) ${present.join(', ')} are not allowed in CI.`,
    );
    process.exit(1);
  }
}

function fail(msg) {
  console.error(`✖ API TESTS NOT EXECUTED: ${msg}`);
  process.exit(1);
}

function maybeLocalSkip(reason) {
  if (allowLocalSkip && !isCI && String(process.env.ALLOW_DB_TEST_SKIP) === 'true') {
    console.warn(
      `⚠ API TESTS NOT EXECUTED: ${reason} (skipped locally via ALLOW_DB_TEST_SKIP=true).`,
    );
    console.warn('  This skip is NOT an integration-gate pass.');
    process.exit(0);
  }
  fail(reason);
}

const url = process.env.DATABASE_URL;
if (!url) maybeLocalSkip('DATABASE_URL is not set');

let host;
let port;
try {
  const u = new URL(url);
  host = u.hostname;
  port = Number(u.port || 5432);
} catch {
  fail('DATABASE_URL is not a valid connection URL');
}

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
if (!reachable) maybeLocalSkip(`cannot reach PostgreSQL at ${host}:${port}`);

const outFile = join(tmpdir(), `api-gate-${process.pid}-${Date.now()}.json`);
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

const status = run.status ?? 1;
if (!report) fail('vitest produced no parseable result file (the suite did not run)');
const total = report.numTotalTests ?? 0;
const passed = report.numPassedTests ?? 0;
const failed = report.numFailedTests ?? 0;
const skipped = (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0);

if (status !== 0 || failed > 0) {
  console.error(`✖ API integration tests failed (${failed} failed of ${total}).`);
  process.exit(status || 1);
}
if (total === 0) fail('no API integration tests were collected (empty suite)');
if (skipped > 0) {
  fail(`${skipped} API test(s) were skipped — a skipped test cannot count as a gate pass`);
}
console.log(
  `✓ API integration gate: ${passed}/${total} real PostgreSQL tests executed, 0 skipped.`,
);
process.exit(0);
