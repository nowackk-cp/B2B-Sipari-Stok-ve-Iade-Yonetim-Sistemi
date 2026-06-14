import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs helper, no type declarations needed for tests.
import { evaluateGate } from '../../scripts/gate-eval.mjs';

// vitest runs with cwd = package root, so the gate script resolves from cwd.
const GATE = resolve(process.cwd(), 'scripts/db-test-gate.mjs');

/** Run the gate wrapper with a controlled environment (PATH preserved). */
function runGate(args: string[], env: Record<string, string | undefined>) {
  const baseEnv: Record<string, string | undefined> = { ...process.env };
  // Clear inherited DB/skip context so each case starts from a known state.
  delete baseEnv.DATABASE_URL;
  delete baseEnv.SHADOW_DATABASE_URL;
  delete baseEnv.ALLOW_DB_TEST_SKIP;
  delete baseEnv.CI_SKIP_DB_TESTS;
  delete baseEnv.CI;
  const res = spawnSync('node', [GATE, ...args], {
    env: { ...baseEnv, ...env },
    encoding: 'utf8',
  });
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

describe('db-test-gate fail-closed behaviour', () => {
  it('fails when DATABASE_URL is not set (test:integration:db mode)', () => {
    const { status, out } = runGate([], {});
    expect(status).toBe(1);
    expect(out).toMatch(/DB TESTS NOT EXECUTED/);
  });

  it('fails when DATABASE_URL points at an unreachable database', () => {
    const { status, out } = runGate([], {
      // Closed port — TCP probe must fail fast.
      DATABASE_URL: 'postgresql://u:p@127.0.0.1:59999/unreachable_test?schema=public',
    });
    expect(status).toBe(1);
    expect(out).toMatch(/DB TESTS NOT EXECUTED/);
    expect(out).toMatch(/cannot reach/i);
  });

  it('permits an explicit local skip only with --allow-local-skip + ALLOW_DB_TEST_SKIP', () => {
    const { status, out } = runGate(['--allow-local-skip'], { ALLOW_DB_TEST_SKIP: 'true' });
    expect(status).toBe(0);
    expect(out).toMatch(/DB TESTS NOT EXECUTED/);
    expect(out).toMatch(/NOT a database-gate pass/i);
  });

  it('still fails the strict gate even when ALLOW_DB_TEST_SKIP=true (no --allow-local-skip)', () => {
    const { status, out } = runGate([], { ALLOW_DB_TEST_SKIP: 'true' });
    expect(status).toBe(1);
    expect(out).toMatch(/DB TESTS NOT EXECUTED/);
  });

  it('rejects skip-bypass variables in CI even with --allow-local-skip', () => {
    const { status, out } = runGate(['--allow-local-skip'], {
      CI: 'true',
      ALLOW_DB_TEST_SKIP: 'true',
    });
    expect(status).toBe(1);
    expect(out).toMatch(/not allowed in CI/i);
  });

  it('rejects CI_SKIP_DB_TESTS in CI', () => {
    const { status, out } = runGate([], { CI: 'true', CI_SKIP_DB_TESTS: '1' });
    expect(status).toBe(1);
    expect(out).toMatch(/not allowed in CI/i);
  });
});

describe('db gate result evaluation (empty / all-skipped suites)', () => {
  it('fails an empty DB suite (0 tests collected)', () => {
    const { code, message } = evaluateGate({ status: 0, report: { numTotalTests: 0 } });
    expect(code).toBe(1);
    expect(message).toMatch(/empty DB suite/);
  });

  it('fails when every DB test is skipped even though vitest exited 0', () => {
    const { code, message } = evaluateGate({
      status: 0,
      report: { numTotalTests: 5, numPassedTests: 0, numPendingTests: 5 },
    });
    expect(code).toBe(1);
    expect(message).toMatch(/skipped/);
  });

  it('fails when no result file was produced', () => {
    const { code } = evaluateGate({ status: 0, report: null });
    expect(code).toBe(1);
  });

  it('passes when real tests executed with none skipped', () => {
    const { code } = evaluateGate({
      status: 0,
      report: { numTotalTests: 12, numPassedTests: 12, numPendingTests: 0 },
    });
    expect(code).toBe(0);
  });
});
