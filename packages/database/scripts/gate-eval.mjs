// Pure evaluation of a vitest run for the database gate. Extracted so it can be
// unit-tested without a database: the rule is that a database-gate pass REQUIRES
// at least one executed test and ZERO skipped tests, even though vitest itself
// treats an empty/all-skipped run as success.

/**
 * @param {{ status: number, report: { numTotalTests?: number, numPassedTests?: number, numFailedTests?: number, numPendingTests?: number, numTodoTests?: number } | null }} input
 * @returns {{ code: number, message: string }}
 */
export function evaluateGate({ status, report }) {
  if (!report) {
    return {
      code: 1,
      message:
        'DB TESTS NOT EXECUTED: vitest produced no parseable result file (the suite did not run)',
    };
  }
  const total = report.numTotalTests ?? 0;
  const passed = report.numPassedTests ?? 0;
  const failed = report.numFailedTests ?? 0;
  const skipped = (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0);

  if (status !== 0 || failed > 0) {
    return { code: status || 1, message: `Database tests failed (${failed} failed of ${total}).` };
  }
  if (total === 0) {
    return {
      code: 1,
      message: 'DB TESTS NOT EXECUTED: no database tests were collected (empty DB suite)',
    };
  }
  if (skipped > 0) {
    return {
      code: 1,
      message: `DB TESTS NOT EXECUTED: ${skipped} database test(s) were skipped — a skipped DB test cannot count as a gate pass`,
    };
  }
  return {
    code: 0,
    message: `Database gate: ${passed}/${total} real PostgreSQL tests executed, 0 skipped.`,
  };
}
