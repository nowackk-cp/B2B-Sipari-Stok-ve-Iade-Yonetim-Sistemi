#!/usr/bin/env node
// Fails if any committed test uses focus/skip markers (.only/.skip/xit/fit...).
// A real gate: scans every test file and exits non-zero on the first offender.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const TEST_FILE = /\.(test|spec)\.[cm]?tsx?$/;
const PATTERNS = [
  /\b(describe|it|test|context|suite)\.only\b/,
  /\b(describe|it|test|context|suite)\.skip\b/,
  // Conditional skipping (skipIf/runIf) can silently disable a whole suite —
  // e.g. a DB suite that self-skips when no database is configured. That is a
  // fake-pass and is banned in required test paths (DBF-002).
  /\b(describe|it|test|context|suite)\.skipIf\b/,
  /\b(describe|it|test|context|suite)\.runIf\b/,
  /\b(beforeEach|afterEach|beforeAll|afterAll)\.skip\b/,
  /\bxit\b/,
  /\bxdescribe\b/,
  /\bfit\b/,
  /\bfdescribe\b/,
  /\btest\.todo\.only\b/,
];

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' });
  return out.split('\0').filter(Boolean);
}

const offenders = [];
for (const file of trackedFiles()) {
  if (!TEST_FILE.test(file)) continue;
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const lines = content.split('\n');
  lines.forEach((line, i) => {
    if (line.trimStart().startsWith('//')) return;
    for (const p of PATTERNS) {
      if (p.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
    }
  });
}

if (offenders.length > 0) {
  console.error('✖ Focused/skipped tests are not allowed:');
  for (const o of offenders) console.error(`  ${o}`);
  process.exit(1);
}
console.log('✓ No focused/skipped tests found.');
