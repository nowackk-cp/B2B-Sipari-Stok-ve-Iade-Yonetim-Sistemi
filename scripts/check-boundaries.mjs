#!/usr/bin/env node
// Static package-boundary check (defense in depth on top of the ESLint rules).
// Verifies the approved dependency direction: nothing below the API may import
// Prisma/the database package, and the frontend stays on api-client/contracts.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

/** Each rule: source dir → import specifiers that must never appear. */
const RULES = [
  {
    dir: 'packages/domain/src',
    forbid: [
      '@prisma/client',
      'prisma',
      '@b2b/database',
      '@nestjs/common',
      '@nestjs/core',
      'next',
      'pino',
      '@b2b/logger',
    ],
    why: '@b2b/domain must be pure (no Prisma/framework/logger).',
  },
  {
    dir: 'packages/contracts/src',
    forbid: ['@prisma/client', 'prisma', '@b2b/database', '@nestjs/common', '@nestjs/core', 'next'],
    why: '@b2b/contracts must not depend on or re-export Prisma / a framework.',
  },
  {
    dir: 'packages/api-client/src',
    forbid: ['@prisma/client', 'prisma', '@b2b/database'],
    why: '@b2b/api-client must not reach the database/Prisma.',
  },
  {
    dir: 'apps/web',
    forbid: ['@prisma/client', 'prisma', '@b2b/database', '@b2b/domain'],
    why: 'Frontend must use @b2b/api-client / @b2b/contracts only.',
  },
];

const SRC_EXT = /\.[cm]?tsx?$/;
const IGNORE_DIR = /(^|\/)(node_modules|dist|\.next|\.turbo|coverage)(\/|$)/;

function walk(dir) {
  const abs = join(ROOT, dir);
  let entries;
  try {
    entries = readdirSync(abs);
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const rel = `${dir}/${entry}`;
    if (IGNORE_DIR.test(rel)) continue;
    const st = statSync(join(ROOT, rel));
    if (st.isDirectory()) files.push(...walk(rel));
    else if (SRC_EXT.test(entry)) files.push(rel);
  }
  return files;
}

function importsOf(content) {
  const specs = [];
  const re =
    /(?:import[\s\S]*?from\s*|import\s*|require\s*\(\s*|export[\s\S]*?from\s*)['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(content)) !== null) specs.push(m[1]);
  return specs;
}

const violations = [];
for (const rule of RULES) {
  for (const file of walk(rule.dir)) {
    const content = readFileSync(join(ROOT, file), 'utf8');
    for (const spec of importsOf(content)) {
      const hit = rule.forbid.find((f) => spec === f || spec.startsWith(`${f}/`));
      if (hit) violations.push(`${file}: imports "${spec}" — ${rule.why}`);
    }
  }
}

if (violations.length > 0) {
  console.error('✖ Package boundary violations:');
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log('✓ Package boundaries respected.');
