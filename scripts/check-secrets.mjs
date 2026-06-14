#!/usr/bin/env node
// Basic but real repository secret scan. Scans tracked files for high-signal
// credential patterns and exits non-zero on any match. Deliberately narrow to
// avoid false positives on clearly-labelled development defaults.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const SKIP_FILES = new Set(['pnpm-lock.yaml']);
const SKIP_EXT = /\.(png|jpg|jpeg|gif|webp|ico|pdf|lock|woff2?|ttf)$/i;

const RULES = [
  { name: 'Private key block', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    name: 'AWS secret access key',
    re: /aws_secret_access_key\s*[=:]\s*['"][A-Za-z0-9/+]{40}['"]/i,
  },
  { name: 'Slack token', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/ },
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'GitHub token', re: /\bghp_[0-9A-Za-z]{36}\b/ },
  {
    name: 'Generic bearer secret',
    re: /\b(?:secret|api[_-]?key|token)\s*[:=]\s*['"][A-Za-z0-9_-]{32,}['"]/i,
  },
];

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
}

const findings = [];
for (const file of trackedFiles()) {
  if (SKIP_FILES.has(file) || SKIP_EXT.test(file)) continue;
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const lines = content.split('\n');
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.re.test(line)) findings.push(`${file}:${i + 1}: ${rule.name}`);
    }
  });
}

if (findings.length > 0) {
  console.error('✖ Potential secrets detected:');
  for (const f of findings) console.error(`  ${f}`);
  process.exit(1);
}
console.log('✓ No obvious secrets found in tracked files.');
